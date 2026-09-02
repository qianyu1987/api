import { Database, one, type DbClient } from '../db/index.js'
import { calculateUsageMoney, estimatedRequestTokens, type TokenRates, type UsageTokens, formatMicros } from '../lib/money.js'

export type BillingMode = 'token' | 'fixed'

export type PriceSnapshot = TokenRates & {
  fixedSellMicros: bigint
  fixedCostMicros: bigint
  modelPattern: string
  billingMode?: BillingMode
  sourceId?: string | null
  routePattern?: string | null
  httpMethod?: string | null
  priceSource?: string | null
  priceEffectiveAt?: string | null
  fxRateCnyMicros?: bigint | null
}

export type PriceContext = {
  model: string
  requestPath: string
  requestMethod: string
  keyId?: string | null
  keyName?: string | null
}

export type StoredPriceSnapshot = {
  version: 1
  billingMode: BillingMode
  sourceId: string | null
  modelPattern: string
  routePattern: string | null
  httpMethod: string | null
  priceSource: string | null
  priceEffectiveAt: string | null
  fxRateCnyMicros: string | null
  rates: {
    inputSellMicrosPerMillion: string
    outputSellMicrosPerMillion: string
    cacheSellMicrosPerMillion: string
    inputCostMicrosPerMillion: string
    outputCostMicrosPerMillion: string
    cacheCostMicrosPerMillion: string
    fixedSellMicros: string
    fixedCostMicros: string
  }
  estimatedUsage: {
    input: string
    output: string
    cache: string
    reportedTotal: string
  }
  request: {
    model: string
    path: string
    method: string
    keyId: string | null
    keyName: string | null
  }
}

export type BalanceView = {
  walletMicros: bigint
  planMicros: bigint
  planQuotaMicros: bigint
  planExpiresAt: string | null
  planNextResetAt: string | null
  planLastResetAt: string | null
  planStatus: 'active' | 'expired' | 'none'
  isValid: boolean
}

export type SubscriptionResetResult = {
  applied: boolean
  userId: string
  resetKind: 'automatic' | 'manual' | 'migration'
  resetKey: string
  beforeRemainingMicros: bigint
  afterRemainingMicros: bigint
  quotaCapMicros: bigint
  resetAt: string | null
  nextResetAt: string | null
}

export type ReserveInput = PriceContext & {
  userId: string
  requestId: string
  payload: Record<string, unknown>
  price: PriceSnapshot
  billingMode?: BillingMode
}

export type ReservationResult = {
  requestId: string
  estimatedMicros: bigint
  planReservedMicros: bigint
  walletReservedMicros: bigint
  status: 'reserved' | 'settled' | 'released' | 'expired'
}

export type SettlementInput = {
  requestId: string
  userId: string
  model?: string
  usage?: UsageTokens | null
  price?: PriceSnapshot
  statusCode: number
  success: boolean
  latencyMs: number
  estimatedUsage?: boolean
  upstreamModel?: string
  channelId?: string | null
  channelName?: string | null
  keyId?: string | null
  keyName?: string | null
  requestPath?: string
  requestMethod?: string
  upstreamRequestId?: string | null
  errorCode?: string | null
  errorSummary?: string | null
  attemptCount?: number
}

export type SettlementResult = {
  chargeMicros: bigint
  costMicros: bigint
  planChargeMicros: bigint
  walletChargeMicros: bigint
}

export type SettlementAllocation = {
  settledChargeMicros: bigint
  planChargeMicros: bigint
  walletChargeMicros: bigint
  overageMicros: bigint
}

const zeroUsage: UsageTokens = { input: 0n, output: 0n, cache: 0n, reportedTotal: 0n }

function bigintValue(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  const text = String(value ?? 0)
  return /^-?\d+$/.test(text) ? BigInt(text) : 0n
}

function nonNegative(value: bigint): bigint { return value > 0n ? value : 0n }
function minimum(left: bigint, right: bigint): bigint { return left < right ? left : right }

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

/** Shanghai has no DST. Return the next Monday 09:00 local time after `from`. */
export function nextShanghaiReset(from: Date = new Date()): Date {
  const local = new Date(from.getTime() + SHANGHAI_OFFSET_MS)
  const day = local.getUTCDay()
  const daysSinceMonday = (day + 6) % 7
  let candidate = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - daysSinceMonday, 9, 0, 0, 0) - SHANGHAI_OFFSET_MS
  if (candidate <= from.getTime()) candidate += 7 * 24 * 60 * 60 * 1000
  return new Date(candidate)
}

