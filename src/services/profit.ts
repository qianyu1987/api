import { Database, type DbClient } from '../db/index.js'
import { buildMarginPriceRows, requiredWalletSell, worstWalletTopupMultiplier } from './pricing.js'

const SHANGHAI_TIMEZONE = 'Asia/Shanghai'
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const NIGHT_DISCOUNT_END_HOUR = 4

export type ShanghaiNightDiscountWindow = {
  timezone: typeof SHANGHAI_TIMEZONE
  startHour: 0
  endHour: typeof NIGHT_DISCOUNT_END_HOUR
  active: boolean
  startsAt: string
  endsAt: string
  nextTransitionAt: string
}

/** Daily 00:00 <= local time < 04:00 window in fixed Asia/Shanghai time. */
export function shanghaiNightDiscountWindow(now: Date | string | number = new Date()): ShanghaiNightDiscountWindow {
  const instant = now instanceof Date ? new Date(now.getTime()) : new Date(now)
  if (Number.isNaN(instant.getTime())) throw new RangeError('深夜折扣时间无效')
  const shanghai = new Date(instant.getTime() + SHANGHAI_OFFSET_MS)
  const localMidnight = Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate())
  const active = shanghai.getUTCHours() < NIGHT_DISCOUNT_END_HOUR
  const windowStartLocal = active ? localMidnight : localMidnight + 24 * 60 * 60 * 1000
  const startsAt = new Date(windowStartLocal - SHANGHAI_OFFSET_MS)
  const endsAt = new Date(startsAt.getTime() + NIGHT_DISCOUNT_END_HOUR * 60 * 60 * 1000)
  return {
    timezone: SHANGHAI_TIMEZONE,
    startHour: 0,
    endHour: NIGHT_DISCOUNT_END_HOUR,
    active,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    nextTransitionAt: (active ? endsAt : startsAt).toISOString(),
  }
}

export function isShanghaiNightDiscountActive(now: Date | string | number = new Date()): boolean {
  return shanghaiNightDiscountWindow(now).active
}

export function effectiveDiscountBps(personal: number, global: number, nightCampaign = 0): number {
  return Math.max(personal, global, nightCampaign)
}

export type ProfitRules = {
  minimumMarginBps: number
  paymentFeeRateBps: number
  affiliateRateBps: number
  globalDiscountBps: number
  nightDiscountEnabled: boolean
  nightDiscountBps: number
  walletTopupMultiplierBps: number
}

function bps(value: unknown, fallback: number, max = 10000): number {
  const number = Number(value ?? fallback)
  if (!Number.isInteger(number) || number < 0 || number > max) throw Object.assign(new Error('比例必须为有效的整数基点'), { statusCode: 400 })
  return number
}

function booleanSetting(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback
  if (value === true || value === 'true' || value === 1 || value === '1') return true
  if (value === false || value === 'false' || value === 0 || value === '0') return false
  throw Object.assign(new Error('开关必须为布尔值'), { statusCode: 400 })
}

export function profitRules(settings: Record<string, string>, walletTopupMultiplierBps = 50000): ProfitRules {
  return {
    minimumMarginBps: bps(settings.profit_min_margin_bps, 5000, 9999),
    paymentFeeRateBps: bps(settings.payment_fee_rate_bps, 0),
    affiliateRateBps: settings.affiliate_enabled === 'false' ? 0 : bps(settings.affiliate_rate_bps, 1000),
    globalDiscountBps: bps(settings.global_token_discount_bps, 0, 9900),
    nightDiscountEnabled: booleanSetting(settings.night_token_discount_enabled, false),
    nightDiscountBps: bps(settings.night_token_discount_bps, 0, 9900),
    walletTopupMultiplierBps: worstWalletTopupMultiplier(walletTopupMultiplierBps),
  }
}

export function discountLimit(rows: any[], rules: ProfitRules) {
  const retainedBps = BigInt(10000 - rules.minimumMarginBps - rules.paymentFeeRateBps - rules.affiliateRateBps)
  const constraints: Array<{ model: string; tier: string; part: string; maxDiscountBps: number; costMicros: string; sellMicros: string; requiredSellMicros: string | null; reason: string | null }> = []
  for (const row of rows.filter((row) => row.active !== false)) {
    const tiers = [{ label: '标准', ...Object.fromEntries(['input', 'output', 'cache'].flatMap((part) => ['Cost', 'Sell'].map((kind) => [part + kind + 'MicrosPerMillion', row[part + '_' + kind.toLowerCase() + '_micros_per_million'] ?? row[part + '_' + kind.toLowerCase() + '_micros']])) ) }, ...(Array.isArray(row.pricing_tiers) ? row.pricing_tiers : [])]
    for (const tier of tiers) for (const part of ['input', 'output', 'cache']) {
      const rawCost = tier[part + 'CostMicrosPerMillion']; const rawSell = tier[part + 'SellMicrosPerMillion']
      const valid = /^\d+$/.test(String(rawCost)) && /^\d+$/.test(String(rawSell))
      const cost = valid ? BigInt(rawCost) : 0n; const sell = valid ? BigInt(rawSell) : 0n
      const required = retainedBps > 0n ? requiredWalletSell(cost, rules) : null
      const reason: string | null = !valid ? '成本或售价缺失' : retainedBps <= 0n ? '利润与费用比例合计达到 100%' : sell === 0n && required! > 0n ? '售价为零' : required! > sell ? '原价已低于利润线' : null
      // Round the required sale UP, matching billing's discounted-rate floor.
      const maxDiscountBps = reason ? 0 : sell === 0n ? 9900 : Math.min(9900, Number((sell - required!) * 10000n / sell))
      constraints.push({ model: String(row.model_pattern), tier: String(tier.label || tier.thresholdTokens || '价格层'), part, maxDiscountBps, costMicros: cost.toString(), sellMicros: sell.toString(), requiredSellMicros: required?.toString() ?? null, reason })
    }
  }
  const maxDiscountBps = constraints.length ? Math.min(...constraints.map((item) => item.maxDiscountBps)) : 0
  return { maxDiscountBps, constraints, blockers: constraints.filter((item) => item.reason), hasPrices: constraints.length > 0 }
}

export function assertDiscount(rows: any[], rules: ProfitRules, discount = rules.globalDiscountBps) {
  const limit = discountLimit(rows, rules)
  if (discount > limit.maxDiscountBps) throw Object.assign(new Error(`减免比例超过利润护栏，最多允许 ${limit.maxDiscountBps / 100}%；限制模型：${[...new Set(limit.constraints.filter((item) => item.maxDiscountBps === limit.maxDiscountBps).map((item) => item.model))].join('、') || '尚无有效模型价格'}`), { statusCode: 400 })
  return limit
}

type ChannelCostBlocker = { kind: string; model: string; channelId?: string; channelName?: string; message: string }