function shanghaiDate(value: Date): string {
  const local = new Date(value.getTime() + SHANGHAI_OFFSET_MS)
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}`
}

/**
 * Settles no more than funds currently available to this request while
 * preserving the plan-before-wallet rule. The caller records any uncovered
 * amount as an immutable overage instead of releasing a successful relay call.
 */
export function allocateSettlementCharge(requested: bigint, planCapacity: bigint, walletCapacity: bigint): SettlementAllocation {
  const requestedCharge = nonNegative(requested)
  const availablePlan = nonNegative(planCapacity)
  const availableWallet = nonNegative(walletCapacity)
  const settledChargeMicros = minimum(requestedCharge, availablePlan + availableWallet)
  const planChargeMicros = minimum(settledChargeMicros, availablePlan)
  const walletChargeMicros = settledChargeMicros - planChargeMicros
  return {
    settledChargeMicros,
    planChargeMicros,
    walletChargeMicros,
    overageMicros: requestedCharge - settledChargeMicros,
  }
}

function modelMatches(pattern: string, model: string): boolean {
  return pattern === '*' || pattern === model || (pattern.endsWith('*') && model.startsWith(pattern.slice(0, -1)))
}

function routeMatches(pattern: string, path: string): boolean {
  if (pattern === '*') return true
  const normalizedPattern = requestPath(pattern)
  return normalizedPattern === path || (normalizedPattern.endsWith('*') && path.startsWith(normalizedPattern.slice(0, -1)))
}

function requestPath(value: unknown): string {
  const path = String(value || '/v1/chat/completions').split('?')[0] || '/v1/chat/completions'
  const prefixed = path.startsWith('/v1/') ? path : `/v1${path.startsWith('/') ? path : `/${path}`}`
  return prefixed.slice(0, 2048)
}

function requestMethod(value: unknown): string {
  const method = String(value || 'POST').toUpperCase()
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method) ? method : 'POST'
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) return null
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return text ? text.slice(0, maxLength) : null
}

function payloadValue(payload: Record<string, unknown>, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<unknown>((current, part) => (
    current && typeof current === 'object' && !Array.isArray(current) ? (current as Record<string, unknown>)[part] : undefined
  ), payload)
}

function selectorMatches(selectors: unknown, payload: Record<string, unknown>): boolean {
  if (!selectors || typeof selectors !== 'object' || Array.isArray(selectors)) return true
  return Object.entries(selectors as Record<string, unknown>).every(([path, expected]) => {
    const actual = payloadValue(payload, path)
    return Array.isArray(expected)
      ? expected.some((entry) => String(entry) === String(actual))
      : String(expected) === String(actual)
  })
}

function fixedUnits(row: any, payload: Record<string, unknown>): bigint {
  const mode = String(row.unit_mode || 'request')
  if (mode === 'request') return 1n
  const path = String(row.unit_path || '').trim()
  const value = Number(payloadValue(payload, path))
  if (!path || !Number.isFinite(value) || value <= 0) {
    throw Object.assign(new Error('固定接口缺少可计费规格，请补充请求参数或联系管理员配置价格'), { statusCode: 422 })
  }
  if (mode === 'count' && !Number.isInteger(value)) {
    throw Object.assign(new Error('固定接口计费数量必须为正整数'), { statusCode: 422 })
  }
  return BigInt(Math.max(1, Math.min(100_000, Math.ceil(value))))
}

function usageFromStored(value: any): UsageTokens {
  return {
    input: bigintValue(value?.input),
    output: bigintValue(value?.output),
    cache: bigintValue(value?.cache),
    reportedTotal: bigintValue(value?.reportedTotal),
  }
}

export function calculatePrice(price: PriceSnapshot, usage: UsageTokens, mode: BillingMode = price.billingMode || 'token'): { chargeMicros: bigint; costMicros: bigint } {
  if (mode === 'fixed') return { chargeMicros: price.fixedSellMicros, costMicros: price.fixedCostMicros }
  return calculateUsageMoney(usage, price)
}

export function estimatePrice(price: PriceSnapshot, payload: Record<string, unknown>, mode: BillingMode = price.billingMode || 'token'): { usage: UsageTokens; chargeMicros: bigint; costMicros: bigint } {
  const usage = estimatedRequestTokens(payload)
  return { usage, ...calculatePrice(price, usage, mode) }
}

export function serializePriceSnapshot(price: PriceSnapshot, estimatedUsage: UsageTokens, context: PriceContext, mode: BillingMode = price.billingMode || 'token'): StoredPriceSnapshot {
  return {
    version: 1,
    billingMode: mode,
    sourceId: price.sourceId || null,
    modelPattern: price.modelPattern,
    routePattern: price.routePattern || null,
    httpMethod: price.httpMethod || null,
    priceSource: price.priceSource || null,
    priceEffectiveAt: price.priceEffectiveAt || null,
    fxRateCnyMicros: price.fxRateCnyMicros?.toString() || null,
    rates: {
      inputSellMicrosPerMillion: price.inputSellMicrosPerMillion.toString(),
      outputSellMicrosPerMillion: price.outputSellMicrosPerMillion.toString(),
      cacheSellMicrosPerMillion: price.cacheSellMicrosPerMillion.toString(),
      inputCostMicrosPerMillion: price.inputCostMicrosPerMillion.toString(),
      outputCostMicrosPerMillion: price.outputCostMicrosPerMillion.toString(),
      cacheCostMicrosPerMillion: price.cacheCostMicrosPerMillion.toString(),
      fixedSellMicros: price.fixedSellMicros.toString(),
      fixedCostMicros: price.fixedCostMicros.toString(),
    },
    estimatedUsage: {
      input: estimatedUsage.input.toString(),
      output: estimatedUsage.output.toString(),
      cache: estimatedUsage.cache.toString(),
      reportedTotal: estimatedUsage.reportedTotal.toString(),
    },
    request: {
      model: String(context.model || '').slice(0, 256),
      path: requestPath(context.requestPath),
      method: requestMethod(context.requestMethod),
      keyId: context.keyId || null,
      keyName: cleanText(context.keyName, 128),
    },
  }
}

export function deserializePriceSnapshot(value: unknown, fallback?: PriceSnapshot): { price: PriceSnapshot; estimatedUsage: UsageTokens; context: StoredPriceSnapshot['request'] } {
  const snapshot = value && typeof value === 'object' ? value as any : {}
  const rates = snapshot.rates || snapshot
  const price: PriceSnapshot = {
    billingMode: snapshot.billingMode === 'fixed' || snapshot.billingMode === 'token' ? snapshot.billingMode : fallback?.billingMode || 'token',
    sourceId: cleanText(snapshot.sourceId, 128) || fallback?.sourceId || null,
    modelPattern: cleanText(snapshot.modelPattern, 256) || fallback?.modelPattern || '*',
    routePattern: cleanText(snapshot.routePattern, 2048) || fallback?.routePattern || null,
    httpMethod: cleanText(snapshot.httpMethod, 16) || fallback?.httpMethod || null,
    priceSource: cleanText(snapshot.priceSource, 512) || fallback?.priceSource || null,
    priceEffectiveAt: cleanText(snapshot.priceEffectiveAt, 64) || fallback?.priceEffectiveAt || null,
    fxRateCnyMicros: snapshot.fxRateCnyMicros === null || snapshot.fxRateCnyMicros === undefined
      ? fallback?.fxRateCnyMicros || null
      : bigintValue(snapshot.fxRateCnyMicros),
    inputSellMicrosPerMillion: bigintValue(rates.inputSellMicrosPerMillion ?? fallback?.inputSellMicrosPerMillion),
    outputSellMicrosPerMillion: bigintValue(rates.outputSellMicrosPerMillion ?? fallback?.outputSellMicrosPerMillion),
    cacheSellMicrosPerMillion: bigintValue(rates.cacheSellMicrosPerMillion ?? fallback?.cacheSellMicrosPerMillion),
    inputCostMicrosPerMillion: bigintValue(rates.inputCostMicrosPerMillion ?? fallback?.inputCostMicrosPerMillion),
    outputCostMicrosPerMillion: bigintValue(rates.outputCostMicrosPerMillion ?? fallback?.outputCostMicrosPerMillion),
    cacheCostMicrosPerMillion: bigintValue(rates.cacheCostMicrosPerMillion ?? fallback?.cacheCostMicrosPerMillion),
    fixedSellMicros: bigintValue(rates.fixedSellMicros ?? fallback?.fixedSellMicros),
    fixedCostMicros: bigintValue(rates.fixedCostMicros ?? fallback?.fixedCostMicros),
  }
  const storedRequest = snapshot.request || {}
  return {
    price,
    estimatedUsage: usageFromStored(snapshot.estimatedUsage),
    context: {
      model: String(storedRequest.model || ''),
      path: requestPath(storedRequest.path),
      method: requestMethod(storedRequest.method),
      keyId: cleanText(storedRequest.keyId, 128),
      keyName: cleanText(storedRequest.keyName, 128),
    },
  }
}

function reservationResult(row: any): ReservationResult {
  return {
    requestId: String(row.request_id),
    estimatedMicros: bigintValue(row.estimated_micros),
    planReservedMicros: bigintValue(row.plan_reserved_micros),
    walletReservedMicros: bigintValue(row.wallet_reserved_micros),
    status: row.status,
  }
}

export class BillingService {
  constructor(private readonly db: Database) {}

  async balance(userId: string): Promise<BalanceView> {
    const row = await this.db.one<any>(
      `SELECT COALESCE(w.balance_micros, 0) AS wallet,
              COALESCE(w.reserved_micros, 0) AS wallet_reserved,
              COALESCE(s.remaining_micros, 0) AS plan,
              COALESCE(s.reserved_micros, 0) AS plan_reserved,
              COALESCE(s.reset_quota_micros, 0) AS plan_quota,
              s.status AS plan_status, s.expires_at, s.next_reset_at, s.last_reset_at
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       LEFT JOIN subscriptions s ON s.user_id = u.id
       WHERE u.id = $1`, [userId])
    const expires = row?.expires_at ? new Date(row.expires_at) : null
    const activePlan = row?.plan_status === 'active' && expires && expires.getTime() > Date.now()
    const plan = activePlan ? nonNegative(bigintValue(row.plan) - bigintValue(row.plan_reserved)) : 0n
    const wallet = nonNegative(bigintValue(row?.wallet) - bigintValue(row?.wallet_reserved))
    return {
      walletMicros: wallet,
      planMicros: plan,
      planQuotaMicros: activePlan ? bigintValue(row.plan_quota) : 0n,
      planExpiresAt: activePlan ? expires.toISOString() : null,
      planNextResetAt: activePlan && row.next_reset_at ? new Date(row.next_reset_at).toISOString() : null,
      planLastResetAt: activePlan && row.last_reset_at ? new Date(row.last_reset_at).toISOString() : null,
      planStatus: activePlan ? 'active' : (row?.plan_status === 'expired' ? 'expired' : 'none'),
      isValid: wallet > 0n || plan > 0n,
    }
  }

  /** Reset one active subscription while retaining all in-flight reservations. */
  async resetSubscription(userId: string, actorUserId: string | null = null): Promise<SubscriptionResetResult> {
    return this.db.tx(async (client) => {
      const row = await one<any>(client, 'SELECT * FROM subscriptions WHERE user_id = $1 FOR UPDATE', [userId])
      if (!row) throw Object.assign(new Error('用户没有套餐'), { statusCode: 404 })
      const now = new Date()
      const expires = row.expires_at ? new Date(row.expires_at) : null
      if (row.status !== 'active' || !expires || expires.getTime() <= now.getTime()) {
        throw Object.assign(new Error('套餐已过期，无法重置'), { statusCode: 409 })
      }
      const cap = bigintValue(row.reset_quota_micros)
      if (cap <= 0n) throw Object.assign(new Error('套餐未配置周期额度'), { statusCode: 409 })
      const scheduled = row.next_reset_at ? new Date(row.next_reset_at) : null
      // Manual and automatic actions share the scheduled cycle key. This makes
      // an admin click before the worker runs idempotent with that worker run.
      const resetKey = scheduled && Number.isFinite(scheduled.getTime())
        ? `cycle:${scheduled.toISOString()}`
        : `cycle:${shanghaiDate(now)}`
      return this.applyReset(client, row, cap, resetKey, 'manual', actorUserId, now, false)
    })
  }

  /** Process due weekly resets. Each subscription is locked and reset once per scheduled cycle. */
  async resetDueSubscriptions(limit = 500): Promise<number> {
    const rows = await this.db.query<any>(
      `SELECT user_id FROM subscriptions
       WHERE status = 'active' AND expires_at > now()
         AND next_reset_at IS NOT NULL AND next_reset_at <= now()
       ORDER BY next_reset_at ASC LIMIT $1`,
      [Math.min(5000, Math.max(1, Math.floor(limit)))],
    )
    let applied = 0
    for (const item of rows) {
      const didApply = await this.db.tx(async (client) => {
        const row = await one<any>(client, 'SELECT * FROM subscriptions WHERE user_id = $1 FOR UPDATE', [String(item.user_id)])
        if (!row || row.status !== 'active' || !row.expires_at || new Date(row.expires_at).getTime() <= Date.now() || !row.next_reset_at || new Date(row.next_reset_at).getTime() > Date.now()) return false
        if (row.last_reset_at && new Date(row.last_reset_at).getTime() >= new Date(row.next_reset_at).getTime()) {
          await client.query('UPDATE subscriptions SET next_reset_at = $2, version = version + 1, updated_at = now() WHERE id = $1', [row.id, nextShanghaiReset(new Date())])
          return false
        }
        const scheduled = new Date(row.next_reset_at)
        const cap = bigintValue(row.reset_quota_micros)
        if (cap <= 0n) return false
        // A delayed worker only needs one catch-up reset. The next event is the
        // first Monday 09:00 after now, avoiding a burst of historical credits.
        await this.applyReset(client, row, cap, `automatic:${scheduled.toISOString()}`, 'automatic', null, new Date(), true)
        return true
      })
      if (didApply) applied += 1
    }
    return applied
  }

  /** Upgrade legacy ¥59.60 subscriptions once, without extending expiry. */
  async migrateLegacySubscriptions(limit = 500): Promise<number> {
    const rows = await this.db.query<any>(
      `SELECT s.user_id FROM subscriptions s
       JOIN plans p ON p.id = COALESCE(s.current_plan_id, s.plan_id)
       WHERE s.status = 'active' AND s.expires_at > now()
         AND lower(p.code) = lower('monthly-149')
         AND s.reset_quota_micros < 149000000
       ORDER BY s.expires_at ASC LIMIT $1`,
      [Math.min(5000, Math.max(1, Math.floor(limit)))],
    )
    let migrated = 0
    for (const item of rows) {
      const didApply = await this.db.tx(async (client) => {
        const row = await one<any>(client, 'SELECT * FROM subscriptions WHERE user_id = $1 FOR UPDATE', [String(item.user_id)])
        if (!row || row.status !== 'active' || !row.expires_at || new Date(row.expires_at).getTime() <= Date.now() || bigintValue(row.reset_quota_micros) >= 149000000n) return false
        await client.query(`UPDATE subscriptions SET reset_quota_micros = 149000000, reset_timezone = 'Asia/Shanghai', next_reset_at = $2, version = version + 1, updated_at = now() WHERE id = $1`, [row.id, nextShanghaiReset(new Date())])
        const refreshed = { ...row, reset_quota_micros: '149000000', next_reset_at: nextShanghaiReset(new Date()) }
        await this.applyReset(client, refreshed, 149000000n, 'migration:monthly-149-v1', 'migration', null, new Date(), false)
        return true
      })
      if (didApply) migrated += 1
    }
    return migrated
  }

  private async applyReset(client: DbClient, row: any, cap: bigint, resetKey: string, resetKind: 'automatic' | 'manual' | 'migration', actorUserId: string | null, resetAt: Date, automatic: boolean): Promise<SubscriptionResetResult> {
    const existingEvent = await one<any>(client, 'SELECT before_remaining_micros, after_remaining_micros, quota_cap_micros, created_at FROM subscription_reset_events WHERE subscription_id = $1 AND reset_key = $2', [row.id, resetKey])
    const next = automatic ? nextShanghaiReset(new Date()) : (row.next_reset_at ? new Date(row.next_reset_at) : null)
    if (existingEvent) {
      if (automatic && next) {
        await client.query(
          `UPDATE subscriptions
           SET last_reset_at = COALESCE(last_reset_at, $2), next_reset_at = $3,
               version = version + 1, updated_at = now()
           WHERE id = $1`,
          [row.id, existingEvent.created_at || resetAt, next],
        )
      }
      return {
        applied: false,
        userId: String(row.user_id),
        resetKind,
        resetKey,
        beforeRemainingMicros: bigintValue(existingEvent.before_remaining_micros),
        afterRemainingMicros: bigintValue(existingEvent.after_remaining_micros),
        quotaCapMicros: bigintValue(existingEvent.quota_cap_micros),
        resetAt: existingEvent.created_at ? new Date(existingEvent.created_at).toISOString() : null,
        nextResetAt: next?.toISOString() || null,
      }
    }
    const before = bigintValue(row.remaining_micros)
    const reserved = bigintValue(row.reserved_micros)
    const after = cap > reserved ? cap : reserved
    const updated = await client.query(
      `UPDATE subscriptions
       SET remaining_micros = $2, reset_quota_micros = $3,
           last_reset_at = $4, next_reset_at = $5,
           reset_version = reset_version + 1, version = version + 1, updated_at = now()
       WHERE id = $1 AND remaining_micros >= reserved_micros`,
      [row.id, after.toString(), cap.toString(), resetAt, automatic ? next : row.next_reset_at],
    )
    if (updated.rowCount !== 1) throw new Error('套餐额度重置失败')
    if (after !== before) {
      await client.query(`INSERT INTO subscription_ledger(subscription_id,user_id,kind,remaining_delta_micros,metadata) VALUES($1,$2,'quota_reset',$3,$4)`, [row.id, row.user_id, (after - before).toString(), JSON.stringify({ resetKey, resetKind, cap: cap.toString() })])
    }
    await client.query(`INSERT INTO subscription_reset_events(subscription_id,user_id,reset_key,reset_kind,actor_user_id,before_remaining_micros,after_remaining_micros,quota_cap_micros,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [row.id, row.user_id, resetKey, resetKind, actorUserId, before.toString(), after.toString(), cap.toString(), resetAt])
    return { applied: true, userId: String(row.user_id), resetKind, resetKey, beforeRemainingMicros: before, afterRemainingMicros: after, quotaCapMicros: cap, resetAt: resetAt.toISOString(), nextResetAt: automatic ? next?.toISOString() || null : row.next_reset_at ? new Date(row.next_reset_at).toISOString() : null }
  }

  async priceFor(model: string): Promise<PriceSnapshot | null> {
    const rows = await this.db.query<any>(
      `SELECT * FROM model_prices
       WHERE active = true
       ORDER BY CASE WHEN model_pattern = $1 THEN 0 ELSE 1 END, length(model_pattern) DESC, id`,
      [model],
    )
    const row = rows.find((candidate) => modelMatches(String(candidate.model_pattern), model))
    if (!row) return null
    return {
      billingMode: 'token', sourceId: String(row.id), modelPattern: row.model_pattern,
      inputSellMicrosPerMillion: bigintValue(row.input_sell_micros_per_million ?? row.input_sell_micros),
      outputSellMicrosPerMillion: bigintValue(row.output_sell_micros_per_million ?? row.output_sell_micros),
      cacheSellMicrosPerMillion: bigintValue(row.cache_sell_micros_per_million ?? row.cache_sell_micros),
      inputCostMicrosPerMillion: bigintValue(row.input_cost_micros_per_million ?? row.input_cost_micros),
      outputCostMicrosPerMillion: bigintValue(row.output_cost_micros_per_million ?? row.output_cost_micros),
      cacheCostMicrosPerMillion: bigintValue(row.cache_cost_micros_per_million ?? row.cache_cost_micros),
      fixedSellMicros: bigintValue(row.fixed_sell_micros), fixedCostMicros: bigintValue(row.fixed_cost_micros),
      priceSource: row.price_source || null,
      priceEffectiveAt: row.price_effective_at ? new Date(row.price_effective_at).toISOString() : null,
      fxRateCnyMicros: row.fx_rate_cny_micros == null ? null : bigintValue(row.fx_rate_cny_micros),
    }
  }

  async fixedPriceFor(method: string, path: string, model = '', payload: Record<string, unknown> = {}): Promise<PriceSnapshot | null> {
    const normalizedMethod = requestMethod(method)
    const normalizedPath = requestPath(path)
    const rows = await this.db.query<any>(
      `SELECT * FROM fixed_route_prices
       WHERE enabled = true AND http_method IN ('ANY', $1)
       ORDER BY CASE WHEN http_method = $1 THEN 0 ELSE 1 END,
                CASE WHEN requested_model = $2 THEN 0 WHEN requested_model IS NOT NULL THEN 1 ELSE 2 END,
                match_priority ASC, length(path_pattern) DESC,
                length(COALESCE(requested_model, '')) DESC, id`,
      [normalizedMethod, model],
    )
    const routeCandidates = rows.filter((candidate) => {
      const routeOk = routeMatches(String(candidate.path_pattern), normalizedPath)
      const configuredModel = candidate.requested_model == null ? null : String(candidate.requested_model)
      return routeOk && (!configuredModel || modelMatches(configuredModel, model))
    })
    const row = routeCandidates.find((candidate) => selectorMatches(candidate.selectors, payload))
    if (!row && routeCandidates.length) {
      throw Object.assign(new Error('该接口规格尚未配置价格，已拒绝转发以避免免费或亏损调用'), { statusCode: 422 })
    }
    if (!row) return null
    const units = fixedUnits(row, payload)
    return {
      billingMode: 'fixed', sourceId: String(row.id), modelPattern: row.requested_model || model || '*',
      routePattern: row.path_pattern, httpMethod: row.http_method,
      inputSellMicrosPerMillion: 0n, outputSellMicrosPerMillion: 0n, cacheSellMicrosPerMillion: 0n,
      inputCostMicrosPerMillion: 0n, outputCostMicrosPerMillion: 0n, cacheCostMicrosPerMillion: 0n,
      fixedSellMicros: bigintValue(row.sell_micros) * units, fixedCostMicros: bigintValue(row.cost_micros) * units,
    }
  }

  async priceForRequest(method: string, path: string, model: string, payload: Record<string, unknown> = {}): Promise<PriceSnapshot | null> {
    const fixed = await this.fixedPriceFor(method, path, model, payload)
    if (fixed) return fixed
    return model ? this.priceFor(model) : null
  }

  async reserve(input: ReserveInput): Promise<ReservationResult>
  async reserve(userId: string, requestId: string, model: string, payload: Record<string, unknown>, price: PriceSnapshot, fixed?: boolean): Promise<ReservationResult>
  async reserve(first: ReserveInput | string, requestId?: string, model?: string, payload?: Record<string, unknown>, price?: PriceSnapshot, fixed = false): Promise<ReservationResult> {
    const input: ReserveInput = typeof first === 'string'
      ? {
          userId: first, requestId: String(requestId), model: String(model || ''), payload: payload || {},
          price: { ...(price as PriceSnapshot), billingMode: fixed ? 'fixed' : price?.billingMode || 'token' },
          billingMode: fixed ? 'fixed' : price?.billingMode || 'token', requestPath: '/v1/chat/completions', requestMethod: 'POST',
        }
      : first
    const mode = input.billingMode || input.price.billingMode || 'token'
    const estimate = estimatePrice(input.price, input.payload, mode)
    if (estimate.chargeMicros <= 0n) throw new Error('售价配置必须大于 0，禁止无价格调用')
    const snapshot = serializePriceSnapshot(input.price, estimate.usage, input, mode)

    return this.db.tx(async (client) => {
      const user = await one<any>(client, 'SELECT id FROM users WHERE id = $1 FOR UPDATE', [input.userId])
      if (!user) throw new Error('用户不存在')
      const existing = await one<any>(client, 'SELECT * FROM billing_reservations WHERE request_id = $1 FOR UPDATE', [input.requestId])
      if (existing) {
        if (String(existing.user_id) !== input.userId) throw new Error('请求编号已被占用')
        return reservationResult(existing)
      }
      await client.query('INSERT INTO wallets(user_id) VALUES ($1) ON CONFLICT(user_id) DO NOTHING', [input.userId])
      const subscription = await one<any>(client, 'SELECT id, remaining_micros, reserved_micros, status, expires_at FROM subscriptions WHERE user_id = $1 FOR UPDATE', [input.userId])
      const wallet = await one<any>(client, 'SELECT balance_micros, reserved_micros FROM wallets WHERE user_id = $1 FOR UPDATE', [input.userId])

      const planActive = subscription?.status === 'active' && subscription.expires_at && new Date(subscription.expires_at).getTime() > Date.now()
      const planAvailable = planActive ? nonNegative(bigintValue(subscription.remaining_micros) - bigintValue(subscription.reserved_micros)) : 0n
      const walletAvailable = nonNegative(bigintValue(wallet?.balance_micros) - bigintValue(wallet?.reserved_micros))
      const planReserved = minimum(estimate.chargeMicros, planAvailable)
      const walletReserved = estimate.chargeMicros - planReserved
      if (walletAvailable < walletReserved) throw new Error('余额不足，请先充值')

      const ledgerMetadata = JSON.stringify({ model: snapshot.request.model, path: snapshot.request.path, billingMode: mode })
      if (planReserved > 0n) {
        await client.query('UPDATE subscriptions SET reserved_micros = reserved_micros + $1, version = version + 1, updated_at = now() WHERE user_id = $2', [planReserved.toString(), input.userId])
        await client.query(
          `INSERT INTO subscription_ledger(subscription_id, user_id, kind, remaining_delta_micros, reserved_delta_micros, request_id, metadata)
           VALUES ($1,$2,'usage_reserve',0,$3,$4,$5)`,
          [subscription.id, input.userId, planReserved.toString(), input.requestId, ledgerMetadata],
        )
      }
      if (walletReserved > 0n) {
        await client.query('UPDATE wallets SET reserved_micros = reserved_micros + $1, version = version + 1, updated_at = now() WHERE user_id = $2', [walletReserved.toString(), input.userId])
        await client.query(
          `INSERT INTO wallet_ledger(user_id, kind, amount_micros, balance_after_micros, reserved_delta_micros, request_id, metadata)
           VALUES ($1,'usage_reserve',0,$2,$3,$4,$5)`,
          [input.userId, bigintValue(wallet?.balance_micros).toString(), walletReserved.toString(), input.requestId, ledgerMetadata],
        )
      }
      const row = await one<any>(client,
        `INSERT INTO billing_reservations(
           request_id, user_id, api_key_id, estimated_micros, estimated_charge_micros,
           plan_reserved_micros, wallet_reserved_micros, pricing_snapshot
         ) VALUES ($1,$2,$3,$4,$4,$5,$6,$7)
         RETURNING *`,
        [input.requestId, input.userId, input.keyId || null, estimate.chargeMicros.toString(), planReserved.toString(), walletReserved.toString(), JSON.stringify(snapshot)],
      )
      if (!row) throw new Error('创建账务预扣失败')
      return reservationResult(row)
    })
  }

  async settle(input: SettlementInput): Promise<SettlementResult> {
    return this.db.tx(async (client) => {
      const user = await one<any>(client, 'SELECT id FROM users WHERE id = $1 FOR UPDATE', [input.userId])
      if (!user) throw new Error('用户不存在')
      const reservation = await one<any>(client, 'SELECT * FROM billing_reservations WHERE request_id = $1 FOR UPDATE', [input.requestId])
      if (!reservation) throw new Error('账务预扣不存在')
      if (String(reservation.user_id) !== input.userId) throw new Error('账务预扣用户不匹配')
      if (reservation.status !== 'reserved') return this.existingSettlement(client, input.requestId)

      const stored = deserializePriceSnapshot(reservation.pricing_snapshot, input.price)
      const mode = stored.price.billingMode || 'token'
      const reportedUsage = input.usage
      // A total-only usage object cannot be split across the configured input,
      // output and cache rates. Treat it as missing component usage so the
      // request falls back to the conservative start-of-request estimate
      // instead of silently becoming a zero-cost call.
      const hasReportedUsage = Boolean(reportedUsage && (reportedUsage.input > 0n || reportedUsage.output > 0n || reportedUsage.cache > 0n))
      const useEstimatedUsage = Boolean(input.success && mode === 'token' && (input.estimatedUsage || !hasReportedUsage))
      const usage = useEstimatedUsage ? stored.estimatedUsage : input.usage || zeroUsage
      const calculated = useEstimatedUsage
        ? { chargeMicros: bigintValue(reservation.estimated_micros), costMicros: calculatePrice(stored.price, stored.estimatedUsage, 'token').costMicros }
        : calculatePrice(stored.price, usage, mode)
      const calculatedCharge = input.success ? calculated.chargeMicros : 0n
      const cost = input.success ? calculated.costMicros : 0n

      await client.query('INSERT INTO wallets(user_id) VALUES ($1) ON CONFLICT(user_id) DO NOTHING', [input.userId])
      const subscription = await one<any>(client, 'SELECT id, remaining_micros, reserved_micros, status, expires_at FROM subscriptions WHERE user_id = $1 FOR UPDATE', [input.userId])
      const wallet = await one<any>(client, 'SELECT balance_micros, reserved_micros FROM wallets WHERE user_id = $1 FOR UPDATE', [input.userId])
      const planReserved = bigintValue(reservation.plan_reserved_micros)
      const walletReserved = bigintValue(reservation.wallet_reserved_micros)

      if (!input.success) {
        await this.releaseBalances(client, reservation, subscription, wallet, 'usage_release')
        await client.query(
          `UPDATE billing_reservations
           SET status = 'released', actual_micros = 0, plan_settled_micros = 0,
               wallet_settled_micros = 0, released_at = now(), settled_at = NULL
           WHERE request_id = $1`,
          [input.requestId],
        )
        await this.insertUsage(client, input, reservation, stored, usage, false, 0n, 0n, 0n, 0n, 0n)
        return { chargeMicros: 0n, costMicros: 0n, planChargeMicros: 0n, walletChargeMicros: 0n }
      }

      if (planReserved > 0n && !subscription) throw new Error('套餐预扣状态不一致')
      if (walletReserved > bigintValue(wallet?.reserved_micros)) throw new Error('钱包预扣状态不一致')
      if (planReserved > bigintValue(subscription?.reserved_micros)) throw new Error('套餐预扣状态不一致')

      const planStillActive = subscription?.status === 'active' && subscription.expires_at && new Date(subscription.expires_at).getTime() > Date.now()
      const freePlan = planStillActive ? nonNegative(bigintValue(subscription.remaining_micros) - bigintValue(subscription.reserved_micros)) : 0n
      const planCapacity = minimum(bigintValue(subscription?.remaining_micros), planReserved + freePlan)
      const requestedCharge = calculatedCharge
      const freeWallet = nonNegative(bigintValue(wallet?.balance_micros) - bigintValue(wallet?.reserved_micros))
      const walletCapacity = walletReserved + freeWallet
      // Reservations normally cover the exact provider usage: input is bounded
      // from the request bytes and output from the declared max-token field.
      // A non-conforming upstream can still report more than that bound. Never
      // release a successful call for free in this defensive path; settle every
      // currently collectable micro and retain the uncovered amount in the
      // immutable usage metadata for operator review.
      const allocation = allocateSettlementCharge(requestedCharge, planCapacity, walletCapacity)
      const settledCharge = allocation.settledChargeMicros
      const planCharge = allocation.planChargeMicros
      const walletCharge = allocation.walletChargeMicros
      if (walletCharge > walletCapacity || walletCharge > bigintValue(wallet?.balance_micros)) throw new Error('结算后余额不足')

      const ledgerMetadata = JSON.stringify({ model: input.model || stored.context.model, billingMode: mode })
      if (planReserved > 0n || planCharge > 0n) {
        const updated = await client.query(
          `UPDATE subscriptions
           SET remaining_micros = remaining_micros - $1,
               reserved_micros = reserved_micros - $2,
               version = version + 1, updated_at = now()
           WHERE user_id = $3 AND remaining_micros >= $1 AND reserved_micros >= $2`,
          [planCharge.toString(), planReserved.toString(), input.userId],
        )
        if (updated.rowCount !== 1) throw new Error('套餐结算状态不一致')
        await client.query(
          `INSERT INTO subscription_ledger(subscription_id, user_id, kind, remaining_delta_micros, reserved_delta_micros, request_id, metadata)
           VALUES ($1,$2,'usage_settle',$3,$4,$5,$6)`,
          [subscription.id, input.userId, (-planCharge).toString(), (-planReserved).toString(), input.requestId, ledgerMetadata],
        )
      }
      if (walletReserved > 0n || walletCharge > 0n) {
        const nextWallet = bigintValue(wallet.balance_micros) - walletCharge
        const updated = await client.query(
          `UPDATE wallets
           SET balance_micros = balance_micros - $1,
               reserved_micros = reserved_micros - $2,
               version = version + 1, updated_at = now()
           WHERE user_id = $3 AND balance_micros >= $1 AND reserved_micros >= $2`,
          [walletCharge.toString(), walletReserved.toString(), input.userId],
        )
        if (updated.rowCount !== 1) throw new Error('钱包结算状态不一致')
        await client.query(
          `INSERT INTO wallet_ledger(user_id, kind, amount_micros, balance_after_micros, reserved_delta_micros, request_id, metadata)
           VALUES ($1,'usage_settle',$2,$3,$4,$5,$6)`,
          [input.userId, (-walletCharge).toString(), nextWallet.toString(), (-walletReserved).toString(), input.requestId, ledgerMetadata],
        )
      }
      await client.query(
        `UPDATE billing_reservations
         SET status = 'settled', actual_micros = $1, plan_settled_micros = $2,
             wallet_settled_micros = $3, settled_at = now(), released_at = NULL
         WHERE request_id = $4`,
        [settledCharge.toString(), planCharge.toString(), walletCharge.toString(), input.requestId],
      )
      await this.insertUsage(client, input, reservation, stored, usage, useEstimatedUsage, planCharge, walletCharge, settledCharge, cost, requestedCharge)
      return { chargeMicros: settledCharge, costMicros: cost, planChargeMicros: planCharge, walletChargeMicros: walletCharge }
    })
  }

  async release(requestId: string, status: 'released' | 'expired' = 'released'): Promise<boolean> {
    return this.db.tx(async (client) => {
      const owner = await one<any>(client, 'SELECT user_id FROM billing_reservations WHERE request_id = $1', [requestId])
      if (!owner) return false
      await one<any>(client, 'SELECT id FROM users WHERE id = $1 FOR UPDATE', [owner.user_id])
      const reservation = await one<any>(client, 'SELECT * FROM billing_reservations WHERE request_id = $1 FOR UPDATE', [requestId])
      if (!reservation || reservation.status !== 'reserved') return false
      const subscription = await one<any>(client, 'SELECT id, remaining_micros, reserved_micros FROM subscriptions WHERE user_id = $1 FOR UPDATE', [reservation.user_id])
      const wallet = await one<any>(client, 'SELECT balance_micros, reserved_micros FROM wallets WHERE user_id = $1 FOR UPDATE', [reservation.user_id])
      await this.releaseBalances(client, reservation, subscription, wallet, 'usage_release')
      await client.query(
        `UPDATE billing_reservations
         SET status = $1, actual_micros = 0, plan_settled_micros = 0,
             wallet_settled_micros = 0, released_at = now(), settled_at = NULL
         WHERE request_id = $2`,
        [status, requestId],
      )
      return true
    })
  }

  async releaseExpiredReservations(limit = 500): Promise<number> {
    const rows = await this.db.query<any>(
      `SELECT request_id FROM billing_reservations
       WHERE status = 'reserved' AND expires_at <= now()
       ORDER BY expires_at ASC LIMIT $1`,
      [Math.min(5000, Math.max(1, Math.floor(limit)))],
    )
    let released = 0
    for (const row of rows) if (await this.release(String(row.request_id), 'expired')) released += 1
    return released
  }

  private async existingSettlement(client: DbClient, requestId: string): Promise<SettlementResult> {
    const row = await one<any>(client, 'SELECT charge_micros, cost_micros, plan_charge_micros, wallet_charge_micros FROM usage_logs WHERE request_id = $1', [requestId])
    return {
      chargeMicros: bigintValue(row?.charge_micros), costMicros: bigintValue(row?.cost_micros),
      planChargeMicros: bigintValue(row?.plan_charge_micros), walletChargeMicros: bigintValue(row?.wallet_charge_micros),
    }
  }

  private async releaseBalances(client: DbClient, reservation: any, subscription: any, wallet: any, kind: 'usage_release'): Promise<void> {
    const planReserved = bigintValue(reservation.plan_reserved_micros)
    const walletReserved = bigintValue(reservation.wallet_reserved_micros)
    const metadata = JSON.stringify({ reservationStatus: reservation.status })
    if (planReserved > 0n) {
      if (!subscription || bigintValue(subscription.reserved_micros) < planReserved) throw new Error('套餐预扣状态不一致')
      const updated = await client.query(
        `UPDATE subscriptions SET reserved_micros = reserved_micros - $1, version = version + 1, updated_at = now()
         WHERE user_id = $2 AND reserved_micros >= $1`,
        [planReserved.toString(), reservation.user_id],
      )
      if (updated.rowCount !== 1) throw new Error('套餐预扣释放失败')
      await client.query(
        `INSERT INTO subscription_ledger(subscription_id, user_id, kind, remaining_delta_micros, reserved_delta_micros, request_id, metadata)
         VALUES ($1,$2,$3,0,$4,$5,$6)`,
        [subscription.id, reservation.user_id, kind, (-planReserved).toString(), reservation.request_id, metadata],
      )
    }
    if (walletReserved > 0n) {
      if (!wallet || bigintValue(wallet.reserved_micros) < walletReserved) throw new Error('钱包预扣状态不一致')
      const updated = await client.query(
        `UPDATE wallets SET reserved_micros = reserved_micros - $1, version = version + 1, updated_at = now()
         WHERE user_id = $2 AND reserved_micros >= $1`,
        [walletReserved.toString(), reservation.user_id],
      )
      if (updated.rowCount !== 1) throw new Error('钱包预扣释放失败')
      await client.query(
        `INSERT INTO wallet_ledger(user_id, kind, amount_micros, balance_after_micros, reserved_delta_micros, request_id, metadata)
         VALUES ($1,$2,0,$3,$4,$5,$6)`,
        [reservation.user_id, kind, bigintValue(wallet.balance_micros).toString(), (-walletReserved).toString(), reservation.request_id, metadata],
      )
    }
  }

  private async insertUsage(
    client: DbClient,
    input: SettlementInput,
    reservation: any,
    stored: ReturnType<typeof deserializePriceSnapshot>,
    usage: UsageTokens,
    estimatedUsage: boolean,
    planCharge: bigint,
    walletCharge: bigint,
    charge: bigint,
    cost: bigint,
    calculatedCharge: bigint,
  ): Promise<void> {
    const keyId = input.keyId || reservation.api_key_id || stored.context.keyId || null
    const path = requestPath(input.requestPath || stored.context.path)
    const method = requestMethod(input.requestMethod || stored.context.method)
    const statusCode = Number.isInteger(input.statusCode) && input.statusCode >= 100 && input.statusCode <= 599 ? input.statusCode : null
    const latency = Math.max(0, Math.floor(Number(input.latencyMs) || 0))
    const settlementOverage = nonNegative(calculatedCharge - charge)
    const errorCode = settlementOverage > 0n ? 'settlement_capped' : input.errorCode
    const errorSummary = settlementOverage > 0n
      ? '实际用量超出预扣可用额度，已按可用额度结算'
      : input.errorSummary
    await client.query(
      `INSERT INTO usage_logs(
         request_id, user_id, key_id, api_key_id, api_key_name_snapshot,
         requested_model, upstream_model, final_channel_id, final_channel_name_snapshot,
         request_path, request_method, billing_mode, pricing_snapshot,
         input_tokens, output_tokens, cache_tokens, reported_total_tokens,
         plan_charge_micros, wallet_charge_micros, charge_micros, cost_micros, profit_micros,
         status_code, status, success, latency_ms, duration_ms,
         estimated_usage, is_estimated_usage, error_code, error_summary,
         upstream_request_id, started_at, finished_at, metadata
       ) VALUES (
         $1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
         $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$25,
         $26,$26,$27,$28,$29,$30,now(),$31
       )`,
      [
        input.requestId, input.userId, keyId, cleanText(input.keyName || stored.context.keyName, 128),
        String(input.model ?? stored.context.model).slice(0, 256), String(input.upstreamModel || '').slice(0, 256),
        input.channelId || null, cleanText(input.channelName, 128), path, method, stored.price.billingMode || 'token',
        JSON.stringify(reservation.pricing_snapshot || {}), usage.input.toString(), usage.output.toString(), usage.cache.toString(), usage.reportedTotal.toString(),
        planCharge.toString(), walletCharge.toString(), charge.toString(), cost.toString(), (charge - cost).toString(),
        statusCode, input.success ? 'success' : 'failed', input.success, latency, estimatedUsage,
        cleanText(errorCode, 120), cleanText(errorSummary, 500), cleanText(input.upstreamRequestId, 256),
        reservation.created_at || new Date(), JSON.stringify({
          attemptCount: Math.max(0, Math.floor(Number(input.attemptCount) || 0)),
          calculatedChargeMicros: calculatedCharge.toString(),
          settlementOverageMicros: settlementOverage.toString(),
        }),
      ],
    )
  }

  static formatBalance(view: BalanceView): Record<string, unknown> {
    return {
      wallet: formatMicros(view.walletMicros),
      planRemaining: formatMicros(view.planMicros),
      planQuota: formatMicros(view.planQuotaMicros),
      planExpiresAt: view.planExpiresAt,
      planNextResetAt: view.planNextResetAt,
      planLastResetAt: view.planLastResetAt,
      planStatus: view.planStatus,
      unit: 'CNY',
      isValid: view.isValid,
    }
  }
}