function uniqueChannelCostBlockers(blockers: ChannelCostBlocker[]): ChannelCostBlocker[] {
  const seen = new Set<string>()
  return blockers.filter((item) => {
    const key = [item.kind, item.model, item.channelId || '', item.message].join('\u0000')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Build the discount ceiling from every enabled route's highest standard/272K+ cost. */
export function buildDiscountGuardrail(input: { prices: any[]; channels: any[]; costs: any[]; rules: ProfitRules }) {
  const hasRuntimeRoute = (model: string) => input.channels.some((channel) => {
    if (channel.enabled === false || channel.deleted_at != null || !channel.model_map || typeof channel.model_map !== 'object' || Array.isArray(channel.model_map)) return false
    return Object.hasOwn(channel.model_map, model) || Object.hasOwn(channel.model_map, '*')
  })
  const activePrices = input.prices.filter((price) => price.active !== false)
  const routedPrices = activePrices.filter((price) => hasRuntimeRoute(String(price.model_pattern)))
  const routeDiagnostics: ChannelCostBlocker[] = activePrices
    .filter((price) => !hasRuntimeRoute(String(price.model_pattern)))
    .map((price) => ({ kind: 'no_route', model: String(price.model_pattern), message: `${String(price.model_pattern)} 没有启用的真实渠道映射` }))
  const margin = buildMarginPriceRows({ prices: routedPrices, channels: input.channels, costs: input.costs })
  const calculated = discountLimit(margin.rows, input.rules)
  const channelCostBlockers = uniqueChannelCostBlockers(margin.blockers.filter((item) => item.kind !== 'no_route'))
  return {
    ...calculated,
    calculatedMaxDiscountBps: calculated.maxDiscountBps,
    maxDiscountBps: channelCostBlockers.length ? 0 : calculated.maxDiscountBps,
    channelCostBlockers,
    routeDiagnostics,
    guardrailReady: channelCostBlockers.length === 0 && calculated.hasPrices && calculated.blockers.length === 0,
  }
}

type ProfitState = {
  settings: Record<string, string>
  prices: any[]
  channels: any[]
  costs: any[]
  users: any[]
  paidTopupMultiplierBps: number
}

export type ProfitOverview = ReturnType<ProfitService['evaluate']>

export class ProfitService {
  constructor(private readonly db: Database, private readonly walletTopupMultiplierBps = 50000) {}

  private async read(client: DbClient | undefined, sql: string): Promise<any[]> {
    return client ? (await client.query(sql)).rows : this.db.query<any>(sql)
  }

  private async state(client?: DbClient): Promise<ProfitState> {
    const settingRows = await this.read(client, 'SELECT key,value FROM app_settings')
    const prices = await this.read(client, 'SELECT * FROM model_prices WHERE active')
    // Runtime routing is governed by channels.model_map.  The historical
    // mapping table is catalogue metadata and must not create phantom routes.
    const channels = await this.read(client, `SELECT id,name,priority,enabled,deleted_at,model_map
      FROM channels WHERE deleted_at IS NULL AND enabled=true ORDER BY priority,name,id`)
    const costs = await this.read(client, 'SELECT * FROM channel_model_costs WHERE price_effective_at IS NULL OR price_effective_at <= now()')
    const users = await this.read(client, 'SELECT token_discount_bps FROM users')
    const paidTopup = (await this.read(client, `SELECT COALESCE(MAX(topup_multiplier_bps),0) AS multiplier
      FROM orders WHERE status='paid' AND kind='wallet_topup'`))[0]
    return {
      settings: Object.fromEntries(settingRows.map((row) => [row.key, row.value])),
      prices, channels, costs, users,
      paidTopupMultiplierBps: Number(paidTopup?.multiplier || 0),
    }
  }

  private rules(state: ProfitState): ProfitRules {
    return profitRules(state.settings, worstWalletTopupMultiplier(this.walletTopupMultiplierBps, state.paidTopupMultiplierBps))
  }

  evaluate(state: ProfitState, rules: ProfitRules, now: Date | string | number = new Date()) {
    const guardrail = buildDiscountGuardrail({ prices: state.prices, channels: state.channels, costs: state.costs, rules })
    const window = shanghaiNightDiscountWindow(now)
    const enabledNightDiscount = rules.nightDiscountEnabled ? rules.nightDiscountBps : 0
    const requestedNightDiscount = rules.nightDiscountEnabled && window.active ? rules.nightDiscountBps : 0
    const appliedNightDiscount = Math.min(requestedNightDiscount, guardrail.maxDiscountBps)
    const maxPersonalDiscountBps = state.users.reduce((maximum, user) => Math.max(maximum, Number(user.token_discount_bps) || 0), 0)
    const campaignConfiguredDiscountBps = effectiveDiscountBps(0, rules.globalDiscountBps, enabledNightDiscount)
    const configuredMaximumDiscountBps = effectiveDiscountBps(maxPersonalDiscountBps, rules.globalDiscountBps, enabledNightDiscount)
    const currentMaximumDiscountBps = effectiveDiscountBps(maxPersonalDiscountBps, rules.globalDiscountBps, appliedNightDiscount)
    return {
      ...rules,
      ...guardrail,
      maxPersonalDiscountBps,
      campaignConfiguredDiscountBps,
      configuredMaximumDiscountBps,
      currentMaximumDiscountBps,
      personalDiscountRiskCount: state.users.filter((user) => Number(user.token_discount_bps) > guardrail.maxDiscountBps).length,
      configuredDiscountRiskCount: campaignConfiguredDiscountBps > guardrail.maxDiscountBps ? 1 : 0,
      nightDiscountActive: rules.nightDiscountEnabled && window.active,
      nightDiscountWindow: window,
      nextTransitionAt: window.nextTransitionAt,
      nightDiscount: {
        enabled: rules.nightDiscountEnabled,
        configuredDiscountBps: rules.nightDiscountBps,
        appliedDiscountBps: appliedNightDiscount,
        active: rules.nightDiscountEnabled && window.active,
        inWindow: window.active,
        maxSafeDiscountBps: guardrail.maxDiscountBps,
        minimumMarginBps: rules.minimumMarginBps,
        protectionApplied: appliedNightDiscount < requestedNightDiscount,
        timezone: window.timezone,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        nextTransitionAt: window.nextTransitionAt,
        window,
      },
    }
  }

  private candidateRules(state: ProfitState, body: any): ProfitRules {
    const current = this.rules(state)
    return {
      ...current,
      minimumMarginBps: bps(body.minimumMarginBps ?? body.minMarginBps, current.minimumMarginBps, 9999),
      paymentFeeRateBps: bps(body.paymentFeeRateBps, current.paymentFeeRateBps),
      affiliateRateBps: body.affiliateEnabled === false ? 0 : bps(body.affiliateRateBps, current.affiliateRateBps),
      globalDiscountBps: bps(body.globalDiscountBps, current.globalDiscountBps, 9900),
      nightDiscountEnabled: booleanSetting(body.nightDiscountEnabled, current.nightDiscountEnabled),
      nightDiscountBps: bps(body.nightDiscountBps, current.nightDiscountBps, 9900),
      walletTopupMultiplierBps: worstWalletTopupMultiplier(body.walletTopupMultiplierBps, current.walletTopupMultiplierBps),
    }
  }

  private assertConfiguredSafety(overview: ReturnType<ProfitService['evaluate']>): void {
    const retainedCashBps = 10_000 - overview.minimumMarginBps - overview.paymentFeeRateBps - overview.affiliateRateBps
    if (retainedCashBps <= 0) {
      throw Object.assign(new Error('最低毛利、支付费和返利比例合计必须低于 100%'), { statusCode: 400, guardrail: overview })
    }
    if (overview.campaignConfiguredDiscountBps > 0 && overview.channelCostBlockers.length) {
      throw Object.assign(new Error('渠道成本不完整，无法安全启用折扣；请先补齐所有启用渠道映射的标准及 272K+ 成本'), { statusCode: 409, guardrail: overview })
    }
    if (overview.campaignConfiguredDiscountBps > overview.maxDiscountBps) {
      throw Object.assign(new Error(`减免比例超过利润护栏，最多允许 ${overview.maxDiscountBps / 100}%`), { statusCode: 400, guardrail: overview })
    }
  }

  async overview(client?: DbClient, now: Date | string | number = new Date()) {
    const state = await this.state(client)
    return this.evaluate(state, this.rules(state), now)
  }

  /** Validate a proposed personal/campaign discount against current global settings without writing. */
  async validateDiscount(discount: unknown, client?: DbClient) {
    const requested = bps(discount, 0, 9900)
    const state = await this.state(client)
    const rules = this.rules(state)
    const overview = this.evaluate(state, rules)
    const effective = effectiveDiscountBps(requested, rules.globalDiscountBps, rules.nightDiscountEnabled ? rules.nightDiscountBps : 0)
    if (effective > 0 && overview.channelCostBlockers.length) {
      throw Object.assign(new Error('渠道成本不完整，无法安全启用折扣；请先补齐所有启用渠道映射的标准及 272K+ 成本'), { statusCode: 409, guardrail: overview })
    }
    if (effective > overview.maxDiscountBps) {
      throw Object.assign(new Error(`减免比例超过利润护栏，最多允许 ${overview.maxDiscountBps / 100}%`), { statusCode: 400, guardrail: overview })
    }
    return overview
  }

  async assertSafeDiscount(discount: unknown, client?: DbClient) {
    return this.validateDiscount(discount, client)
  }

  /** Validate all profit-setting fields against one consistent database snapshot. */
  async validateUpdate(body: any, client?: DbClient) {
    const state = await this.state(client)
    const rules = this.candidateRules(state, body)
    const overview = this.evaluate(state, rules)
    this.assertConfiguredSafety(overview)
    return overview
  }

  async update(body: any, actorId: string) {
    return this.db.tx(async (client) => {
      // Match pricing publication's lock order so costs, routes and prices stay stable.
      await client.query('LOCK TABLE channels, channel_model_mappings, channel_model_costs, model_prices, app_settings, users IN SHARE ROW EXCLUSIVE MODE')
      const state = await this.state(client)
      const before = this.evaluate(state, this.rules(state))
      const rules = this.candidateRules(state, body)
      if (body.applySafeDiscount === true) rules.globalDiscountBps = this.evaluate(state, rules).maxDiscountBps
      this.assertConfiguredSafety(this.evaluate(state, rules))
      for (const [key, settingKey, value] of [
        ['profit_min_margin_bps', 'profit.min_margin_bps', rules.minimumMarginBps],
        ['payment_fee_rate_bps', 'profit.payment_fee_rate_bps', rules.paymentFeeRateBps],
        ['global_token_discount_bps', 'profit.global_token_discount_bps', rules.globalDiscountBps],
      ]) await client.query(`INSERT INTO app_settings(key,setting_key,value,value_json,updated_by_user_id) VALUES($1,$2,$3,to_jsonb($3::text),$4)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,value_json=excluded.value_json,updated_by_user_id=excluded.updated_by_user_id,updated_at=now()`, [key, settingKey, String(value), actorId])
      const after = await this.overview(client)
      await client.query(`INSERT INTO config_audit_logs(actor_user_id,resource_type,resource_id,before_value,after_value) VALUES($1,'profit_settings','global',$2,$3)`, [actorId, JSON.stringify(before), JSON.stringify(after)])
      return after
    })
  }

  async updateNightDiscount(body: { enabled?: unknown; discountBps?: unknown }, actorId: string) {
    return this.db.tx(async (client) => {
      await client.query('LOCK TABLE channels, channel_model_mappings, channel_model_costs, model_prices, app_settings, users IN SHARE ROW EXCLUSIVE MODE')
      const state = await this.state(client)
      const currentRules = this.rules(state)
      const before = this.evaluate(state, currentRules)
      const rules = {
        ...currentRules,
        nightDiscountEnabled: booleanSetting(body.enabled, currentRules.nightDiscountEnabled),
        nightDiscountBps: bps(body.discountBps, currentRules.nightDiscountBps, 9900),
      }
      const candidate = this.evaluate(state, rules)
      // Always permit turning the campaign off (or setting it to zero) so an
      // incomplete legacy cost configuration cannot trap administrators.
      if (rules.nightDiscountEnabled && rules.nightDiscountBps > 0) this.assertConfiguredSafety(candidate)
      for (const [key, settingKey, value] of [
        ['night_token_discount_enabled', 'profit.night_token_discount_enabled', String(rules.nightDiscountEnabled)],
        ['night_token_discount_bps', 'profit.night_token_discount_bps', String(rules.nightDiscountBps)],
      ]) await client.query(`INSERT INTO app_settings(key,setting_key,value,value_json,updated_by_user_id) VALUES($1,$2,$3,to_jsonb($3::text),$4)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,value_json=excluded.value_json,updated_by_user_id=excluded.updated_by_user_id,updated_at=now()`, [key, settingKey, value, actorId])
      const after = await this.overview(client)
      await client.query(`INSERT INTO config_audit_logs(actor_user_id,resource_type,resource_id,before_value,after_value) VALUES($1,'profit_settings','night_discount',$2,$3)`, [actorId, JSON.stringify(before), JSON.stringify(after)])
      return after
    })
  }
}
