import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import sensible from '@fastify/sensible'
import fastifyStatic from '@fastify/static'
import QRCode from 'qrcode'
import { randomUUID, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import {
  ENTERPRISE_TOPUP_MINIMUM_MICROS,
  ENTERPRISE_TOPUP_MULTIPLIER_BPS,
  MONTHLY_DISPLAY_MULTIPLIER_BPS,
  loadConfig,
  type AppConfig,
} from './config.js'
import { Database } from './db/index.js'
import { RedisStore } from './db/redis.js'
import { AuthService, type PublicUser } from './services/auth.js'
import { BillingService, type PriceSnapshot } from './services/billing.js'
import { AffiliateService } from './services/affiliate.js'
import { ChannelService } from './services/channels.js'
import { normalizeNewOrderPaymentMethod, OrderService } from './services/orders.js'
import { MailService } from './services/mail.js'
import { buildCcswitchImportLink } from './lib/ccswitch.js'
import { calculateUsageMoney, estimatedRequestTokens, formatMicros, yuanToMicros } from './lib/money.js'
import { parseSseUsage, usageFromPayload } from './lib/usage.js'
import { isPublicFallbackModel, PublicModelSse, rewritePublicModel } from './lib/public-model.js'
import { AgnesResponsesSse, chatToResponses } from './lib/agnes-adapter.js'
import { decodeResponseBuffer, decodeResponseStream } from './lib/response-compression.js'
import { ProfitService, shanghaiNightDiscountWindow } from './services/profit.js'
import { fallbackCostAlerts, fallbackCostPending, pendingFallbackCostSql } from './lib/cost-status.js'
import { mediaUploadType } from './lib/media-upload.js'
import { MediaService } from './services/media.js'
import { registerMediaApi } from './lib/media-api.js'
import { mediaPrice } from './lib/media.js'
import { ChatService } from './services/chat.js'
import { ChannelCostService } from './services/channel-costs.js'
import { LayaShadow } from './services/laya-shadow.js'
import { requiredWalletSell, type PricingRules } from './services/pricing.js'

const here = dirname(fileURLToPath(import.meta.url))

export type RelayApp = {
  app: ReturnType<typeof Fastify>
  db: Database
  redis: RedisStore
  config: AppConfig
  auth: AuthService
  billing: BillingService
  affiliate: AffiliateService
  channels: ChannelService
  orders: OrderService
  mail: MailService
  profit: ProfitService
}


function jsonBody(body: unknown): Buffer | undefined {
  if (body === undefined || body === null) return undefined
  if (Buffer.isBuffer(body)) return body
  if (typeof body === 'string') return Buffer.from(body)
  return Buffer.from(JSON.stringify(body))
}

function rawRequestBody(request: any): Buffer {
  if (Buffer.isBuffer(request.rawBody)) return request.rawBody
  if (typeof request.rawBody === 'string') return Buffer.from(request.rawBody)
  return jsonBody(request.body) || Buffer.alloc(0)
}

function bearer(value: unknown): string {
  const text = String(value || '')
  return /^Bearer\s+\S+$/i.test(text) ? text.replace(/^Bearer\s+/i, '').trim() : ''
}

function errorStatus(error: any): number {
  if (Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 600) return error.statusCode
  const message = String(error?.message || '')
  // Keep local billing failures out of CC Switch's provider failover circuit.
  // CC Switch treats upstream 402 as retryable, so an account with no balance
  // would incorrectly mark every configured provider as unhealthy. A 400 is a
  // non-retryable request error and preserves the billing message for clients.
  if (/余额不足/.test(message)) return 400
  if (/无效|错误|必须|缺少|不足|已存在/.test(message)) return 400
  return 500
}

function encodeCursor(createdAt: unknown, id: unknown): string {
  return Buffer.from(JSON.stringify({ t: new Date(createdAt as any).toISOString(), id: String(id) })).toString('base64url')
}

function decodeCursor(cursor: string | undefined): { t: string; id: string } | null {
  if (!cursor) return null
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (typeof value.t !== 'string' || typeof value.id !== 'string' || !Number.isFinite(Date.parse(value.t))) return null
    return value
  } catch { return null }
}

function publicMoney(value: unknown): { micros: string; yuan: string } {
  const micros = BigInt(String(value ?? 0))
  return { micros: micros.toString(), yuan: formatMicros(micros) }
}

function boundedLimit(value: unknown, fallback = 50, max = 100): number {
  const parsed = Number(value ?? fallback)
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(max, parsed) : fallback
}

function dateFilter(value: unknown, endExclusive = false): Date {
  const text = String(value || '').trim()
  if (!text) throw new Error('日期不能为空')
  const date = new Date(text)
  if (!Number.isFinite(date.getTime())) throw new Error('日期格式无效')
  if (endExclusive && /^\d{4}-\d{2}-\d{2}$/.test(text)) date.setUTCDate(date.getUTCDate() + 1)
  return date
}

function uuidFilter(value: unknown, name: string): string {
  const text = String(value || '').trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) throw new Error(`${name}无效`)
  return text
}

function moneyInput(value: unknown, name: string, allowZero = true): string {
  const text = String(value ?? '').trim()
  if (!/^\d+$/.test(text)) throw new Error(`${name}必须为整数`) 
  const amount = BigInt(text)
  if (amount < 0n || (!allowZero && amount === 0n)) throw new Error(`${name}无效`)
  return amount.toString()
}

function yuanInput(value: unknown, name: string, allowZero = true): string {
  let micros: bigint
  try { micros = yuanToMicros(String(value ?? '')) } catch { throw new Error(`${name}必须是最多 6 位小数的人民币金额`) }
  if (micros < 0n || (!allowZero && micros === 0n)) throw new Error(`${name}无效`)
  return micros.toString()
}

function parsePricingTiers(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length > 8) throw new Error('分层价格必须是最多 8 档的数组')
  const seen = new Set<string>()
  return value.map((item: any) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('分层价格格式无效')
    const threshold = String(item.thresholdTokens ?? '').trim()
    if (!/^\d+$/.test(threshold) || BigInt(threshold) < 1n || BigInt(threshold) > 9_223_372_036_854_775_807n || seen.has(threshold)) throw new Error('分层 Token 阈值无效或重复')
    seen.add(threshold)
    const normalized: Record<string, unknown> = { thresholdTokens: threshold }
    if (item.label != null) normalized.label = cleanText(item.label, '价格层名称', 128)
    for (const [part, label] of [['input','输入'],['output','输出'],['cache','cache-read']] as const) {
      normalized[`${part}SellMicrosPerMillion`] = moneyInput(item[`${part}SellMicrosPerMillion`], `${label}售价`)
      normalized[`${part}CostMicrosPerMillion`] = moneyInput(item[`${part}CostMicrosPerMillion`], `${label}成本`)
    }
    const writeSell = item.cacheWriteSellMicrosPerMillion
    const writeCost = item.cacheWriteCostMicrosPerMillion
    if ((writeSell == null) !== (writeCost == null)) throw new Error('cache-write 成本和售价必须同时填写')
    if (writeSell != null) {
      normalized.cacheWriteSellMicrosPerMillion = moneyInput(writeSell, 'cache-write售价')
      normalized.cacheWriteCostMicrosPerMillion = moneyInput(writeCost, 'cache-write成本')
    }
    return normalized
  }).sort((a: any, b: any) => BigInt(a.thresholdTokens) < BigInt(b.thresholdTokens) ? -1 : 1)
}

function cleanText(value: unknown, name: string, max = 256): string {
  const text = String(value ?? '').trim()
  if (!text || text.length > max) throw new Error(`${name}无效`)
  return text
}

const PRICE_COMPARISON_MODELS = [
  { id: 'gpt-6-astra', displayName: 'Astra' },
  { id: 'gpt-6-sol', displayName: 'Sol 6' },
  { id: 'gpt-5.6-sol', displayName: 'Sol' },
  { id: 'gpt-5.6-terra', displayName: 'Terra' },
] as const

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

export function shanghaiDayBounds(now: Date = new Date()): { from: Date; to: Date } {
  const local = new Date(now.getTime() + SHANGHAI_OFFSET_MS)
  const fromTime = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - SHANGHAI_OFFSET_MS
  return { from: new Date(fromTime), to: new Date(fromTime + 24 * 60 * 60 * 1000) }
}

export { shanghaiNightDiscountWindow } from './services/profit.js'

function nightDiscountView(profitOverview: any, personalDiscountBps = 0, globalDiscountOverride?: number, now: Date = new Date()) {
  const window = shanghaiNightDiscountWindow(now)
  const enabled = profitOverview.nightDiscountEnabled === true
  const configuredDiscountBps = Math.max(0, Math.min(9900, Number(profitOverview.nightDiscountBps || 0)))
  const maxSafeDiscountBps = Math.max(0, Math.min(9900, Number(profitOverview.maxDiscountBps || 0)))
  const active = enabled && window.active
  const appliedDiscountBps = active ? Math.min(configuredDiscountBps, maxSafeDiscountBps) : 0
  const globalDiscountBps = Math.max(0, Math.min(9900, Number(globalDiscountOverride ?? profitOverview.globalDiscountBps ?? 0)))
  return {
    timezone: 'Asia/Shanghai',
    start: '00:00',
    end: '04:00',
    enabled,
    configuredDiscountBps,
    discountBps: configuredDiscountBps,
    active,
    appliedDiscountBps,
    currentDiscountBps: appliedDiscountBps,
    effectiveTokenDiscountBps: Math.max(personalDiscountBps, globalDiscountBps, appliedDiscountBps),
    maxSafeDiscountBps,
    minimumMarginBps: Number(profitOverview.minimumMarginBps || 0),
    protectionApplied: active && appliedDiscountBps < configuredDiscountBps,
    startsAt: window.startsAt,
    endsAt: window.endsAt,
    nextTransitionAt: window.nextTransitionAt,
  }
}

function roundedDivision(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new Error('价格参数无效')
  return (numerator + denominator / 2n) / denominator
}

function validMultiplier(value: unknown, fallback: number): number {
  const multiplier = Number(value)
  return Number.isInteger(multiplier) && multiplier >= 10000 && multiplier <= 100000 ? multiplier : fallback
}

function modelRate(row: any, part: 'input' | 'output' | 'cache' | 'cacheWrite', tier?: any): bigint | null {
  const column = part === 'cacheWrite' ? 'cache_write' : part
  const value = tier?.[`${part}SellMicrosPerMillion`]
    ?? tier?.[`${column}_sell_micros_per_million`]
    ?? row?.[`${column}_sell_micros_per_million`]
    ?? row?.[`${column}_sell_micros`]
  const text = String(value ?? '')
  return /^\d+$/.test(text) ? BigInt(text) : null
}

export function buildModelPriceComparison(rows: any[], effectiveDiscountBps: number, walletMultiplierBps: number) {
  const discountBps = Math.max(0, Math.min(9900, Number.isInteger(effectiveDiscountBps) ? effectiveDiscountBps : 0))
  const walletMultiplier = validMultiplier(walletMultiplierBps, 30000)
  const monthlyMultiplier = MONTHLY_DISPLAY_MULTIPLIER_BPS
  const enterpriseMultiplier = ENTERPRISE_TOPUP_MULTIPLIER_BPS
  const indexed = new Map(rows.map((row) => [String(row.model_pattern), row]))
  const unavailableRate = () => ({ standardMicros: null, walletEffectiveMicros: null, monthlyEffectiveMicros: null, enterpriseEffectiveMicros: null })
  const displayRate = (rate: bigint) => {
    const numerator = rate * BigInt(10000 - discountBps)
    return {
      standardMicros: roundedDivision(numerator, 10000n).toString(),
      walletEffectiveMicros: roundedDivision(numerator, BigInt(walletMultiplier)).toString(),
      monthlyEffectiveMicros: roundedDivision(numerator, BigInt(monthlyMultiplier)).toString(),
      enterpriseEffectiveMicros: roundedDivision(numerator, BigInt(enterpriseMultiplier)).toString(),
    }
  }
  return {
    unit: 'CNY_PER_MILLION_TOKENS',
    walletMultiplierBps: walletMultiplier,
    monthlyMultiplierBps: monthlyMultiplier,
    enterpriseMultiplierBps: enterpriseMultiplier,
    models: PRICE_COMPARISON_MODELS.map((model) => {
      const row = indexed.get(model.id)
      const highTier = Array.isArray(row?.pricing_tiers)
        ? row.pricing_tiers
          .filter((tier: any) => { try { return BigInt(tier.thresholdTokens ?? tier.threshold_tokens ?? 0) > 272000n } catch { return false } })
          .sort((a: any, b: any) => { try { return BigInt(a.thresholdTokens ?? a.threshold_tokens) < BigInt(b.thresholdTokens ?? b.threshold_tokens) ? -1 : 1 } catch { return 0 } })[0]
        : null
      const input = modelRate(row, 'input')
      const output = modelRate(row, 'output')
      const cache = modelRate(row, 'cache')
      const cacheWrite = modelRate(row, 'cacheWrite')
      const available = Boolean(row?.active) && input !== null && input > 0n && output !== null && output > 0n && cache !== null && cache > 0n
      const highInput = modelRate(row, 'input', highTier)
      const highOutput = modelRate(row, 'output', highTier)
      const highCache = modelRate(row, 'cache', highTier)
      const highCacheWrite = modelRate(row, 'cacheWrite', highTier)
      return {
        ...model,
        available,
        input: available ? displayRate(input!) : unavailableRate(),
        output: available ? displayRate(output!) : unavailableRate(),
        cache: available ? displayRate(cache!) : unavailableRate(),
        cacheWrite: cacheWrite === null ? unavailableRate() : displayRate(cacheWrite),
        highContext: highTier && highInput !== null && highOutput !== null && highCache !== null
          ? {
              thresholdTokens: String(highTier.thresholdTokens ?? highTier.threshold_tokens),
              input: displayRate(highInput),
              output: displayRate(highOutput),
              cache: displayRate(highCache),
              cacheWrite: highCacheWrite === null ? unavailableRate() : displayRate(highCacheWrite),
            }
          : null,
      }
    }),
  }
}

function optionalLeadText(value: unknown, name: string, max: number): string | null {
  if (value === undefined || value === null || String(value).trim() === '') return null
  const result = String(value).trim()
  if (result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) {
    throw Object.assign(new Error(`${name}无效或超过 ${max} 个字符`), { statusCode: 400 })
  }
  return result
}

export function normalizeEnterpriseLeadInput(body: any): { contactName: string; contactMethod: string; desiredSiteName: string | null; note: string | null } {
  const contactName = optionalLeadText(body?.contactName, '联系人', 80)
  const contactMethod = optionalLeadText(body?.contactMethod, '联系方式', 160)
  if (!contactName) throw Object.assign(new Error('请填写联系人'), { statusCode: 400 })
  if (!contactMethod) throw Object.assign(new Error('请填写联系方式'), { statusCode: 400 })
  return {
    contactName,
    contactMethod,
    desiredSiteName: optionalLeadText(body?.desiredSiteName, '期望站点名称', 120),
    note: optionalLeadText(body?.note, '需求说明', 2000),
  }
}

function publicEnterpriseLead(row: any): Record<string, unknown> | null {
  if (!row) return null
  return {
    id: String(row.id),
    userId: String(row.user_id),
    contactName: String(row.contact_name),
    contactMethod: String(row.contact_method),
    desiredSiteName: row.desired_site_name == null ? null : String(row.desired_site_name),
    note: row.note == null ? null : String(row.note),
    ...(row.username === undefined ? {} : { username: String(row.username) }),
    ...(row.email === undefined ? {} : { email: row.email == null ? null : String(row.email) }),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

async function settingInt(db: Database, key: string, fallback: number): Promise<number> {
  const row = await db.one<any>('SELECT value FROM app_settings WHERE key=$1', [key])
  const value = Number(row?.value)
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

function requireWalletMinimumMargin(cost: bigint, sell: bigint, rules: PricingRules, label: string): void {
  const required = requiredWalletSell(cost, rules)
  if (sell < required) {
    const actual = sell > 0n ? Number(((sell * BigInt(10_000 - rules.paymentFeeRateBps - rules.affiliateRateBps)) / BigInt(rules.walletTopupMultiplierBps)) * 10_000n / sell) / 100 : -100
    const error = new Error(`${label}低于最低现金毛利 ${rules.minimumMarginBps / 100}%：当前约 ${actual.toFixed(2)}%，钱包售价至少应为 ${formatMicros(required)} 元`)
    Object.assign(error, { statusCode: 400 })
    throw error
  }
}

function responseHeader(headers: Record<string, string | string[] | undefined>, names: string[]): string | null {
  for (const name of names) {
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
    const value = Array.isArray(entry) ? entry[0] : entry
    if (value) return String(value).slice(0, 256)
  }
  return null
}

const blockedRelayResponseHeaders = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie', 'x-request-id'])

export function shouldForwardRelayResponseHeader(name: string): boolean {
  return !blockedRelayResponseHeaders.has(name.toLowerCase())
}

function upstreamErrorDetails(payload: any): { code: string; summary: string } {
  if (!payload || typeof payload !== 'object') return { code: 'upstream_http_error', summary: '上游返回错误' }
  const error = payload.error && typeof payload.error === 'object' ? payload.error : payload
  const code = String(error.code || '').toLowerCase()
  const message = String(error.message || '').toLowerCase()
  if (code === 'json_parse_error' || message.includes('responseinput') || message.includes('response input')) {
    return { code: 'upstream_invalid_response_input', summary: '上游拒绝了 Responses 输入结构' }
  }
  if (message.includes('tool') || message.includes('function')) return { code: 'upstream_invalid_tool_schema', summary: '上游拒绝了工具结构' }
  if (code.includes('auth') || code.includes('permission')) return { code: 'upstream_auth_error', summary: '上游认证或权限失败' }
  return { code: 'upstream_http_error', summary: '上游返回错误' }
}

function waitForWritableDrain(stream: any): Promise<void> {
  if (stream.destroyed || stream.writableEnded) return Promise.reject(new Error('客户端连接已关闭'))
  return new Promise((resolve, reject) => {
    let complete = false
    const cleanup = () => {
      stream.removeListener('drain', onDrain)
      stream.removeListener('close', onClose)
      stream.removeListener('error', onError)
    }
    const finish = (error?: Error) => {
      if (complete) return
      complete = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const onDrain = () => finish()
    const onClose = () => finish(new Error('客户端连接已关闭'))
    const onError = () => finish(new Error('客户端连接异常'))
    stream.once('drain', onDrain)
    stream.once('close', onClose)
    stream.once('error', onError)
    if (stream.destroyed || stream.writableEnded) onClose()
  })
}

function estimatedFailedAttemptCost(price: PriceSnapshot, payload: Record<string, unknown>): bigint {
  if (price.billingMode === 'fixed') return price.fixedCostMicros
  const estimate = estimatedRequestTokens(payload)
  return calculateUsageMoney({ ...estimate, output: 0n, reportedTotal: estimate.input }, price).costMicros
}

async function optionalPaymentGateway(config: AppConfig): Promise<any | null> {
  try {
    const module = await import('./payment/gateway.js')
    return new module.PaymentGateway(config)
  } catch (error: any) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return null
    throw error
  }
}

export async function buildApp(inputConfig = loadConfig()): Promise<RelayApp> {
  const config = inputConfig
  const app = Fastify({ logger: config.env !== 'test', trustProxy: true, bodyLimit: 20 * 1024 * 1024 })
  const db = new Database(config)
  const redis = new RedisStore(config)
  const auth = new AuthService(db, config)
  const billing = new BillingService(db)
  const affiliate = new AffiliateService(db)
  const channels = new ChannelService(db, config)
  const orders = new OrderService(db, affiliate, config)
  const mail = new MailService(db, config)
  const profit = new ProfitService(db, config.walletTopupMultiplierBps)
  const layaShadow = new LayaShadow(config.layaShadow)

  await app.register(sensible)
  await app.register(cookie, { secret: config.cookieSecret })
  await app.register(jwt, { secret: config.jwtSecret, cookie: { cookieName: 'relay_session', signed: false } })
  // The browser console is served from this origin and needs no CORS
  // headers. Cross-origin use is opt-in through an explicit allowlist; never
  // reflect an arbitrary Origin while also sending the session cookie.
  const corsOrigin = config.corsOrigins.length ? config.corsOrigins : false
  await app.register(cors, { origin: corsOrigin, credentials: config.corsOrigins.length > 0 })
  // Share counters across API replicas. A Redis outage should not take the
  // relay offline; the plugin's skipOnError fallback keeps the request path
  // available until Redis recovers.
  await app.register(rateLimit, { redis: redis.client, skipOnError: true, max: 120, timeWindow: '1 minute', keyGenerator: (request) => request.ip })
  await app.register(fastifyStatic, { root: join(here, '../public'), prefix: '/' })
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => done(null, body))
  // JSON and form content keep their dedicated parsers. Everything else is
  // intentionally opaque so multipart, image, audio and binary OpenAI paths
  // can be forwarded byte-for-byte through the /v1 relay.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body))

  // Keep the exact signed callback bytes while allowing Fastify to continue
  // parsing ordinary JSON/form requests for the rest of the application.
  app.addHook('preParsing', async (request: any, _reply: any, payload: any) => {
    const routePath = String(request.raw?.url || '').split('?')[0]
    if (!routePath.startsWith('/api/payments/')) return payload
    if (!payload || typeof payload[Symbol.asyncIterator] !== 'function') return payload
    const chunks: Buffer[] = []
    for await (const chunk of payload) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const raw = Buffer.concat(chunks)
    request.rawBody = raw
    const replacement = new PassThrough()
    ;(replacement as any).receivedEncodedLength = raw.length
    replacement.end(raw)
    return replacement
  })

  const sessionLifetime = 400 * 86400
  const issueSession = (reply: any, user: {id:string;role:string}) => {
    const token = app.jwt.sign({ sub:user.id, role:user.role }, {expiresIn:sessionLifetime})
    reply.setCookie('relay_session',token,{httpOnly:true,sameSite:'lax',secure:config.env==='production',path:'/',maxAge:sessionLifetime})
    reply.header('Cache-Control','no-store')
  }
  const requireSession = async (request: any, reply: any, optional = false): Promise<PublicUser | null> => {
    try {
      await request.jwtVerify()
      const payload = request.user as any
      const user = await db.one<any>(`SELECT id, username, email, email_verified_at, role, invite_code, created_at, disabled_at, status
        FROM users WHERE id = $1`, [payload.sub])
      if (!user || user.disabled_at || user.status !== 'active') throw new Error('登录已失效')
      // Renew cookie-authenticated sessions daily; upgrade still-valid legacy 7-day tokens.
      if (request.cookies?.relay_session && Number(payload.exp || 0) < Math.floor(Date.now()/1000) + sessionLifetime - 86400) issueSession(reply,user)
      return { id: String(user.id), username: user.username, email: user.email || null, emailVerified: Boolean(user.email_verified_at), role: user.role === 'admin' ? 'admin' : 'user', inviteCode: user.invite_code, createdAt: new Date(user.created_at).toISOString() }
    } catch {
      if (!optional) reply.code(401).send({ error: { message: '请先登录', type: 'authentication_error' } })
      return null
    }
  }
  const requireAdmin = async (request: any, reply: any): Promise<PublicUser | null> => {
    const user = await requireSession(request, reply)
    if (user && user.role !== 'admin') { reply.code(403).send({ error: { message: '需要管理员权限' } }); return null }
    return user
  }

  const chat = new ChatService(db, config, billing)
  app.get('/chat', async (_request, reply) => reply.sendFile('index.html'))
  app.get('/api/me/chat/quota', async (request,reply) => { const u=await requireSession(request,reply);if(u)return chat.quota(u.id) })
  app.get('/api/me/chat/conversations', async (request,reply) => { const u=await requireSession(request,reply);if(u)return chat.list(u.id) })
  app.post('/api/me/chat/conversations', async (request,reply) => { const u=await requireSession(request,reply);if(u)return chat.create(u.id) })
  app.get('/api/me/chat/conversations/:id/messages', async (request,reply) => { const u=await requireSession(request,reply);if(u)return chat.messages(u.id,String((request.params as any).id)) })
  app.delete('/api/me/chat/conversations/:id', async (request,reply) => { const u=await requireSession(request,reply);if(u)return chat.archive(u.id,String((request.params as any).id)) })
  app.post('/api/me/chat/conversations/:id/messages', {bodyLimit:64000}, async (request,reply) => {
    const u=await requireSession(request,reply);if(!u)return
    const controller=new AbortController()
    const close=()=>{if(!reply.raw.writableEnded)controller.abort()}
    reply.raw.once('close',close)
    try {return await chat.send(u.id,String((request.params as any).id),request.body,controller.signal)} finally {reply.raw.removeListener('close',close)}
  })
  const media = new MediaService(db, config)
  registerMediaApi(app, auth, media)
  const mediaUser = async (request: any, reply: any) => {
    const raw = bearer(request.headers.authorization)
    if (!raw) return requireSession(request, reply)
    try { return (await auth.authenticateApiKey(raw)).user } catch { reply.code(401).send({ error: { message: 'API Key 无效' } }); return null }
  }
  app.post('/api/me/media/uploads', {bodyLimit:20*1024*1024,config:{rateLimit:{max:12,timeWindow:'1 minute'}},preValidation:async(request,reply)=>{await mediaUser(request,reply)}}, async(request,reply)=>{
    const user=await mediaUser(request,reply);if(!user)return
    const data=request.body as Buffer, type=mediaUploadType(data), token=randomBytes(32).toString('hex')
    await db.tx(async client=>{
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[user.id])
      await client.query('DELETE FROM media_uploads WHERE expires_at<now()')
      const size=await client.query('SELECT COALESCE(sum(octet_length(content)),0) AS bytes FROM media_uploads WHERE user_id=$1',[user.id])
      if(Number(size.rows[0].bytes)+data.length>100*1024*1024)throw Object.assign(new Error('临时素材已达 100 MB，请删除不需要的素材后重试'),{statusCode:413})
      await client.query('INSERT INTO media_uploads(token,user_id,content_type,content) VALUES($1,$2,$3,$4)',[token,user.id,type,data])
    })
    return {url:config.publicBaseUrl.replace(/\/$/,'')+'/api/media/assets/'+token,token,contentType:type,expiresInDays:7}
  })
  app.get('/api/media/assets/:token',async(request,reply)=>{
    const token=String((request.params as any).token)
    if(!/^[a-f0-9]{64}$/.test(token))return reply.code(404).send()
    const row=await db.one<any>('SELECT content_type,content FROM media_uploads WHERE token=$1 AND expires_at>now()',[token])
    if(!row)return reply.code(404).send()
    return reply.header('X-Content-Type-Options','nosniff').header('Cache-Control','private, max-age=300').type(row.content_type).send(row.content)
  })
  app.delete('/api/me/media/uploads/:token',async(request,reply)=>{
    const user=await mediaUser(request,reply);if(!user)return
    await db.query('DELETE FROM media_uploads WHERE token=$1 AND user_id=$2',[String((request.params as any).token),user.id]);return {ok:true}
  })
  app.get('/api/me/media/catalog', async (request,reply)=>{const user=await mediaUser(request,reply);if(!user)return;const catalog=await media.catalog();const gift=await db.one('SELECT images_remaining,video_seconds_remaining FROM media_welcome_gifts WHERE user_id=$1',[user.id]);return {...catalog,gift}})
  app.post('/api/me/media/quote', async (request,reply)=>{const user=await mediaUser(request,reply);if(!user)return;const q=await media.quote(user.id,request.body);return {chargeMicros:q.chargeMicros,quoteToken:q.quoteToken,walletOnly:q.walletOnly,gift:q.gift}})
  app.post('/api/me/media/expand-prompt', {config:{rateLimit:{max:5,timeWindow:'1 minute'}}}, async(request,reply)=>{const user=await mediaUser(request,reply);if(!user)return;return media.expandPrompt(request.body)})
  app.post('/api/me/media/tasks', async (request,reply)=>{const user=await mediaUser(request,reply);if(!user)return;reply.code(202);return media.create(user.id,request.body)})
  app.get('/api/me/media/tasks', async (request,reply)=>{const user=await mediaUser(request,reply);if(!user)return;return media.list(user.id)})
  app.get('/api/me/media/tasks/:id', async (request,reply)=>{const user=await mediaUser(request,reply);if(!user)return;return media.get(user.id,String((request.params as any).id))})
  app.delete('/api/me/media/tasks/:id', async (request,reply)=>{const user=await mediaUser(request,reply);if(!user)return;return media.cancel(user.id,String((request.params as any).id))})
  const sendStoredMedia = async (reply:any, taskId:string) => {
    const asset=await db.one<any>('SELECT content_type,content FROM media_task_assets WHERE task_id=$1',[taskId])
    if(!asset)return false
    reply.header('X-Content-Type-Options','nosniff').header('Cache-Control','private, no-store').type(asset.content_type).send(asset.content)
    return true
  }
  const mediaTaskResult = async(request:any,reply:any)=>{
    const user=await mediaUser(request,reply);if(!user)return
    const id=String((request.params as any).id)
    if(!/^[0-9a-f-]{36}$/i.test(id))return reply.code(404).send()
    const task=await db.one<any>("SELECT result_url,kind FROM media_tasks WHERE id=$1 AND user_id=$2 AND status='completed'",[id,user.id])
    if(!task?.result_url)return reply.code(404).send({error:{message:'作品不存在或尚未完成'}})
    if(task.result_url.startsWith('stored://')) {
      if(await sendStoredMedia(reply,id)) return
      return reply.code(404).send({error:{message:'作品不存在或尚未完成'}})
    }
    const url=new URL(task.result_url)
    if(url.protocol!=='https:'||url.hostname!=='platform-outputs.agnes-ai.space'||url.port||url.username||url.password)return reply.code(502).send({error:{message:'作品地址暂不可读取，请联系管理员'}})
    try {
      const headers:Record<string,string>={}
      if(request.headers.range&&/^bytes=\d*-\d*$/.test(request.headers.range))headers.range=request.headers.range
      const upstream=await fetch(url,{headers,redirect:'error',signal:AbortSignal.timeout(120000)})
      if(!upstream.ok||!upstream.body)return reply.code(502).send({error:{message:'作品暂时无法读取，请稍后重试'}})
      const type=upstream.headers.get('content-type')||''
      if(!/^(image\/(png|jpeg|webp)|video\/mp4)(;|$)/i.test(type))return reply.code(502).send({error:{message:'作品格式异常'}})
      for(const name of ['content-length','content-range','accept-ranges']){const value=upstream.headers.get(name);if(value)reply.header(name,value)}
      reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff').type(type).code(upstream.status)
      return reply.send(Readable.fromWeb(upstream.body as any))
    } catch {return reply.code(502).send({error:{message:'作品读取失败，请稍后重试'}})}
  }
  app.get('/api/me/media/tasks/:id/result',mediaTaskResult)
  app.get('/v1/media/tasks/:id/result',mediaTaskResult)
  const mediaProxy = async (reply:any, resultUrl:string, range?:string) => {
    const url=new URL(resultUrl)
    if(url.protocol!=='https:'||url.hostname!=='platform-outputs.agnes-ai.space'||url.port||url.username||url.password)return reply.code(502).send({error:{message:'作品地址暂不可读取'}})
    try {
      const headers:Record<string,string>={}
      if(range&&/^bytes=\d*-\d*$/.test(range))headers.range=range
      const upstream=await fetch(url,{headers,redirect:'error',signal:AbortSignal.timeout(120000)})
      if(!upstream.ok||!upstream.body)return reply.code(502).send({error:{message:'作品暂时无法读取，请稍后重试'}})
      const type=upstream.headers.get('content-type')||''
      if(!/^(image\/(png|jpeg|webp)|video\/mp4)(;|$)/i.test(type))return reply.code(502).send({error:{message:'作品格式异常'}})
      for(const name of ['content-length','content-range','accept-ranges']){const value=upstream.headers.get(name);if(value)reply.header(name,value)}
      return reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff').type(type).code(upstream.status).send(Readable.fromWeb(upstream.body as any))
    } catch {return reply.code(502).send({error:{message:'作品读取失败，请稍后重试'}})}
  }
  app.get('/api/gallery',async(request)=>{
    const kind=String((request.query as any)?.kind||'')
    if(kind&&!['image','video'].includes(kind))throw Object.assign(new Error('作品类型无效'),{statusCode:400})
    const rows=await db.query<any>(`SELECT id,kind,gallery_title,gallery_featured,finished_at FROM media_tasks
      WHERE gallery_status='published' AND status='completed' AND result_url IS NOT NULL AND ($1='' OR kind=$1)
      ORDER BY gallery_featured DESC,finished_at DESC,id DESC LIMIT 60`,[kind])
    return {items:rows.map(row=>({id:row.id,kind:row.kind,title:row.gallery_title|| (row.kind==='video'?'视频作品':'图片作品'),featured:row.gallery_featured,createdAt:row.finished_at,assetUrl:'/api/gallery/'+encodeURIComponent(row.id)+'/asset'}))}
  })
  app.get('/api/gallery/:id/asset',async(request,reply)=>{
    const id=String((request.params as any).id)
    if(!/^[0-9a-f-]{36}$/i.test(id))return reply.code(404).send()
    const task=await db.one<any>("SELECT result_url FROM media_tasks WHERE id=$1 AND gallery_status='published' AND status='completed'",[id])
    if(!task?.result_url)return reply.code(404).send()
    if(task.result_url.startsWith('stored://')) {
      if(await sendStoredMedia(reply,id)) return
      return reply.code(404).send()
    }
    await mediaProxy(reply,task.result_url,request.headers.range)
    return
  })
  app.get('/api/admin/media/tasks/:id/result',async(request,reply)=>{
    if(!await requireAdmin(request,reply))return
    const id=String((request.params as any).id)
    if(!/^[0-9a-f-]{36}$/i.test(id))return reply.code(404).send()
    const task=await db.one<any>("SELECT result_url FROM media_tasks WHERE id=$1 AND status='completed'",[id])
    if(!task?.result_url)return reply.code(404).send()
    if(task.result_url.startsWith('stored://')) {
      if(await sendStoredMedia(reply,id)) return
      return reply.code(404).send()
    }
    await mediaProxy(reply,task.result_url,request.headers.range)
    return
  })
  app.get('/api/admin/media',async(request,reply)=>{
    if(!await requireAdmin(request,reply))return
    const [prices,tasks,channels]=await Promise.all([db.query('SELECT * FROM media_prices ORDER BY model,size'),db.query(`SELECT t.id,t.user_id,u.username,t.kind,t.model,t.status,t.result_url,t.gallery_status,t.gallery_featured,t.gallery_title,t.finished_at,t.charge_micros,t.actual_cost_micros,t.created_at,
        t.queue_started_at,t.next_attempt_at,t.submit_attempts,t.accepted_at,
        CASE WHEN t.last_retry_code IS NOT NULL THEN t.last_retry_code WHEN t.status='failed' THEN 'failed' ELSE NULL END AS error_category
        FROM media_tasks t JOIN users u ON u.id=t.user_id ORDER BY t.created_at DESC LIMIT 100`),db.query("SELECT id,name FROM channels WHERE deleted_at IS NULL AND base_url IN ('https://apihub.agnes-ai.com/v1','https://cdn.yyapi.cloud/v1','https://ripp.best/v1')")])
    return {prices,tasks,channels}
  })
  app.patch('/api/admin/media/tasks/:id/gallery',async(request,reply)=>{
    const actor=await requireAdmin(request,reply);if(!actor)return
    const id=String((request.params as any).id), body=request.body as any
    const status=String(body?.status||''), title=String(body?.title||'').trim()
    if(!['private','published','hidden'].includes(status))throw Object.assign(new Error('广场状态无效'),{statusCode:400})
    if(title.length>80)throw Object.assign(new Error('作品标题最多 80 字'),{statusCode:400})
    return db.tx(async client=>{
      const before=await client.query('SELECT id,status,result_url,gallery_status,gallery_featured,gallery_title FROM media_tasks WHERE id=$1 FOR UPDATE',[id])
      if(!before.rows.length)throw Object.assign(new Error('作品不存在'),{statusCode:404})
      if(status==='published'&&(before.rows[0].status!=='completed'||!before.rows[0].result_url))throw Object.assign(new Error('只有已完成作品可以发布'),{statusCode:400})
      const after=await client.query('UPDATE media_tasks SET gallery_status=$2,gallery_featured=CASE WHEN $2=\'published\' THEN $3 ELSE false END,gallery_title=$4,gallery_moderated_at=now(),gallery_moderated_by=$5 WHERE id=$1 RETURNING id,gallery_status,gallery_featured,gallery_title',[id,status,body?.featured===true,title||null,actor.id])
      await client.query("INSERT INTO config_audit_logs(actor_user_id,resource_type,resource_id,before_value,after_value) VALUES($1,'media_gallery',$2,$3,$4)",[actor.id,id,JSON.stringify(before.rows[0]),JSON.stringify(after.rows[0])])
      return {ok:true,item:after.rows[0]}
    })
  })
  app.post('/api/admin/media/prices',async(request,reply)=>{
    const actor=await requireAdmin(request,reply);if(!actor)return
    const b=request.body as any
    const normal=BigInt(yuanInput(b.normalCostYuan,'常规成本')),actual=BigInt(yuanInput(b.actualCostYuan,'实际成本'))
    const source=cleanText(b.costSource,'成本来源',512)
    if(!source)throw Object.assign(new Error('请填写已核实成本来源'),{statusCode:400})
    const rules=await profit.overview();mediaPrice(normal>actual?normal:actual,rules.walletTopupMultiplierBps,rules.paymentFeeRateBps,rules.affiliateRateBps,rules.minimumMarginBps)
    return db.tx(async client=>{
      const channel=await client.query("SELECT id,base_url FROM channels WHERE id=$1 AND deleted_at IS NULL AND base_url IN ('https://apihub.agnes-ai.com/v1','https://cdn.yyapi.cloud/v1','https://ripp.best/v1')",[b.channelId]);if(!channel.rows.length)throw Object.assign(new Error('请选择已允许的媒体渠道'),{statusCode:400})
      const expected=b.model==='gpt-image-2'?'https://cdn.yyapi.cloud/v1':b.model==='gpt-image-2.5'?'https://ripp.best/v1':'https://apihub.agnes-ai.com/v1';if(channel.rows[0].base_url!==expected)throw Object.assign(new Error('该规格与所选媒体渠道不匹配'),{statusCode:400})
      const before=await client.query('SELECT * FROM media_prices WHERE model=$1 AND size=$2 FOR UPDATE',[b.model,b.size]);if(!before.rows.length)throw Object.assign(new Error('模型规格无效'),{statusCode:400})
      const after=await client.query('UPDATE media_prices SET channel_id=$1,normal_cost_micros=$2,actual_cost_micros=$3,cost_source=$4,enabled=$5,updated_at=now() WHERE model=$6 AND size=$7 RETURNING *',[b.channelId,normal.toString(),actual.toString(),source,b.enabled===true,b.model,b.size])
      await client.query("INSERT INTO config_audit_logs(actor_user_id,resource_type,resource_id,before_value,after_value) VALUES($1,'media_price',$2,$3,$4)",[actor.id,b.model+':'+b.size,JSON.stringify(before.rows[0]),JSON.stringify(after.rows[0])]);return {ok:true}
    })
  })
  const health = async () => ({ ok: true, service: 'relay-station' })
  app.get('/healthz', health)
  app.get('/api/v1/health', health)
  app.get('/', async (_request, reply) => reply.sendFile('index.html'))
  app.get('/login', async (_request, reply) => reply.sendFile('index.html'))
  app.get('/register', async (_request, reply) => reply.sendFile('index.html'))
  app.get('/terms', async (_request, reply) => reply.sendFile('terms.html'))
  app.get('/privacy', async (_request, reply) => reply.sendFile('privacy.html'))
  app.get('/api/public/site', async () => {
    const settings = await db.query<any>(`SELECT key,value FROM app_settings WHERE key IN ('site_name','site_title','site_logo_url')`)
    const values = Object.fromEntries(settings.map((item) => [item.key, item.value]))
    return {
      name: values.site_name || 'GPT TOKEN',
      title: values.site_title || 'GPT TOKEN | OpenAI 兼容 API 控制台',
      logoUrl: values.site_logo_url || '/assets/gpt-token-mark-192.png',
      apiBaseUrl: `${config.publicBaseUrl.replace(/\/$/, '')}/v1`,
      walletTopupMultiplierBps: config.walletTopupMultiplierBps,
      enterpriseOffer: {
        code: 'enterprise',
        multiplierBps: config.enterpriseTopupMultiplierBps,
        minimumAmountMicros: String(config.enterpriseTopupMinimumMicros),
      },
    }
  })

  app.post('/api/auth/email-verification', { config: { rateLimit: { max: 3, timeWindow: '10 minutes' } } }, async (request, reply) => {
    try {
      if (!mail.configured) throw Object.assign(new Error('邮件服务尚未配置，请稍后再试'), { statusCode: 503 })
      const issued = await auth.issueRegistrationCode(String((request.body as any)?.email || ''))
      try {
        await mail.sendRegistrationCode(issued.email, issued.code)
      } catch (error) {
        await db.query(`UPDATE email_verification_challenges SET consumed_at=now() WHERE email=$1 AND purpose='registration' AND consumed_at IS NULL`, [issued.email])
        throw error
      }
      return { ok: true, expiresAt: issued.expiresAt }
    } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) }
  })

  app.post('/api/auth/register', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
      const body = (request.body || {}) as any
      const user = await auth.register(String(body.username || ''), String(body.password || ''), {
        email: String(body.email || ''), verificationCode: String(body.verificationCode || ''),
        inviteCode: body.inviteCode || body.invite, termsAccepted: body.termsAccepted === true,
      })
      issueSession(reply,user)
      return { user }
    } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) }
  })

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
      const body = (request.body || {}) as any
      const user = await auth.login(String(body.username || ''), String(body.password || ''))
      issueSession(reply,user)
      return { user }
    } catch (error) { reply.code(401).send({ error: { message: '账号或密码错误' } }) }
  })
  app.post('/api/auth/logout', async (_request, reply) => {
    // Match every attribute used when issuing the session cookie. Some
    // browsers keep a cookie with the same name when the Secure/SameSite
    // scope differs, which makes logout appear to succeed while the session
    // is still sent on the next request.
    reply.clearCookie('relay_session', {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.env === 'production',
      path: '/',
      expires: new Date(0),
      maxAge: 0,
    })
    return { ok: true }
  })
  app.get('/api/auth/session', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const user = await requireSession(request, reply, true)
    return { authenticated: Boolean(user), user }
  })
  app.get('/api/auth/me', async (request, reply) => { const user = await requireSession(request, reply); return user ? { user } : undefined })

  app.patch('/api/me/password', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const user = await requireSession(request, reply); if (!user) return
    try {
      const body = (request.body || {}) as any
      const currentPassword = String(body.currentPassword || '')
      const newPassword = String(body.newPassword || '')
      const confirmPassword = String(body.confirmPassword || '')
      if (!currentPassword) throw Object.assign(new Error('请输入当前密码'), { statusCode: 400 })
      if (newPassword !== confirmPassword) throw Object.assign(new Error('两次输入的新密码不一致'), { statusCode: 400 })
      await auth.changePassword(user.id, currentPassword, newPassword)
      return { ok: true }
    } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) }
  })

  app.get('/api/me/overview', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    const user = await requireSession(request, reply); if (!user) return
    const day = shanghaiDayBounds()
    const [balance, discount, globalDiscount, totals, todayUsage, modelPrices, profitOverview] = await Promise.all([
      billing.balance(user.id),
      db.one<any>('SELECT token_discount_bps FROM users WHERE id = $1', [user.id]),
      db.one<any>("SELECT value FROM app_settings WHERE key='global_token_discount_bps'"),
      db.one<any>(`SELECT
        (SELECT COALESCE(SUM(wl.amount_micros),0)::text FROM wallet_ledger wl WHERE wl.user_id=$1 AND wl.kind='wallet_topup') AS total_topup_credit_micros,
        (SELECT COALESCE(SUM(COALESCE(o.paid_amount_micros,o.amount_micros)),0)::text FROM orders o WHERE o.user_id=$1 AND o.kind='wallet_topup' AND o.status='paid') AS total_topup_paid_micros,
        (SELECT COALESCE(SUM(COALESCE(o.paid_amount_micros,o.amount_micros)),0)::text FROM orders o WHERE o.user_id=$1 AND o.kind IN ('wallet_topup','subscription','subscription_purchase') AND o.status='paid') AS total_paid_micros`, [user.id]),
      db.one<any>(`SELECT COUNT(*)::text AS requests,
        COALESCE(SUM(charge_micros) FILTER (WHERE status <> 'pending'),0)::text AS charge_micros
        FROM usage_logs WHERE user_id=$1 AND started_at >= $2 AND started_at < $3`, [user.id, day.from, day.to]),
      db.query<any>(`SELECT model_pattern,active,
        input_sell_micros,input_sell_micros_per_million,
        output_sell_micros,output_sell_micros_per_million,
        cache_sell_micros,cache_sell_micros_per_million,
        cache_write_sell_micros,cache_write_sell_micros_per_million,
        pricing_tiers
        FROM model_prices WHERE model_pattern = ANY($1::text[])`, [PRICE_COMPARISON_MODELS.map((item) => item.id)]),
      profit.overview(),
    ])
    const discountBps = Math.max(0, Math.min(9900, Number(discount?.token_discount_bps || 0)))
    const globalDiscountBps = Math.max(0, Math.min(9900, Number(globalDiscount?.value || 0)))
    const nightDiscount = nightDiscountView(profitOverview, discountBps, globalDiscountBps)
    const effectiveTokenDiscountBps = nightDiscount.effectiveTokenDiscountBps
    const totalTopupCreditMicros = String(totals?.total_topup_credit_micros || '0')
    const totalTopupPaidMicros = String(totals?.total_topup_paid_micros || '0')
    const totalPaidMicros = String(totals?.total_paid_micros || '0')
    return {
      user, balance: BillingService.formatBalance(balance),
      history: {
        totalTopupCreditMicros: totalTopupCreditMicros,
        totalTopupCredit: formatMicros(BigInt(totalTopupCreditMicros)),
        totalTopupPaidMicros: totalTopupPaidMicros,
        totalTopupPaid: formatMicros(BigInt(totalTopupPaidMicros)),
        totalPaidMicros: totalPaidMicros,
        totalPaid: formatMicros(BigInt(totalPaidMicros)),
      },
      tokenDiscountBps: discountBps, tokenDiscountPercent: discountBps / 100,
      effectiveTokenDiscountBps,
      nightDiscount,
      todayUsage: {
        timezone: 'Asia/Shanghai',
        from: day.from.toISOString(),
        to: day.to.toISOString(),
        requests: Number(todayUsage?.requests || 0),
        chargeMicros: String(todayUsage?.charge_micros || '0'),
      },
      enterpriseOffer: {
        code: 'enterprise',
        multiplierBps: config.enterpriseTopupMultiplierBps,
        minimumAmountMicros: String(config.enterpriseTopupMinimumMicros),
      },
      modelPriceComparison: buildModelPriceComparison(modelPrices, effectiveTokenDiscountBps, config.walletTopupMultiplierBps),
      walletTopupMultiplierBps: config.walletTopupMultiplierBps, apiBaseUrl: `${config.publicBaseUrl}/v1`, downloads: { chatgpt: config.chatgptDownloadUrl, ccswitch: config.ccswitchDownloadUrl }, mailConfigured: mail.configured,
    }
  })
  app.get('/api/me/enterprise-site-lead', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    const user = await requireSession(request, reply); if (!user) return
    const row = await db.one<any>(`SELECT id,user_id,contact_name,contact_method,desired_site_name,note,created_at,updated_at
      FROM enterprise_site_leads WHERE user_id=$1`, [user.id])
    return { item: publicEnterpriseLead(row) }
  })
  app.post('/api/me/enterprise-site-lead', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    const user = await requireSession(request, reply); if (!user) return
    try {
      const input = normalizeEnterpriseLeadInput(request.body)
      const row = await db.one<any>(`INSERT INTO enterprise_site_leads(user_id,contact_name,contact_method,desired_site_name,note)
        VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(user_id) DO UPDATE SET
          contact_name=excluded.contact_name,contact_method=excluded.contact_method,
          desired_site_name=excluded.desired_site_name,note=excluded.note,updated_at=now()
        RETURNING id,user_id,contact_name,contact_method,desired_site_name,note,created_at,updated_at`,
      [user.id, input.contactName, input.contactMethod, input.desiredSiteName, input.note])
      return { item: publicEnterpriseLead(row) }
    } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) }
  })
  app.get('/api/admin/enterprise-leads', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    reply.header('Cache-Control', 'private, no-store')
    const limit = boundedLimit((request.query as any)?.limit, 100, 500)
    const rows = await db.query<any>(`SELECT l.id,l.user_id,l.contact_name,l.contact_method,l.desired_site_name,l.note,
      l.created_at,l.updated_at,u.username,u.email
      FROM enterprise_site_leads l JOIN users u ON u.id=l.user_id
      ORDER BY l.updated_at DESC,l.id DESC LIMIT $1`, [limit])
    return { items: rows.map((row) => publicEnterpriseLead(row)) }
  })
  app.get('/api/me/balance', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    const user = await requireSession(request, reply); if (!user) return
    return { data: BillingService.formatBalance(await billing.balance(user.id)) }
  })
  app.post('/api/admin/users/:userId/subscription/reset', async (request, reply) => {
    const actor = await requireAdmin(request, reply); if (!actor) return
    try {
      const result = await billing.resetSubscription(String((request.params as any).userId || ''), actor.id)
      // Fastify's JSON serializer cannot encode bigint values. Expose exact
      // micro-yuan fields as strings and human-readable yuan values alongside
      // them, matching the balance and usage API contracts.
      return {
        ...result,
        beforeRemainingMicros: result.beforeRemainingMicros.toString(),
        afterRemainingMicros: result.afterRemainingMicros.toString(),
        quotaCapMicros: result.quotaCapMicros.toString(),
        beforeRemaining: formatMicros(result.beforeRemainingMicros),
        afterRemaining: formatMicros(result.afterRemainingMicros),
        quotaCap: formatMicros(result.quotaCapMicros),
      }
    } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) }
  })
  app.get('/api/me/keys', async (request, reply) => { const user = await requireSession(request, reply); return user ? { items: await auth.listApiKeys(user.id) } : undefined })
  app.post('/api/me/keys', async (request, reply) => {
    const user = await requireSession(request, reply); if (!user) return
    try { return { key: await auth.createApiKey(user.id, String((request.body as any)?.name || '')) } } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) }
  })
  app.post('/api/me/keys/:id/reveal', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const user = await requireSession(request, reply); if (!user) return
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').header('X-Content-Type-Options', 'nosniff')
    try {
      const key = await auth.revealApiKey(user.id, String((request.params as any).id), String((request.body as any)?.password || ''))
      await db.query('INSERT INTO api_key_reveal_audits(user_id,key_id) VALUES($1,$2)', [user.id, key.id])
      return { id: key.id, name: key.name, key: key.rawKey }
    } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) }
  })
  app.delete('/api/me/keys/:id', async (request, reply) => { const user = await requireSession(request, reply); if (!user) return; await auth.revokeApiKey(user.id, String((request.params as any).id)); return { ok: true } })
  app.post('/api/me/keys/:id/ccswitch', async (request, reply) => {
    const user = await requireSession(request, reply); if (!user) return
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').header('X-Content-Type-Options', 'nosniff').header('Content-Type', 'application/json')
    try {
      const key = await auth.getApiKeyForImport(user.id, String((request.params as any).id))
      // Keep an audit trail for every explicit decryption path without ever
      // storing the API key or generated deep link in PostgreSQL or logs.
      await db.query('INSERT INTO api_key_reveal_audits(user_id,key_id) VALUES($1,$2)', [user.id, key.id])
      return {
        link: buildCcswitchImportLink({
          apiKey: key.rawKey,
          name: key.name,
          endpoint: `${config.publicBaseUrl}/v1`,
          homepage: config.publicBaseUrl,
        }),
        endpoint: `${config.publicBaseUrl}/v1`,
        keyName: key.name,
        downloadUrl: config.ccswitchDownloadUrl,
      }
    } catch (error) {
      reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } })
    }
  })

  app.get('/api/me/usage', async (request, reply) => {
    const user = await requireSession(request, reply); if (!user) return
    try {
      const q = (request.query || {}) as any
      const limit = boundedLimit(q.limit)
      const cursor = decodeCursor(q.cursor)
      if (q.cursor && !cursor) throw new Error('分页游标无效')
      const filterValues: unknown[] = [user.id]
      const filterWhere = ['u.user_id = $1']
      filterValues.push(q.from ? dateFilter(q.from) : new Date(Date.now() - 30 * 86400_000))
      filterWhere.push(`u.started_at >= $${filterValues.length}`)
      if (q.to) { filterValues.push(dateFilter(q.to, true)); filterWhere.push(`u.started_at < $${filterValues.length}`) }
      if (q.model) { filterValues.push(String(q.model)); filterWhere.push(`u.requested_model = $${filterValues.length}`) }
      if (q.keyId) { filterValues.push(uuidFilter(q.keyId, 'API Key')); filterWhere.push(`COALESCE(u.api_key_id, u.key_id) = $${filterValues.length}`) }
      if (q.status === 'success' || q.status === 'failed' || q.status === 'canceled' || q.status === 'rejected') {
        filterValues.push(String(q.status)); filterWhere.push(`u.status = $${filterValues.length}`)
      }
      const values = [...filterValues]
      const where = [...filterWhere]
      const adminFinanceSelect = user.role === 'admin' ? ', u.cost_micros, u.profit_micros' : ''
      if (cursor) { values.push(new Date(cursor.t), cursor.id); where.push(`(u.started_at, u.request_id) < ($${values.length - 1}, $${values.length})`) }
      const rows = await db.query<any>(`SELECT
          u.created_at, u.started_at, u.request_id, u.request_path, u.api_key_id, u.key_id,
          u.api_key_name_snapshot, u.requested_model, u.upstream_model,
          u.final_channel_id, u.final_channel_name_snapshot,
          u.input_tokens, u.output_tokens, u.cache_tokens, u.cache_write_tokens, u.reported_total_tokens,
          u.plan_charge_micros, u.wallet_charge_micros, u.charge_micros ${adminFinanceSelect},
          u.status_code, u.status, u.success, u.duration_ms, u.latency_ms,
          u.is_estimated_usage, u.estimated_usage, u.error_code, u.error_summary,
          k.name AS current_key_name, c.name AS current_channel_name
        FROM usage_logs u
        LEFT JOIN api_keys k ON k.id = COALESCE(u.api_key_id, u.key_id)
        LEFT JOIN channels c ON c.id = u.final_channel_id
        WHERE ${where.join(' AND ')} ORDER BY u.started_at DESC, u.request_id DESC LIMIT ${limit + 1}`, values)
      const items = rows.slice(0, limit).map((row) => ({
        time: row.started_at || row.created_at, requestId: row.request_id,
        keyId: row.api_key_id || row.key_id, keyName: row.api_key_name_snapshot || row.current_key_name || '',
        model: row.requested_model, upstreamModel: user.role === 'admin' ? row.upstream_model : row.requested_model,
        channel: user.role !== 'admin' && row.request_path === '/v1/site-chat' ? 'AI 对话' : row.final_channel_name_snapshot || row.current_channel_name || '',
        inputTokens: String(row.input_tokens), outputTokens: String(row.output_tokens), cacheTokens: String(row.cache_tokens), cacheWriteTokens: String(row.cache_write_tokens || 0), totalTokens: String(row.reported_total_tokens),
        planCharge: publicMoney(row.plan_charge_micros), walletCharge: publicMoney(row.wallet_charge_micros), charge: publicMoney(row.charge_micros),
        statusCode: row.status_code, status: row.status, success: row.success,
        errorCode: row.error_code || null, errorSummary: row.error_summary || null,
        billingNote: row.success ? null : (BigInt(String(row.charge_micros || 0)) > 0n ? '请求失败但已产生可计费用量' : '请求失败，未产生收费'),
        latencyMs: Number(row.duration_ms ?? row.latency_ms ?? 0), estimatedUsage: Boolean(row.is_estimated_usage ?? row.estimated_usage),
        ...(user.role === 'admin' ? { estimatedCost: publicMoney(row.cost_micros), profit: publicMoney(row.profit_micros) } : {}),
      }))
      const nextCursor = rows.length > limit ? encodeCursor(rows[limit - 1].started_at || rows[limit - 1].created_at, rows[limit - 1].request_id) : null
      const summary = await db.one<any>(`SELECT count(*)::int AS requests,
        COALESCE(sum(charge_micros),0)::bigint AS charge,
        COALESCE(sum(plan_charge_micros),0)::bigint AS plan_charge,
        COALESCE(sum(wallet_charge_micros),0)::bigint AS wallet_charge
        ${user.role === 'admin' ? ', COALESCE(sum(cost_micros),0)::bigint AS cost, COALESCE(sum(profit_micros),0)::bigint AS profit' : ''},
        COALESCE(sum(input_tokens),0)::bigint AS input,
        COALESCE(sum(output_tokens),0)::bigint AS output,
        COALESCE(sum(cache_tokens),0)::bigint AS cache,
        COALESCE(sum(cache_write_tokens),0)::bigint AS cache_write
        FROM usage_logs u WHERE ${filterWhere.join(' AND ')}`, filterValues)
      return { items, nextCursor, summary: {
        requests: Number(summary?.requests || 0), charge: publicMoney(summary?.charge),
        planCharge: publicMoney(summary?.plan_charge), walletCharge: publicMoney(summary?.wallet_charge),
        inputTokens: String(summary?.input || 0), outputTokens: String(summary?.output || 0), cacheTokens: String(summary?.cache || 0), cacheWriteTokens: String(summary?.cache_write || 0),
        ...(user.role === 'admin' ? { estimatedCost: publicMoney(summary?.cost), profit: publicMoney(summary?.profit) } : {}),
      } }
    } catch (error) {
      reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } })
    }
  })

  app.get('/api/me/affiliate', async (request, reply) => { const user = await requireSession(request, reply); return user ? await affiliate.overview(user.id) : undefined })
  app.post('/api/me/affiliate/convert', async (request, reply) => {
    const user = await requireSession(request, reply); if (!user) return
    try {
      const rawAmount = (request.body as any)?.amountMicros
      const amount = rawAmount === undefined ? undefined : BigInt(moneyInput(rawAmount, '兑换金额'))
      return await affiliate.convert(user.id, amount)
    } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) }
  })

  app.get('/api/downloads', async () => ({ chatgpt: config.chatgptDownloadUrl, ccswitch: config.ccswitchDownloadUrl, apiBaseUrl: `${config.publicBaseUrl}/v1` }))

  app.get('/api/plans', async () => ({ items: await db.query<any>(`SELECT id, code, name, price_micros, quota_micros, reset_grant_limit,
    quota_micros * reset_grant_limit AS total_quota_micros
    FROM plans WHERE active = true AND enabled = true ORDER BY price_micros ASC`) }))
  app.post('/api/orders', async (request, reply) => {
    const user = await requireSession(request, reply); if (!user) return
    let created: Awaited<ReturnType<OrderService['create']>> | null = null
    try {
      const body = (request.body || {}) as any
      const kind = body.kind === 'subscription' ? 'subscription' : 'wallet_topup'
      const method = normalizeNewOrderPaymentMethod(body.paymentMethod)
      const planId = kind === 'subscription' ? String(body.planId || '') : null
      const offerCode = body.offerCode
      if (kind === 'subscription' && !planId) throw new Error('请选择套餐')
      let amountMicros: bigint | undefined
      if (kind === 'wallet_topup') {
        try { amountMicros = BigInt(String(body.amountMicros ?? body.amount ?? 0)) } catch { throw new Error('金额格式无效') }
      }
      created = await orders.create(user.id, { kind, amountMicros, planId, paymentMethod: method, offerCode })
      const gateway = await optionalPaymentGateway(config)
      if (!gateway) throw Object.assign(new Error('支付渠道尚未配置'), { statusCode: 503 })
      const native = await gateway.createNativeOrder({ orderId: created.orderNo, description: kind === 'subscription' ? 'GPT TOKEN 月套餐' : created.topupOfferCode === 'enterprise' ? 'GPT TOKEN 企业钱包充值' : 'GPT TOKEN 钱包充值', amountMicros: created.amountMicros.toString(), paymentMethod: method, expiresAt: created.expiresAt })
      await orders.attachNativePayment(created.id, { providerOrderId: native.providerOrderId, codeUrl: native.codeUrl })
      let qrImage: string | undefined
      try {
        qrImage = await QRCode.toDataURL(native.codeUrl, {
          errorCorrectionLevel: 'M', margin: 1, width: 300,
          color: { dark: '#10212b', light: '#ffffffff' },
        })
      } catch {
        // The original provider URL remains usable when local QR rendering is unavailable.
      }
      reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
      return {
        orderId: created.id,
        orderNo: created.orderNo,
        status: 'pending',
        amount: publicMoney(created.amountMicros),
        walletCreditAmount: created.walletCreditMicros === null ? null : publicMoney(created.walletCreditMicros),
        topupMultiplierBps: created.topupMultiplierBps,
        offerCode: created.topupOfferCode,
        payment: { ...native, ...(qrImage ? { qrImage } : {}) },
      }
    } catch (error) {
      if (created) await orders.markCreationFailure(created.id, String((error as Error)?.message || 'payment_create_failed')).catch(() => undefined)
      reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } })
    }
  })

  app.post('/api/payments/wechat/notify', async (request, reply) => {
    const rawBody = rawRequestBody(request)
    try {
      const gateway = await optionalPaymentGateway(config)
      if (!gateway) throw new Error('微信支付尚未配置')
      const verified = await gateway.verifyCallback('wechat', request.headers as any, rawBody)
      const result = await orders.applyVerifiedCallback(verified)
      reply.type('application/json').send({ code: 'SUCCESS', message: result.accepted ? (result.alreadyProcessed ? '已处理' : '成功') : '已拒绝' })
    } catch (error) {
      // Never echo or log the signed body. Providers retry non-successful
      // notifications, so verification/settlement failures remain explicit.
      reply.code(errorStatus(error)).type('application/json').send({ code: 'FAIL', message: (error as Error).message || '回调处理失败' })
    }
  })

  app.post('/api/payments/alipay/notify', async (request, reply) => {
    const rawBody = rawRequestBody(request)
    try {
      const gateway = await optionalPaymentGateway(config)
      if (!gateway) throw new Error('支付宝支付尚未配置')
      const verified = await gateway.verifyCallback('alipay', request.headers as any, rawBody)
      await orders.applyVerifiedCallback(verified)
      reply.type('text/plain').send('success')
    } catch (error) {
      reply.code(errorStatus(error)).type('text/plain').send('fail')
    }
  })

  app.get('/api/orders', async (request, reply) => { const user = await requireSession(request, reply); return user ? { items: await db.query<any>('SELECT id, order_no, kind, amount_micros, paid_amount_micros, wallet_credit_micros, topup_multiplier_bps, topup_offer_code, payment_method, status, qr_code_url, created_at, paid_at, expires_at FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [user.id]) } : undefined })
  app.get('/api/me/orders/:id', async (request, reply) => {
    const user = await requireSession(request, reply); if (!user) return
    const id = String((request.params as any).id || '')
    let row = await db.one<any>('SELECT id,order_no,kind,amount_micros,paid_amount_micros,wallet_credit_micros,topup_multiplier_bps,topup_offer_code,payment_method,payment_provider,status,qr_code_url,provider_order_id,created_at,paid_at,expires_at,closed_at,failure_code,plan_name_snapshot,plan_quota_micros,plan_duration_days FROM orders WHERE id=$1 AND user_id=$2', [id, user.id])
    if (!row) { reply.code(404).send({ error: { message: '订单不存在' } }); return }
    // A callback may be delayed or missed. The customer poll is a fast,
    // rate-limited recovery path; the worker remains the background fallback.
    if (row.status === 'pending' && (row.payment_provider === 'wechat_native' || row.payment_method === 'wechat')) {
      const acquired = await redis.setNx(`payment-order-query:${id}`, '1', 4)
      if (acquired) {
        try {
          const gateway = await optionalPaymentGateway(config)
          if (gateway) await orders.applyQueriedPayment(id, await gateway.queryNativeOrder(String(row.order_no), 'wechat'))
        } catch {
          // A transient provider query must leave the order pending.
        }
      }
    }
    await orders.reconcileCredit(id)
    row = await db.one<any>('SELECT id,order_no,kind,amount_micros,paid_amount_micros,wallet_credit_micros,topup_multiplier_bps,topup_offer_code,payment_method,payment_provider,status,qr_code_url,provider_order_id,created_at,paid_at,expires_at,closed_at,failure_code,plan_name_snapshot,plan_quota_micros,plan_duration_days FROM orders WHERE id=$1 AND user_id=$2', [id, user.id])
    const credit = await orders.getCreditState(id, user.id)
    return { ...row, ...credit, amount: publicMoney(row.amount_micros), paidAmount: row.paid_amount_micros ? publicMoney(row.paid_amount_micros) : null, walletCreditAmount: row.wallet_credit_micros ? publicMoney(row.wallet_credit_micros) : null }
  })
  app.get('/api/me/billing/:requestId', async (request, reply) => {
    const user = await requireSession(request, reply); if (!user) return
    const row = await db.one<any>('SELECT request_id,requested_model,upstream_model,final_channel_name_snapshot,input_tokens,output_tokens,cache_tokens,cache_write_tokens,reported_total_tokens,plan_charge_micros,wallet_charge_micros,charge_micros,status,success,status_code,is_estimated_usage,error_code,error_summary,started_at,finished_at FROM usage_logs WHERE request_id=$1 AND user_id=$2', [String((request.params as any).requestId || ''), user.id])
    if (!row) { reply.code(404).send({ error: { message: '账单记录不存在' } }); return }
    if (user.role !== 'admin') row.upstream_model = row.requested_model
    return { ...row, charge: publicMoney(row.charge_micros), planCharge: publicMoney(row.plan_charge_micros), walletCharge: publicMoney(row.wallet_charge_micros), billingNote: row.success ? (row.is_estimated_usage ? '本次用量由系统估算，后续可能按上游实际用量校正' : '按上游实际用量结算') : (Number(row.charge_micros) > 0 ? '请求失败但已产生可计费用量' : '请求失败，未产生收费') }
  })
  app.get('/api/me/onboarding', async (request, reply) => {
    const user = await requireSession(request, reply); if (!user) return
    const [key, usage] = await Promise.all([db.one<any>('SELECT id FROM api_keys WHERE user_id=$1 AND revoked_at IS NULL LIMIT 1', [user.id]), db.one<any>('SELECT request_id,status,success,started_at FROM usage_logs WHERE user_id=$1 ORDER BY started_at DESC LIMIT 1', [user.id])])
    return { steps: { keyCreated: Boolean(key), firstRequest: Boolean(usage), firstRequestSuccess: Boolean(usage?.success) }, completed: Boolean(key && usage?.success) }
  })

  app.get('/api/admin/channels', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    const force = String((request.query as any)?.refreshBalance || '') === '1'
    const [items, alerts, balances] = await Promise.all([channels.allForAdmin(), fallbackCostAlerts(db), channels.upstreamBalances(force)])
    return { items: items.map(item => ({ ...item, upstreamBalance: balances[item.id], fallbackCostPending: alerts.some(alert => alert.resource_id === item.id) })) }
  })

  app.get('/api/admin/overview', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    const q = (request.query || {}) as any
    const from = q.from ? dateFilter(q.from) : new Date(Date.now() - 24 * 60 * 60 * 1000)
    const to = q.to ? dateFilter(q.to, true) : new Date()
    const [usage, orders, fees, alerts, channelsSummary, costAlerts] = await Promise.all([
      db.one<any>(`SELECT count(*)::int AS requests, COALESCE(sum(charge_micros),0)::bigint AS revenue,
        COALESCE(sum(cost_micros),0)::bigint AS cost, COALESCE(sum(profit_micros),0)::bigint AS gross_profit,
        COALESCE(sum(CASE WHEN success THEN 0 ELSE charge_micros END),0)::bigint AS failed_charge,
        COALESCE(avg(duration_ms) FILTER (WHERE success),0)::numeric AS avg_latency,
        count(*) FILTER (WHERE ${pendingFallbackCostSql})::int AS pending_cost_requests
        FROM usage_logs WHERE started_at >= $1 AND started_at < $2`, [from, to]),
      db.one<any>(`SELECT COALESCE(sum(CASE WHEN status='paid' THEN amount_micros ELSE 0 END),0)::bigint AS paid,
        count(*) FILTER (WHERE status='paid')::int AS paid_orders FROM orders WHERE created_at >= $1 AND created_at < $2`, [from, to]),
      db.one<any>(`SELECT COALESCE(sum(commission_micros),0)::bigint AS rebates FROM affiliate_commissions WHERE created_at >= $1 AND created_at < $2`, [from, to]),
      db.query<any>(`SELECT id,kind,severity,message,status,created_at FROM risk_alerts WHERE status <> 'resolved' ORDER BY severity DESC,created_at DESC LIMIT 50`),
      db.query<any>(`SELECT c.id,c.name,c.enabled,c.failure_count,c.last_success_at,c.last_failure_at,c.circuit_open_until,
        COALESCE(x.requests,0)::int AS requests,COALESCE(x.failures,0)::int AS failures
        FROM channels c LEFT JOIN (SELECT final_channel_id,count(*) AS requests,count(*) FILTER(WHERE NOT success) AS failures FROM usage_logs WHERE started_at >= $1 AND started_at < $2 GROUP BY final_channel_id) x ON x.final_channel_id=c.id WHERE c.deleted_at IS NULL ORDER BY c.priority,c.name`, [from, to]),
      fallbackCostAlerts(db),
    ])
    const revenue = BigInt(String(usage?.revenue || 0)); const cost = BigInt(String(usage?.cost || 0)); const rebates = BigInt(String(fees?.rebates || 0))
    const net = revenue - cost - rebates
    return { period: { from: from.toISOString(), to: to.toISOString() }, minimumMarginBps: await settingInt(db, 'profit_min_margin_bps', 5000), globalDiscountBps: await settingInt(db, 'global_token_discount_bps', 0), metrics: {
      requests: Number(usage?.requests || 0), revenue: publicMoney(revenue), cost: publicMoney(cost), grossProfit: publicMoney(revenue - cost), rebates: publicMoney(rebates), netProfit: publicMoney(net), paidOrders: Number(orders?.paid_orders || 0), paid: publicMoney(orders?.paid), failedCharge: publicMoney(usage?.failed_charge), avgLatencyMs: Number(usage?.avg_latency || 0),
      pendingCostRequests: Number(usage?.pending_cost_requests || 0),
    }, alerts: [...costAlerts, ...alerts], channels: channelsSummary }
  })

  app.get('/api/admin/profit', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    const q = (request.query || {}) as any
    const from = q.from ? dateFilter(q.from) : new Date(Date.now() - 30 * 86400_000); const to = q.to ? dateFilter(q.to, true) : new Date()
    const rows = await db.query<any>(`SELECT requested_model AS model, COALESCE(final_channel_name_snapshot,'—') AS channel,
      count(*)::int AS requests,COALESCE(sum(charge_micros),0)::bigint AS revenue,COALESCE(sum(cost_micros),0)::bigint AS cost,COALESCE(sum(profit_micros),0)::bigint AS profit,
      count(*) FILTER (WHERE ${pendingFallbackCostSql})::int AS pending_cost_requests
      FROM usage_logs WHERE started_at >= $1 AND started_at < $2 GROUP BY requested_model,final_channel_name_snapshot ORDER BY profit ASC LIMIT 500`, [from, to])
    return { from: from.toISOString(), to: to.toISOString(), items: rows.map((r) => ({ ...r, revenue: publicMoney(r.revenue), cost: publicMoney(r.cost), profit: publicMoney(r.profit), marginBps: Number(r.revenue) ? Number((BigInt(String(r.profit)) * 10000n) / BigInt(String(r.revenue))) : 0 })) }
  })
  app.get('/api/admin/profit/subscriptions', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    const q = (request.query || {}) as any
    const from = q.from ? dateFilter(q.from) : new Date(Date.now() - 30 * 86400_000)
    const to = q.to ? dateFilter(q.to, true) : new Date()
    const [usage, purchases] = await Promise.all([
      db.one<any>(`SELECT count(*) FILTER (WHERE plan_charge_micros > 0)::int AS requests,
        COALESCE(sum(plan_charge_micros),0)::bigint AS consumed,
        COALESCE(sum(CASE WHEN charge_micros > 0 THEN (cost_micros * plan_charge_micros) / charge_micros ELSE 0 END),0)::bigint AS allocated_cost
        FROM usage_logs WHERE started_at >= $1 AND started_at < $2`, [from, to]),
      db.one<any>(`SELECT count(*)::int AS orders,
        COALESCE(sum(COALESCE(paid_amount_micros,amount_micros)),0)::bigint AS paid,
        COALESCE(sum(plan_quota_micros),0)::bigint AS purchased_quota
        FROM orders WHERE status='paid' AND kind IN ('subscription','subscription_purchase') AND COALESCE(paid_at,created_at) >= $1 AND COALESCE(paid_at,created_at) < $2`, [from, to]),
    ])
    const consumed = BigInt(String(usage?.consumed || 0)); const allocatedCost = BigInt(String(usage?.allocated_cost || 0))
    return {
      from: from.toISOString(), to: to.toISOString(),
      purchases: { orders: Number(purchases?.orders || 0), paid: publicMoney(purchases?.paid), purchasedQuota: publicMoney(purchases?.purchased_quota) },
      usage: { requests: Number(usage?.requests || 0), consumed: publicMoney(consumed), allocatedCost: publicMoney(allocatedCost), estimatedProfit: publicMoney(consumed - allocatedCost), marginBps: consumed > 0n ? Number((consumed - allocatedCost) * 10000n / consumed) : 0 },
      note: '套餐不套用钱包充值倍率；成本按套餐额度实际结算记录，混合钱包/套餐请求按本次套餐扣款占比分摊。',
    }
  })
  app.get('/api/admin/profit/export', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    const q = (request.query || {}) as any
    const from = q.from ? dateFilter(q.from) : new Date(Date.now() - 30 * 86400_000); const to = q.to ? dateFilter(q.to, true) : new Date()
    const rows = await db.query<any>(`SELECT started_at,requested_model,COALESCE(final_channel_name_snapshot,'') AS channel,charge_micros,cost_micros,profit_micros,status,${pendingFallbackCostSql} AS pending_cost FROM usage_logs WHERE started_at >= $1 AND started_at < $2 ORDER BY started_at DESC LIMIT 10000`, [from, to])
    const csv = ['时间,模型,渠道,收入,成本,利润,状态,成本说明', ...rows.map((r) => [r.started_at, r.requested_model, r.channel, formatMicros(BigInt(String(r.charge_micros))), formatMicros(BigInt(String(r.cost_micros))), formatMicros(BigInt(String(r.profit_micros))), r.status, r.pending_cost ? '兜底成本待核实，利润为估算' : '按历史成本快照'].map((v) => `"${String(v ?? '').replaceAll('"', '""')}"`).join(','))].join('\n')
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="relay-profit.csv"').send(`\uFEFF${csv}`)
  })

  app.get('/api/admin/risk-alerts', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    const [alerts, costAlerts] = await Promise.all([db.query<any>(`SELECT * FROM risk_alerts WHERE status <> 'resolved' ORDER BY created_at DESC LIMIT 200`), fallbackCostAlerts(db)])
    return { items: [...costAlerts, ...alerts] }
  })
  app.get('/api/admin/channel-costs', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    return new ChannelCostService(db).list()
  })
  app.post('/api/admin/channel-costs', async (request, reply) => {
    const actor = await requireAdmin(request, reply); if (!actor) return
    try {
      return await new ChannelCostService(db).save(request.body || {}, actor.id)
    } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) }
  })
  app.get('/api/admin/pricing/preview', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    try {
      const current = await profit.overview()
      const requestedMargin = (request.query as any)?.minimumMarginBps
      const minimumMarginBps = requestedMargin === undefined ? current.minimumMarginBps : Number(requestedMargin)
      if (!Number.isInteger(minimumMarginBps) || minimumMarginBps < 0 || minimumMarginBps > 9999) throw new Error('最低毛利必须为 0-9999 基点')
      const rules: PricingRules = {
        minimumMarginBps,
        paymentFeeRateBps: current.paymentFeeRateBps,
        affiliateRateBps: current.affiliateRateBps,
        walletTopupMultiplierBps: current.walletTopupMultiplierBps,
      }
      return await new ChannelCostService(db).pricingPreview(rules)
    } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) }
  })
  app.post('/api/admin/pricing/publish', async (request, reply) => {
    const actor = await requireAdmin(request, reply); if (!actor) return
    try {
      const body = (request.body || {}) as any
      if (body.confirm !== true) throw Object.assign(new Error('价格发布需要 confirm=true；请先检查预览中的渠道成本缺失项'), { statusCode: 400 })
      const current = await profit.overview()
      const minimumMarginBps = Number(body.minimumMarginBps ?? 5000)
      if (!Number.isInteger(minimumMarginBps) || minimumMarginBps < 0 || minimumMarginBps > 9999) throw new Error('最低毛利必须为 0-9999 基点')
      const rules: PricingRules = { minimumMarginBps, paymentFeeRateBps: current.paymentFeeRateBps, affiliateRateBps: current.affiliateRateBps, walletTopupMultiplierBps: current.walletTopupMultiplierBps }
      return await new ChannelCostService(db).publishPricing(rules, actor.id)
    } catch (error: any) {
      reply.code(errorStatus(error)).send({ error: { message: error.message }, ...(error.pricingPreview ? { pricingPreview: error.pricingPreview } : {}) })
    }
  })
  app.post('/api/admin/channels', async (request, reply) => { if (!await requireAdmin(request, reply)) return; try { return await channels.upsert(request.body as any) } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) } })
  app.delete('/api/admin/channels/:id', async (request, reply) => { const actor = await requireAdmin(request, reply); if (!actor) return; await channels.remove(String((request.params as any).id), actor.id); return { ok: true } })
  app.delete('/api/admin/channels/:id/archive', async (request, reply) => { const actor = await requireAdmin(request, reply); if (!actor) return; await channels.archive(String((request.params as any).id), actor.id); return { ok: true } })
  app.get('/api/admin/prices', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    const items = await db.query<any>('SELECT * FROM model_prices ORDER BY model_pattern')
    const rules = await profit.overview()
    return { items, minimumMarginBps: rules.minimumMarginBps, minimumMarginPercent: rules.minimumMarginBps / 100, walletTopupMultiplierBps: rules.walletTopupMultiplierBps, paymentFeeRateBps: rules.paymentFeeRateBps, affiliateRateBps: rules.affiliateRateBps }
  })
  app.post('/api/admin/prices', async (request, reply) => {
    const actor = await requireAdmin(request, reply); if (!actor) return
    try {
      const b = (request.body || {}) as any
      const pattern = cleanText(b.modelPattern || '*', '模型匹配', 256)
      const value = (yuanName: string, microsName: string, label: string) => (
        b[yuanName] !== undefined ? yuanInput(b[yuanName], label) : moneyInput(b[microsName] ?? 0, label)
      )
      const values = [
        pattern,
        value('inputCostYuanPerMillion', 'inputCostMicrosPerMillion', '输入成本'),
        value('outputCostYuanPerMillion', 'outputCostMicrosPerMillion', '输出成本'),
        value('cacheCostYuanPerMillion', 'cacheCostMicrosPerMillion', '缓存成本'),
        value('inputSellYuanPerMillion', 'inputSellMicrosPerMillion', '输入售价'),
        value('outputSellYuanPerMillion', 'outputSellMicrosPerMillion', '输出售价'),
        value('cacheSellYuanPerMillion', 'cacheSellMicrosPerMillion', '缓存售价'),
        moneyInput(b.fixedCostMicros ?? 0, '固定成本'), moneyInput(b.fixedSellMicros ?? 0, '固定售价'), b.active !== false,
        cleanText(b.priceSource, '价格来源', 512), b.priceEffectiveAt ? new Date(String(b.priceEffectiveAt)) : new Date(), b.fxRateMicros ? moneyInput(b.fxRateMicros, '汇率') : null,
      ]
      const rules = await profit.overview()
      for (const [label, cost, sell] of [['输入', values[1], values[4]], ['输出', values[2], values[5]], ['缓存', values[3], values[6]]] as const) {
        requireWalletMinimumMargin(BigInt(String(cost)), BigInt(String(sell)), rules, `${pattern} ${label}价格`)
      }
      return await db.tx(async (client) => {
        const before = (await client.query<any>('SELECT * FROM model_prices WHERE model_pattern=$1 FOR UPDATE', [pattern])).rows[0] || null
        const writeCost = b.cacheWriteCostYuanPerMillion !== undefined || b.cacheWriteCostMicrosPerMillion !== undefined
          ? value('cacheWriteCostYuanPerMillion', 'cacheWriteCostMicrosPerMillion', 'cache-write成本')
          : before?.cache_write_cost_micros_per_million ?? before?.cache_write_cost_micros ?? null
        const writeSell = b.cacheWriteSellYuanPerMillion !== undefined || b.cacheWriteSellMicrosPerMillion !== undefined
          ? value('cacheWriteSellYuanPerMillion', 'cacheWriteSellMicrosPerMillion', 'cache-write售价')
          : before?.cache_write_sell_micros_per_million ?? before?.cache_write_sell_micros ?? null
        if ((writeCost == null) !== (writeSell == null)) throw new Error('cache-write 成本和售价必须同时填写')
        const pricingTiers = Object.hasOwn(b, 'pricingTiers') ? parsePricingTiers(b.pricingTiers) : before?.pricing_tiers ?? null
        if (pattern === 'gpt-6-sol') {
          const high = Array.isArray(pricingTiers) ? pricingTiers.find((tier: any) => String(tier.thresholdTokens) === '272001') : null
          if (writeCost == null || !high || high.cacheWriteCostMicrosPerMillion == null || high.cacheWriteSellMicrosPerMillion == null) {
            throw new Error('gpt-6-sol 必须配置 Standard cache-write 成本/售价和 272K+ cache-write 成本/售价')
          }
        }
        if (writeCost != null && writeSell != null) requireWalletMinimumMargin(BigInt(String(writeCost)), BigInt(String(writeSell)), rules, `${pattern} cache-write价格`)
        for (const tier of Array.isArray(pricingTiers) ? pricingTiers as any[] : []) {
          for (const [part, label] of [['input','输入'],['output','输出'],['cache','cache-read'],['cacheWrite','cache-write']] as const) {
            const cost = tier[`${part}CostMicrosPerMillion`]
            const sell = tier[`${part}SellMicrosPerMillion`]
            if ((cost == null) !== (sell == null)) throw new Error(`${label}成本和售价必须同时填写`)
            if (cost != null) requireWalletMinimumMargin(BigInt(String(cost)), BigInt(String(sell)), rules, `${pattern} ${tier.label || tier.thresholdTokens} ${label}价格`)
          }
        }
        const result = await client.query<any>(`INSERT INTO model_prices(
        model_pattern,input_cost_micros,output_cost_micros,cache_cost_micros,
        input_sell_micros,output_sell_micros,cache_sell_micros,fixed_cost_micros,fixed_sell_micros,active,
        input_cost_micros_per_million,output_cost_micros_per_million,cache_cost_micros_per_million,
        input_sell_micros_per_million,output_sell_micros_per_million,cache_sell_micros_per_million,
        price_source,price_effective_at,fx_rate_cny_micros,cache_write_cost_micros,cache_write_sell_micros,
        cache_write_cost_micros_per_million,cache_write_sell_micros_per_million,pricing_tiers)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$2,$3,$4,$5,$6,$7,$11,$12,$13,$14,$15,$14,$15,$16)
        ON CONFLICT(model_pattern) DO UPDATE SET
          input_cost_micros=excluded.input_cost_micros, output_cost_micros=excluded.output_cost_micros,
          cache_cost_micros=excluded.cache_cost_micros, input_sell_micros=excluded.input_sell_micros,
          output_sell_micros=excluded.output_sell_micros, cache_sell_micros=excluded.cache_sell_micros,
          fixed_cost_micros=excluded.fixed_cost_micros, fixed_sell_micros=excluded.fixed_sell_micros,
          input_cost_micros_per_million=excluded.input_cost_micros_per_million,
          output_cost_micros_per_million=excluded.output_cost_micros_per_million,
          cache_cost_micros_per_million=excluded.cache_cost_micros_per_million,
          input_sell_micros_per_million=excluded.input_sell_micros_per_million,
          output_sell_micros_per_million=excluded.output_sell_micros_per_million,
          cache_sell_micros_per_million=excluded.cache_sell_micros_per_million,
          cache_write_cost_micros=excluded.cache_write_cost_micros, cache_write_sell_micros=excluded.cache_write_sell_micros,
          cache_write_cost_micros_per_million=excluded.cache_write_cost_micros_per_million,
          cache_write_sell_micros_per_million=excluded.cache_write_sell_micros_per_million,
          price_source=excluded.price_source, price_effective_at=excluded.price_effective_at,
          fx_rate_cny_micros=excluded.fx_rate_cny_micros,
          pricing_tiers=excluded.pricing_tiers,
          active=excluded.active, updated_at=now() RETURNING *`, [...values, writeCost, writeSell, pricingTiers == null ? null : JSON.stringify(pricingTiers)])
        const after = result.rows[0]
        await client.query(`INSERT INTO config_audit_logs(actor_user_id,resource_type,resource_id,before_value,after_value)
          VALUES($1,'model_price',$2,$3,$4)`, [actor.id, pattern, before ? JSON.stringify(before) : null, JSON.stringify(after)])
        return after
      })
    } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) }
  })
  app.delete('/api/admin/prices/:id', async (request, reply) => {
    const actor = await requireAdmin(request, reply); if (!actor) return
    const id = String((request.params as any).id)
    await db.tx(async (client) => {
      const before = (await client.query<any>('SELECT * FROM model_prices WHERE id=$1 FOR UPDATE', [id])).rows[0] || null
      if (!before) throw Object.assign(new Error('价格不存在'), { statusCode: 404 })
      const after = (await client.query<any>('UPDATE model_prices SET active=false, updated_at=now() WHERE id=$1 RETURNING *', [id])).rows[0]
      await client.query(`INSERT INTO config_audit_logs(actor_user_id,resource_type,resource_id,before_value,after_value) VALUES($1,'model_price',$2,$3,$4)`, [actor.id, String(before.model_pattern), JSON.stringify(before), JSON.stringify(after)])
    })
    return { ok: true }
  })

  app.get('/api/admin/fixed-prices', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    return { items: await db.query<any>('SELECT * FROM fixed_route_prices ORDER BY match_priority, path_pattern') }
  })
  app.post('/api/admin/fixed-prices', async (request, reply) => {
    const actor = await requireAdmin(request, reply); if (!actor) return
    try {
      const b = (request.body || {}) as any
      const method = String(b.httpMethod || 'ANY').toUpperCase()
      if (!['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) throw new Error('请求方法无效')
      const pathPattern = cleanText(b.pathPattern, '接口路径', 512)
      if (!pathPattern.startsWith('/v1/')) throw new Error('接口路径必须以 /v1/ 开头')
      const model = String(b.requestedModel || '').trim() || null
      let selectors: Record<string, unknown> = {}
      if (b.selectors) {
        try { selectors = typeof b.selectors === 'string' ? JSON.parse(b.selectors) : b.selectors } catch { throw new Error('规格筛选必须是合法 JSON') }
        if (!selectors || typeof selectors !== 'object' || Array.isArray(selectors)) throw new Error('规格筛选必须是 JSON 对象')
      }
      const unitMode = ['request', 'count', 'seconds'].includes(String(b.unitMode || 'request')) ? String(b.unitMode || 'request') : 'request'
      const unitPath = unitMode === 'request' ? null : cleanText(b.unitPath, '计费参数', 128)
      const cost = b.costYuan !== undefined ? BigInt(yuanInput(b.costYuan, '固定成本')) : BigInt(moneyInput(b.costMicros ?? 0, '固定成本'))
      const marginBps = Number(b.marginBps ?? 8000)
      if (!Number.isInteger(marginBps) || marginBps < 0 || marginBps >= 10_000) throw new Error('毛利率应为 0-9999 基点')
      const rules = await profit.overview()
      const sell = b.sellYuan !== undefined ? yuanInput(b.sellYuan, '固定售价') : b.sellMicros !== undefined ? moneyInput(b.sellMicros, '固定售价') : requiredWalletSell(cost, { ...rules, minimumMarginBps: Math.max(rules.minimumMarginBps, marginBps) }).toString()
      requireWalletMinimumMargin(cost, BigInt(String(sell)), rules, '固定接口价格')
      return await db.tx(async (client) => {
        const id = b.id ? String(b.id) : null
        const before = id ? (await client.query<any>('SELECT * FROM fixed_route_prices WHERE id=$1 FOR UPDATE', [id])).rows[0] || null : null
        if (id && !before) throw Object.assign(new Error('固定价格不存在'), { statusCode: 404 })
        const result = id
          ? await client.query<any>(`UPDATE fixed_route_prices SET http_method=$1,path_pattern=$2,requested_model=$3,cost_micros=$4,sell_micros=$5,enabled=$6,match_priority=$7,selectors=$8,unit_path=$9,unit_mode=$10,updated_at=now() WHERE id=$11 RETURNING *`, [method, pathPattern, model, cost.toString(), sell, b.enabled !== false, Math.max(0, Number(b.matchPriority ?? 100) || 0), JSON.stringify(selectors), unitPath, unitMode, id])
          : await client.query<any>(`INSERT INTO fixed_route_prices(http_method,path_pattern,requested_model,cost_micros,sell_micros,enabled,match_priority,selectors,unit_path,unit_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [method, pathPattern, model, cost.toString(), sell, b.enabled !== false, Math.max(0, Number(b.matchPriority ?? 100) || 0), JSON.stringify(selectors), unitPath, unitMode])
        const after = result.rows[0]
        await client.query(`INSERT INTO config_audit_logs(actor_user_id,resource_type,resource_id,before_value,after_value) VALUES($1,'fixed_route_price',$2,$3,$4)`, [actor.id, String(after.id), before ? JSON.stringify(before) : null, JSON.stringify(after)])
        return after
      })
    } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) }
  })
  app.delete('/api/admin/fixed-prices/:id', async (request, reply) => {
    const actor = await requireAdmin(request, reply); if (!actor) return
    const id = String((request.params as any).id)
    await db.tx(async (client) => {
      const before = (await client.query<any>('SELECT * FROM fixed_route_prices WHERE id=$1 FOR UPDATE', [id])).rows[0] || null
      if (!before) throw Object.assign(new Error('固定价格不存在'), { statusCode: 404 })
      const after = (await client.query<any>('UPDATE fixed_route_prices SET enabled=false, updated_at=now() WHERE id=$1 RETURNING *', [id])).rows[0]
      await client.query(`INSERT INTO config_audit_logs(actor_user_id,resource_type,resource_id,before_value,after_value) VALUES($1,'fixed_route_price',$2,$3,$4)`, [actor.id, id, JSON.stringify(before), JSON.stringify(after)])
    })
    return { ok: true }
  })

  app.get('/api/admin/plans', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    return { items: await db.query<any>('SELECT * FROM plans ORDER BY display_order, created_at DESC') }
  })
  app.post('/api/admin/plans', async (request, reply) => {
    const actor = await requireAdmin(request, reply); if (!actor) return
    try {
      const b = (request.body || {}) as any
      const code = cleanText(b.code, '套餐代码', 64)
      const name = cleanText(b.name, '套餐名称', 128)
      const price = b.priceYuan !== undefined ? yuanInput(b.priceYuan, '套餐价格', false) : moneyInput(b.priceMicros, '套餐价格', false)
      const quota = b.quotaYuan !== undefined ? yuanInput(b.quotaYuan, '套餐额度', false) : moneyInput(b.quotaMicros, '套餐额度', false)
      const grantLimit = Number(b.resetGrantLimit ?? (code.toLowerCase() === 'monthly-149' ? 4 : 1))
      if (!Number.isInteger(grantLimit) || grantLimit < 1 || grantLimit > 52) throw new Error('套餐发放次数必须为 1-52 次')
      const order = Math.max(0, Number(b.displayOrder ?? 100) || 0)
      return await db.tx(async (client) => {
        const id = b.id ? String(b.id) : null
        const before = id ? (await client.query<any>('SELECT * FROM plans WHERE id=$1 FOR UPDATE', [id])).rows[0] || null : null
        if (id && !before) throw Object.assign(new Error('套餐不存在'), { statusCode: 404 })
        const result = id
          ? await client.query<any>(`UPDATE plans SET code=$1,name=$2,price_micros=$3,quota_micros=$4,reset_grant_limit=$5,duration_days=30,active=$6,enabled=$6,display_order=$7,updated_at=now() WHERE id=$8 RETURNING *`, [code, name, price, quota, grantLimit, b.active !== false, order, id])
          : await client.query<any>(`INSERT INTO plans(code,name,price_micros,quota_micros,reset_grant_limit,duration_days,active,enabled,display_order) VALUES($1,$2,$3,$4,$5,30,$6,$6,$7) RETURNING *`, [code, name, price, quota, grantLimit, b.active !== false, order])
        const after = result.rows[0]
        await client.query(`INSERT INTO config_audit_logs(actor_user_id,resource_type,resource_id,before_value,after_value) VALUES($1,'plan',$2,$3,$4)`, [actor.id, String(after.id), before ? JSON.stringify(before) : null, JSON.stringify(after)])
        return after
      })
    } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) }
  })
  app.delete('/api/admin/plans/:id', async (request, reply) => {
    const actor = await requireAdmin(request, reply); if (!actor) return
    const id = String((request.params as any).id)
    await db.tx(async (client) => {
      const before = (await client.query<any>('SELECT * FROM plans WHERE id=$1 FOR UPDATE', [id])).rows[0] || null
      if (!before) throw Object.assign(new Error('套餐不存在'), { statusCode: 404 })
      const after = (await client.query<any>('UPDATE plans SET active=false, enabled=false, updated_at=now() WHERE id=$1 RETURNING *', [id])).rows[0]
      await client.query(`INSERT INTO config_audit_logs(actor_user_id,resource_type,resource_id,before_value,after_value) VALUES($1,'plan',$2,$3,$4)`, [actor.id, id, JSON.stringify(before), JSON.stringify(after)])
    })
    return { ok: true }
  })
  app.post('/api/admin/bootstrap/openai-prices', async (request, reply) => {
    const actor = await requireAdmin(request, reply); if (!actor) return
    try {
      const body = (request.body || {}) as any
      if (body.confirm !== true) throw Object.assign(new Error('官方价格快照不可作为当前价格来源；请先检查 /api/admin/pricing/preview，再用 confirm=true 发布渠道成本预览'), { statusCode: 400 })
      const current = await profit.overview()
      const rules: PricingRules = { minimumMarginBps: Number(body.minimumMarginBps ?? 5000), paymentFeeRateBps: current.paymentFeeRateBps, affiliateRateBps: current.affiliateRateBps, walletTopupMultiplierBps: current.walletTopupMultiplierBps }
      return await new ChannelCostService(db).publishPricing(rules, actor.id)
    } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) }
  })
  app.post('/api/admin/bootstrap/monthly-plan', async (request, reply) => {
    const actor = await requireAdmin(request, reply); if (!actor) return
    const row = await db.tx(async (client) => {
      const before = (await client.query<any>(`SELECT * FROM plans WHERE lower(code)=lower('monthly-149') FOR UPDATE`)).rows[0] || null
      const result = await client.query<any>(`WITH updated AS (
        UPDATE plans SET name='月套餐',price_micros=149000000,quota_micros=149000000,reset_grant_limit=4,duration_days=30,active=true,enabled=true,display_order=10,updated_at=now()
        WHERE lower(code)=lower('monthly-149') RETURNING *
      ), inserted AS (
        INSERT INTO plans(code,name,price_micros,quota_micros,reset_grant_limit,duration_days,active,enabled,display_order)
        SELECT 'monthly-149','月套餐',149000000,149000000,4,30,true,true,10 WHERE NOT EXISTS (SELECT 1 FROM updated)
        RETURNING *
      ) SELECT * FROM updated UNION ALL SELECT * FROM inserted LIMIT 1`)
      const after = result.rows[0]
      await client.query(`INSERT INTO config_audit_logs(actor_user_id,resource_type,resource_id,before_value,after_value) VALUES($1,'plan',$2,$3,$4)`, [actor.id, String(after.id), before ? JSON.stringify(before) : null, JSON.stringify(after)])
      return after
    })
    return { item: row, priceYuan: '149', quotaPerGrantYuan: '149', grantLimit: 4, totalQuotaYuan: '596', note: '套餐利润按实际 usage_logs 成本单独核算；不套用钱包充值倍率' }
  })

  app.get('/api/admin/users', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    const q = (request.query || {}) as any
    const values: unknown[] = []
    const where: string[] = []
    if (q.status) { values.push(String(q.status)); where.push(`u.status=$${values.length}`) }
    if (q.search) { values.push(`%${String(q.search).slice(0, 128)}%`); where.push(`u.username ILIKE $${values.length}`) }
    return { items: await db.query<any>(`SELECT u.id,u.username,u.email,u.role,u.status,u.invite_code,u.last_login_at,u.created_at,u.disabled_at,
      w.balance_micros,COALESCE(w.reserved_micros,0) AS wallet_reserved_micros,aw.balance_micros AS affiliate_balance_micros,u.token_discount_bps,
      (SELECT COALESCE(SUM(wl.amount_micros),0)::text FROM wallet_ledger wl
        WHERE wl.user_id=u.id AND wl.kind='wallet_topup') AS total_topup_credit_micros,
      (SELECT COALESCE(SUM(COALESCE(o.paid_amount_micros,o.amount_micros)),0)::text FROM orders o
        WHERE o.user_id=u.id AND o.kind='wallet_topup' AND o.status='paid') AS total_topup_paid_micros,
      (SELECT COALESCE(SUM(COALESCE(o.paid_amount_micros,o.amount_micros)),0)::text FROM orders o
        WHERE o.user_id=u.id AND o.kind IN ('wallet_topup','subscription','subscription_purchase') AND o.status='paid') AS total_paid_micros,
      s.remaining_micros AS plan_remaining_micros,COALESCE(s.reserved_micros,0) AS plan_reserved_micros,s.reset_quota_micros AS plan_quota_micros,
      s.expires_at AS plan_expires_at,s.next_reset_at AS plan_next_reset_at,s.last_reset_at AS plan_last_reset_at,s.status AS plan_status
      FROM users u LEFT JOIN wallets w ON w.user_id=u.id LEFT JOIN affiliate_wallets aw ON aw.user_id=u.id
      LEFT JOIN subscriptions s ON s.user_id=u.id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY u.created_at DESC LIMIT 200`, values) }
  })
  app.patch('/api/admin/users/:id/discount', async (request, reply) => {
    const actor = await requireAdmin(request, reply); if (!actor) return
    const raw = (request.body as any)?.discountBps
    const discountBps = Number(raw)
    if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps > 99) {
      reply.code(400).send({ error: { message: '折扣必须为 0-99 的百分比' } }); return
    }
    const userId = String((request.params as any).id)
    return db.tx(async (client) => {
      await client.query('LOCK TABLE channels, channel_model_mappings, channel_model_costs, model_prices, app_settings, users IN SHARE ROW EXCLUSIVE MODE')
      const current = (await client.query<any>('SELECT id, token_discount_bps FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0]
      if (!current) throw Object.assign(new Error('用户不存在'), { statusCode: 404 })
      const currentDiscountPercent = Math.max(0, Math.min(99, Number(current.token_discount_bps || 0) / 100))
      // Lowering an existing risky discount is always allowed. The margin guard
      // only applies when an administrator increases the effective discount.
      if (discountBps > currentDiscountPercent) await profit.validateDiscount(discountBps * 100, client)
      const row = (await client.query<any>('UPDATE users SET token_discount_bps=$1,updated_at=now() WHERE id=$2 RETURNING id,username,token_discount_bps', [discountBps * 100, userId])).rows[0]
      await client.query(`INSERT INTO config_audit_logs(actor_user_id,resource_type,resource_id,before_value,after_value) VALUES($1,'user_token_discount',$2,$3,$4)`, [actor.id, userId, JSON.stringify({ tokenDiscountBps: Number(current.token_discount_bps || 0) }), JSON.stringify({ tokenDiscountBps: Number(row.token_discount_bps || 0) })])
      return { id: String(row.id), username: row.username, discountBps: Number(row.token_discount_bps) / 100 }
    })
  })
  app.post('/api/admin/users/:id/wallet-adjustment', async (request, reply) => {
    const actor = await requireAdmin(request, reply); if (!actor) return
    try {
      const body = (request.body || {}) as any
      const direction = String(body.direction || '').toLowerCase()
      if (direction !== 'credit' && direction !== 'debit') throw new Error('调账方向必须为 credit 或 debit')
      const amount = BigInt(yuanInput(body.amountYuan ?? body.amount, '调账金额', false))
      const note = cleanText(body.note || '', '调账原因', 500)
      const userId = String((request.params as any).id || '')
      return await db.tx(async (client) => {
        const user = await client.query<any>('SELECT id,username FROM users WHERE id=$1 FOR UPDATE', [userId])
        if (!user.rowCount) throw Object.assign(new Error('用户不存在'), { statusCode: 404 })
        await client.query('INSERT INTO wallets(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING', [userId])
        const wallet = (await client.query<any>('SELECT balance_micros,reserved_micros FROM wallets WHERE user_id=$1 FOR UPDATE', [userId])).rows[0]
        const balance = BigInt(String(wallet.balance_micros)); const reserved = BigInt(String(wallet.reserved_micros)); const available = balance - reserved
        if (direction === 'debit' && amount > available) throw new Error(`可扣余额不足，当前可用余额 ${formatMicros(available)} 元`)
        const next = direction === 'credit' ? balance + amount : balance - amount
        await client.query('UPDATE wallets SET balance_micros=$1,version=version+1,updated_at=now() WHERE user_id=$2', [next.toString(), userId])
        await client.query(`INSERT INTO wallet_ledger(user_id,kind,entry_kind,amount_micros,balance_after_micros,reference_note,metadata) VALUES($1,'admin_adjustment',$2,$3,$4,$5,$6)`, [userId, direction, (direction === 'credit' ? amount : -amount).toString(), next.toString(), note, JSON.stringify({ actorUserId: actor.id, actorUsername: actor.username, direction, amountMicros: amount.toString() })])
        await client.query(`INSERT INTO admin_audit_events(actor_user_id,action,target_type,target_id,metadata) VALUES($1,'wallet_adjustment','user',$2,$3)`, [actor.id, userId, JSON.stringify({ direction, amountMicros: amount.toString(), note })])
        return { userId, username: user.rows[0].username, direction, amount: publicMoney(amount), balance: publicMoney(next), available: publicMoney(next - reserved), note }
      })
    } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) }
  })
  app.get('/api/admin/subscription-resets', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    const q = (request.query || {}) as any
    const values: unknown[] = []
    const where: string[] = []
    if (q.userId) { values.push(String(q.userId)); where.push(`e.user_id=$${values.length}`) }
    return { items: await db.query<any>(`SELECT e.*,u.username,a.username AS actor_username FROM subscription_reset_events e JOIN users u ON u.id=e.user_id LEFT JOIN users a ON a.id=e.actor_user_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.created_at DESC LIMIT ${boundedLimit(q.limit, 100, 500)}`, values) }
  })
  app.patch('/api/admin/users/:id/status', async (request, reply) => {
    const actor = await requireAdmin(request, reply); if (!actor) return
    const status = String((request.body as any)?.status || '')
    if (!['active', 'suspended', 'disabled'].includes(status)) { reply.code(400).send({ error: { message: '用户状态无效' } }); return }
    if (String((request.params as any).id) === actor.id && status !== 'active') { reply.code(400).send({ error: { message: '不能停用当前管理员账号' } }); return }
    await db.query(`UPDATE users SET status=$1,disabled_at=CASE WHEN $1='disabled' THEN COALESCE(disabled_at,now()) ELSE NULL END,updated_at=now() WHERE id=$2`, [status, String((request.params as any).id)])
    return { ok: true }
  })

  app.get('/api/admin/orders', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    const q = (request.query || {}) as any
    const values: unknown[] = []
    const where: string[] = []
    if (q.userId) { values.push(String(q.userId)); where.push(`o.user_id=$${values.length}`) }
    if (q.status) { values.push(String(q.status)); where.push(`o.status=$${values.length}`) }
    if (q.kind) { values.push(String(q.kind)); where.push(`o.kind=$${values.length}`) }
    if (q.from) { values.push(dateFilter(q.from)); where.push(`o.created_at >= $${values.length}`) }
    if (q.to) { values.push(dateFilter(q.to, true)); where.push(`o.created_at < $${values.length}`) }
    const rows = await db.query<any>(`SELECT o.*,u.username,p.name AS plan_name,
      CASE WHEN o.kind='wallet_topup' THEN wl.id::text ELSE sp.id::text END AS credit_record_id,
      CASE WHEN o.kind='wallet_topup' THEN wl.amount_micros ELSE sp.quota_added_micros END AS credited_amount_micros,
      CASE WHEN o.kind='wallet_topup' THEN wl.created_at ELSE sp.created_at END AS credited_at,
      sp.amount_paid_micros AS credited_paid_amount_micros,
      credit_audit.created_at AS credit_reconciled_at,
      credit_audit.actor_username AS credit_reconciled_by
      FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN plans p ON p.id=o.plan_id
      LEFT JOIN wallet_ledger wl ON wl.order_id=o.id AND wl.kind='wallet_topup'
      LEFT JOIN subscription_purchases sp ON sp.order_id=o.id
      LEFT JOIN LATERAL (
        SELECT e.created_at,a.username AS actor_username
        FROM admin_audit_events e LEFT JOIN users a ON a.id=e.actor_user_id
        WHERE e.action='order_credit_reconciled' AND e.target_type='order' AND e.target_id=o.id::text
        ORDER BY e.created_at DESC,e.id DESC LIMIT 1
      ) credit_audit ON true
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.created_at DESC LIMIT ${boundedLimit(q.limit, 100, 500)}`, values)
    return { items: rows.map(row => ({ ...row, ...orders.creditState(row) })) }
  })
  app.post('/api/admin/orders/:id/reconcile', async (request, reply) => {
    const actor = await requireAdmin(request, reply); if (!actor) return
    const id = String((request.params as any).id || '')
    return { ok: true, ...(await orders.reconcileCredit(id, actor.id)) }
  })
  app.post('/api/admin/orders/:id/query-payment', async (request, reply) => {
    const actor = await requireAdmin(request, reply); if (!actor) return
    const id = String((request.params as any).id || '')
    try {
      const gateway = await optionalPaymentGateway(config)
      if (!gateway) throw Object.assign(new Error('支付渠道尚未配置'), { statusCode: 503 })
      const order = await db.one<any>('SELECT order_no,payment_provider,payment_method FROM orders WHERE id=$1', [id])
      if (!order) { reply.code(404).send({ error: { message: '订单不存在' } }); return }
      const provider = String(order.payment_provider || order.payment_method || '').toLowerCase()
      if (!provider.includes('wechat')) throw new Error('该订单不是微信支付订单')
      const queried = await gateway.queryNativeOrder(String(order.order_no), 'wechat')
      const result = await orders.applyQueriedPayment(id, queried)
      const state = await orders.getCreditState(id)
      return { ok: true, queried: queried.status, settled: Boolean(result), ...(state || {}) }
    } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) }
  })

  app.get('/api/admin/usage', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    try {
      const q = (request.query || {}) as any
      const values: unknown[] = []
      const where: string[] = []
      if (q.userId) { values.push(String(q.userId)); where.push(`l.user_id=$${values.length}`) }
      if (q.model) { values.push(String(q.model)); where.push(`l.requested_model=$${values.length}`) }
      if (q.channelId) { values.push(String(q.channelId)); where.push(`l.final_channel_id=$${values.length}`) }
      if (q.status) { values.push(String(q.status)); where.push(`l.status=$${values.length}`) }
      if (q.from) { values.push(dateFilter(q.from)); where.push(`l.started_at >= $${values.length}`) }
      if (q.to) { values.push(dateFilter(q.to, true)); where.push(`l.started_at < $${values.length}`) }
      const rows = await db.query<any>(`SELECT l.*,u.username FROM usage_logs l JOIN users u ON u.id=l.user_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.started_at DESC,l.request_id DESC LIMIT ${boundedLimit(q.limit, 100, 500)}`, values)
      return { items: rows.map(row => ({ ...row, fallbackCostPending: fallbackCostPending(row) })) }
    } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) }
  })
  app.get('/api/admin/usage/:requestId/attempts', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    return { items: await db.query<any>(`SELECT a.*,c.name AS current_channel_name FROM relay_attempts a LEFT JOIN channels c ON c.id=a.channel_id WHERE a.request_id=$1 ORDER BY a.attempt_no`, [String((request.params as any).requestId)]) }
  })

  app.get('/api/admin/affiliate', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    const [settings, commissions, conversions] = await Promise.all([
      db.query<any>(`SELECT key,value,updated_at FROM app_settings WHERE key IN ('affiliate_enabled','affiliate_rate_bps') ORDER BY key`),
      db.query<any>(`SELECT c.*,inviter.username AS inviter_username,invitee.username AS invitee_username FROM affiliate_commissions c JOIN users inviter ON inviter.id=c.inviter_user_id JOIN users invitee ON invitee.id=COALESCE(c.invited_user_id,c.invitee_user_id) ORDER BY c.created_at DESC LIMIT 200`),
      db.query<any>(`SELECT x.*,u.username FROM affiliate_conversions x JOIN users u ON u.id=x.user_id ORDER BY x.created_at DESC LIMIT 200`),
    ])
    return { settings, commissions, conversions }
  })
  app.patch('/api/admin/affiliate/settings', async (request, reply) => {
    const actor = await requireAdmin(request, reply); if (!actor) return
    const b = (request.body || {}) as any
    const enabled = b.enabled !== false
    const rateBps = Number(b.rateBps)
    if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000) { reply.code(400).send({ error: { message: '返利比例应为 0-10000 基点' } }); return }
    const nextEffectiveRate = enabled ? rateBps : 0
    return db.tx(async (client) => {
      await client.query('LOCK TABLE channels, channel_model_mappings, channel_model_costs, model_prices, app_settings, users IN SHARE ROW EXCLUSIVE MODE')
      const current = await profit.overview(client)
      if (nextEffectiveRate > current.affiliateRateBps) await profit.validateUpdate({ affiliateEnabled: enabled, affiliateRateBps: rateBps }, client)
      const before = await client.query(`SELECT key,value FROM app_settings WHERE key IN ('affiliate_enabled','affiliate_rate_bps') ORDER BY key FOR UPDATE`)
      await client.query(`INSERT INTO app_settings(key,setting_key,value,value_json) VALUES('affiliate_enabled','affiliate.enabled',$1,to_jsonb($1::text)) ON CONFLICT(key) DO UPDATE SET value=excluded.value,value_json=excluded.value_json,updated_at=now()`, [String(enabled)])
      await client.query(`INSERT INTO app_settings(key,setting_key,value,value_json) VALUES('affiliate_rate_bps','affiliate.rate_bps',$1,to_jsonb($1::text)) ON CONFLICT(key) DO UPDATE SET value=excluded.value,value_json=excluded.value_json,updated_at=now()`, [String(rateBps)])
      await client.query(`INSERT INTO config_audit_logs(actor_user_id,resource_type,resource_id,before_value,after_value) VALUES($1,'affiliate_settings','global',$2,$3)`, [actor.id, JSON.stringify(before.rows), JSON.stringify({ enabled, rateBps })])
      return { enabled, rateBps }
    })
  })
  app.get('/api/admin/settings', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    const [items, profitOverview] = await Promise.all([
      db.query<any>('SELECT key, value, updated_at FROM app_settings ORDER BY key'),
      profit.overview(),
    ])
    return { items, mail: mail.status, profit: profitOverview, nightDiscount: nightDiscountView(profitOverview) }
  })
  app.patch('/api/admin/settings/profit', async (request, reply) => {
    const actor = await requireAdmin(request, reply)
    if (!actor) return
    try {
      const result = await profit.update((request.body || {}) as any, actor.id)
      return result
    } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) }
  })
  app.patch('/api/admin/settings/night-discount', async (request, reply) => {
    const actor = await requireAdmin(request, reply)
    if (!actor) return
    try {
      const body = (request.body || {}) as any
      if (typeof body.enabled !== 'boolean') throw Object.assign(new Error('深夜折扣开关必须为布尔值'), { statusCode: 400 })
      if (!Number.isInteger(body.discountBps) || body.discountBps < 0 || body.discountBps > 9900) {
        throw Object.assign(new Error('深夜折扣必须为 0-9900 整数基点'), { statusCode: 400 })
      }
      const result = await profit.updateNightDiscount({ enabled: body.enabled, discountBps: body.discountBps }, actor.id)
      return { nightDiscount: nightDiscountView(result), profit: result }
    } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) }
  })
  app.put('/api/admin/settings/site', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    try {
      const body = (request.body || {}) as any
      const name = cleanText(body.name, '站点名称', 80)
      const title = cleanText(body.title, '浏览器标题', 160)
      const logoUrl = cleanText(body.logoUrl, 'Logo 地址', 512)
      if (!logoUrl.startsWith('/') && !/^https:\/\//.test(logoUrl)) throw new Error('Logo 地址必须为本站路径或 HTTPS 地址')
      await db.tx(async (client) => {
        for (const [key, settingKey, value] of [
          ['site_name', 'site.name', name],
          ['site_title', 'site.title', title],
          ['site_logo_url', 'site.logo_url', logoUrl],
        ]) {
          await client.query(`INSERT INTO app_settings(key,setting_key,value,value_json) VALUES($1,$2,$3,to_jsonb($3::text))
            ON CONFLICT(key) DO UPDATE SET setting_key=excluded.setting_key,value=excluded.value,value_json=excluded.value_json,updated_at=now()`, [key, settingKey, value])
        }
      })
      return { ok: true }
    } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) }
  })
  app.post('/api/admin/settings', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    try {
      const b = request.body as any
      const key = cleanText(b.key, '设置键', 128)
      if (key === 'affiliate_enabled' || key === 'affiliate_rate_bps') throw new Error('返利设置请使用专用接口')
      if (['profit_min_margin_bps', 'payment_fee_rate_bps', 'global_token_discount_bps', 'night_token_discount_enabled', 'night_token_discount_bps'].includes(key)) throw new Error('利润与折扣设置请使用专用接口')
      await db.query(`INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=now()`, [key, String(b.value).slice(0, 2000)])
      return { ok: true }
    } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) }
  })

  const accountBalance = async (request: any, reply: any) => {
    reply.header('Cache-Control', 'no-store').header('Vary', 'Authorization')
    const raw = bearer((request.headers as any).authorization)
    if (!raw) { reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: { message: '需要 Bearer API Key', type: 'authentication_error' } }); return }
    try {
      const identity = await auth.authenticateApiKey(raw)
      const balance = await billing.balance(identity.user.id)
      const total = balance.planMicros + balance.walletMicros
      const remainingDisplay = formatMicros(total)
      const remainingNumber = Number(remainingDisplay)
      // CC Switch's usage contract requires remaining to be a JSON number.
      // Keep the decimal string and micro-yuan integer alongside it for
      // clients that need exact monetary arithmetic.
      const remaining = Number.isFinite(remainingNumber) ? remainingNumber : 0
      const data = {
        planName: balance.planExpiresAt ? '30 天月套餐' : 'Relay 钱包',
        remaining, remainingDisplay, remainingMicros: total.toString(),
        balance: formatMicros(total), availableBalance: formatMicros(total),
        walletRemaining: formatMicros(balance.walletMicros), walletRemainingMicros: balance.walletMicros.toString(),
        planRemaining: formatMicros(balance.planMicros), planRemainingMicros: balance.planMicros.toString(),
        planBookRemaining: formatMicros(balance.planBookMicros), planBookRemainingMicros: balance.planBookMicros.toString(),
        planReserved: formatMicros(balance.planReservedMicros), planReservedMicros: balance.planReservedMicros.toString(),
        planUsed: formatMicros(balance.planUsedMicros), planUsedMicros: balance.planUsedMicros.toString(),
        planQuota: formatMicros(balance.planQuotaMicros), planQuotaMicros: balance.planQuotaMicros.toString(),
        walletReserved: formatMicros(balance.walletReservedMicros), walletReservedMicros: balance.walletReservedMicros.toString(),
        planExpiresAt: balance.planExpiresAt, planNextResetAt: balance.planNextResetAt, planLastResetAt: balance.planLastResetAt,
        planStatus: balance.planStatus, unit: 'CNY', isValid: balance.isValid, updatedAt: new Date().toISOString(),
      }
      // Current CC Switch accepts response.data while older import scripts read
      // the root object. Keep both projections numerically compatible.
      return { success: true, ...data, data }
    } catch (error) { reply.code(401).send({ error: { message: (error as Error).message, type: 'authentication_error' } }) }
  }
  const modelCatalog = async (request: any, reply: any) => {
    reply.header('Cache-Control', 'private, no-store')
    const raw = bearer((request.headers as any).authorization)
    if (!raw) { reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: { message: '需要 Bearer API Key', type: 'authentication_error' } }); return }
    try {
      await auth.authenticateApiKey(raw)
      // Token-priced models come from model_prices. Image/video endpoints use
      // fixed_route_prices instead, so include those explicit model names in
      // the catalog when an enabled channel maps them.
      const rows = await db.query<any>(`SELECT DISTINCT model FROM (
          SELECT key AS model
          FROM channels c
          CROSS JOIN LATERAL jsonb_object_keys(c.model_map) AS key
          JOIN model_prices p ON p.model_pattern = key AND p.active = true
          WHERE c.enabled = true AND key <> '*'
          UNION
          SELECT f.requested_model AS model
          FROM fixed_route_prices f
          JOIN channels c ON c.enabled = true AND c.model_map ? f.requested_model
          WHERE f.enabled = true AND f.requested_model IS NOT NULL
          UNION
          SELECT p.model
          FROM media_prices p
          JOIN channels c ON c.id=p.channel_id
          WHERE p.enabled AND c.enabled AND c.deleted_at IS NULL
            AND p.normal_cost_micros>0 AND p.cost_source IS NOT NULL
        ) catalog
        WHERE trim(model) <> ''
        ORDER BY model`)
      const models = rows.map((row) => ({
        id: String(row.model), object: 'model', created: 0, owned_by: 'relay-station',
      }))
      return { object: 'list', data: models }
    } catch (error) { reply.code(401).send({ error: { message: (error as Error).message, type: 'authentication_error' } }) }
  }
  app.get('/v1/account/balance', accountBalance)
  app.get('/account/balance', accountBalance)
  app.get('/v1/models', modelCatalog)
  app.get('/models', modelCatalog)

  const relayRequest = async (request: any, reply: any, prefix = '/v1') => {
    const rawPath = String((request.raw.url || '').split('?')[0]) || '/'
    const path = prefix === '/v1' ? rawPath.replace(/^\/v1/, '') || '/' : rawPath
    if (path === '/account/balance') return
    const raw = bearer((request.headers as any).authorization)
    if (!raw) { reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: { message: '需要 Bearer API Key', type: 'authentication_error' } }); return }
    let identity: any
    try { identity = await auth.authenticateApiKey(raw) } catch (error) { reply.code(401).send({ error: { message: (error as Error).message, type: 'authentication_error' } }); return }
    const body = jsonBody(request.body)
    let parsed: any = {}
    if (body && body.length) { try { parsed = JSON.parse(body.toString('utf8')) } catch { parsed = {} } }
    const model = String(parsed.model || request.headers['x-model'] || '').trim()
    if (['agnes-image-2.5-flash','agnes-video-2.5-flash','gpt-image-2','gpt-image-2.5'].includes(model)) { reply.code(400).send({ error: { message: '媒体生成请使用 /api/me/media/quote 和 /api/me/media/tasks，支持 Bearer API Key；先报价再创建任务，查询进度不收费' } }); return }
    const isMetadata = request.method === 'GET' && (path === '/models' || path.startsWith('/models/'))
    const requestPath = `/v1${path}`
    let price: PriceSnapshot | null = null
    if (!isMetadata) {
      try {
        price = await billing.priceForRequest(request.method, requestPath, model, parsed, request.headers as Record<string, unknown>)
      } catch (error) {
        reply.code(errorStatus(error)).send({ error: { message: (error as Error).message, type: 'pricing_not_configured' } }); return
      }
      if (!price) { reply.code(503).send({ error: { message: '管理员尚未配置该模型价格，暂不可调用', type: 'pricing_not_configured' } }); return }
    }
    const requestId = randomUUID()
    reply.header('X-Request-Id', requestId)
    if (!isMetadata) {
      try {
        await billing.reserve({
          userId: identity.user.id, requestId, model, payload: parsed, price: price as PriceSnapshot,
          billingMode: price?.billingMode, requestPath, requestMethod: request.method,
          keyId: identity.key.id, keyName: identity.key.name,
        })
      } catch (error) {
        if (/余额不足/.test(String((error as Error).message || ''))) void mail.queueLowBalance(identity.user.id).catch(() => undefined)
        reply.code(errorStatus(error)).send({ error: { message: (error as Error).message, type: 'billing_error', request_id: requestId } }); return
      }
    }
    layaShadow.observe(identity.user.role, identity.user.id, request.method, path, parsed)
    const started = Date.now()
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(request.headers as Record<string, string | string[] | undefined>)) if (typeof value === 'string') headers[key] = value
    let relay: any
    const query = (request.raw.url || '').includes('?') ? `?${String(request.raw.url).split('?').slice(1).join('?')}` : ''
    try { relay = await channels.relay(path + query, request.method, headers, body, model) } catch (error: any) {
      const noCompatibleUpstream = error?.code === 'no_compatible_upstream'
      if (!isMetadata) {
        try {
          await billing.settle({
            requestId, userId: identity.user.id, model, usage: null, price: price as PriceSnapshot,
            statusCode: 502, success: false, latencyMs: Date.now() - started, estimatedUsage: true,
            upstreamModel: '', channelId: null, channelName: null,
            keyId: identity.key.id, keyName: identity.key.name, requestPath, requestMethod: request.method,
            errorCode: noCompatibleUpstream ? 'no_compatible_upstream' : 'upstream_unavailable',
            errorSummary: noCompatibleUpstream ? '当前请求没有兼容的上游渠道' : '所有上游渠道均不可用',
            attemptCount: Array.isArray(error?.attempts) ? error.attempts.length : 0,
          })
          if (Array.isArray(error?.attempts)) await recordAttempts(db, requestId, error.attempts, estimatedFailedAttemptCost(price as PriceSnapshot, parsed))
        } catch (billingError) {
          await billing.release(requestId).catch(() => undefined)
          app.log.error({ err: billingError, requestId }, 'failed to release relay reservation')
        }
      }
      reply.code(502).send({ error: {
        message: error?.message || '上游渠道不可用',
        type: noCompatibleUpstream ? 'no_compatible_upstream' : 'upstream_error',
        code: noCompatibleUpstream ? 'no_compatible_upstream' : 'upstream_unavailable',
        request_id: requestId,
      } }); return
    }
    const response = relay.response
    const responseHeaders = response.headers as Record<string, string | string[] | undefined>
    const upstreamRequestId = responseHeader(responseHeaders, ['x-request-id', 'openai-request-id', 'request-id'])
    const isSse = String(responseHeaders['content-type'] || '').includes('text/event-stream')
    const contentEncoding = responseHeaders['content-encoding']
    const rewriteModel = isPublicFallbackModel(model) && relay.upstreamModel !== model
    if (isSse) {
      reply.hijack()
      reply.raw.statusCode = response.statusCode
      reply.raw.setHeader('X-Request-Id', requestId)
      for (const [key, value] of Object.entries(responseHeaders)) if (shouldForwardRelayResponseHeader(key) && value !== undefined) reply.raw.setHeader(key, value as any)
      const decoder = new StringDecoder('utf8')
      const publicStream = relay.responseAdapter === 'agnes_responses'
        ? new AgnesResponsesSse(model)
        : rewriteModel ? new PublicModelSse(model) : null
      let pending = ''
      let usage = null as ReturnType<typeof parseSseUsage>
      const consumeUsage = (value: string) => {
        pending += value
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() || ''
        for (const line of lines) usage = parseSseUsage(`${line}\n`) || usage
      }
      let streamError: unknown = null
      let clientDisconnected = false
      const abortForClientDisconnect = () => {
        if (reply.raw.writableEnded) return
        clientDisconnected = true
        try { (response.body as any).destroy?.(new Error('客户端连接已关闭')) } catch { /* noop */ }
      }
      reply.raw.once('close', abortForClientDisconnect)
      reply.raw.once('error', abortForClientDisconnect)
      try {
        for await (const chunk of decodeResponseStream(response.body, contentEncoding)) {
          if (clientDisconnected || reply.raw.destroyed || reply.raw.writableEnded) throw new Error('客户端连接已关闭')
          const buffer = Buffer.from(chunk)
          consumeUsage(decoder.write(buffer))
          const outgoing = publicStream ? publicStream.write(buffer) : buffer
          if (outgoing.length && !reply.raw.write(outgoing)) await waitForWritableDrain(reply.raw)
        }
        if (clientDisconnected) throw new Error('客户端连接已关闭')
        consumeUsage(`${decoder.end()}\n`)
        const tail = publicStream?.end()
        if (tail && !reply.raw.write(tail)) await waitForWritableDrain(reply.raw)
      } catch (error) {
        streamError = error
        try { (response.body as any).destroy?.(error) } catch { /* noop */ }
      } finally {
        reply.raw.removeListener('close', abortForClientDisconnect)
        reply.raw.removeListener('error', abortForClientDisconnect)
      }
      if (!isMetadata) {
        const success = !streamError && !clientDisconnected && response.statusCode >= 200 && response.statusCode < 300
        let settled = false
        try {
          await billing.settle({
            requestId, userId: identity.user.id, model, usage, price: price as PriceSnapshot,
            statusCode: streamError ? 499 : response.statusCode, success, latencyMs: Date.now() - started,
            estimatedUsage: !usage, upstreamModel: relay.upstreamModel, channelId: relay.channel.id, channelName: relay.channel.name,
            keyId: identity.key.id, keyName: identity.key.name, requestPath, requestMethod: request.method,
            upstreamRequestId, errorCode: streamError ? 'stream_interrupted' : success ? null : 'upstream_http_error',
            errorSummary: streamError ? '流式响应中断' : null, attemptCount: relay.attempts.length,
          })
          settled = true
        } catch (billingError) {
          await billing.release(requestId).catch(() => undefined)
          app.log.error({ err: billingError, requestId }, 'failed to settle streamed relay request')
        }
        if (settled) {
          await recordAttempts(db, requestId, relay.attempts, estimatedFailedAttemptCost(price as PriceSnapshot, parsed))
            .catch((error) => app.log.warn({ err: error, requestId }, 'failed to record streamed relay attempts'))
        }
      }
      try { if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end() } catch { /* noop */ }
      return
    }
    let data: Buffer
    try { data = await decodeResponseBuffer(Buffer.from(await response.body.arrayBuffer()), contentEncoding) } catch (error) {
      if (!isMetadata) {
        await billing.settle({
          requestId, userId: identity.user.id, model, usage: null, price: price as PriceSnapshot,
          statusCode: 502, success: false, latencyMs: Date.now() - started, estimatedUsage: true,
          upstreamModel: relay.upstreamModel, channelId: relay.channel.id, channelName: relay.channel.name,
          keyId: identity.key.id, keyName: identity.key.name, requestPath, requestMethod: request.method,
          upstreamRequestId, errorCode: 'upstream_body_error', errorSummary: '上游响应读取失败', attemptCount: relay.attempts.length,
        }).catch(async (billingError) => {
          await billing.release(requestId).catch(() => undefined)
          app.log.error({ err: billingError, requestId }, 'failed to release body-error reservation')
        })
        await recordAttempts(db, requestId, relay.attempts, estimatedFailedAttemptCost(price as PriceSnapshot, parsed)).catch(() => undefined)
      }
      reply.code(502).send({ error: { message: '上游响应读取失败', type: 'upstream_error', request_id: requestId } })
      return
    }
    const parsedResponse = (() => { try { return JSON.parse(data.toString('utf8')) } catch { return null } })()
    if (!isMetadata) {
      const usage = usageFromPayload(parsedResponse)
      const success = response.statusCode >= 200 && response.statusCode < 300
      const upstreamError = success ? null : upstreamErrorDetails(parsedResponse)
      try {
        await billing.settle({
          requestId, userId: identity.user.id, model, usage, price: price as PriceSnapshot,
          statusCode: response.statusCode, success, latencyMs: Date.now() - started, estimatedUsage: !usage,
          upstreamModel: String(parsedResponse?.model || relay.upstreamModel || model), channelId: relay.channel.id, channelName: relay.channel.name,
          keyId: identity.key.id, keyName: identity.key.name, requestPath, requestMethod: request.method,
          upstreamRequestId, errorCode: upstreamError?.code || null, errorSummary: upstreamError?.summary || null,
          attemptCount: relay.attempts.length,
        })
      } catch (billingError) {
        await billing.release(requestId).catch(() => undefined)
        app.log.error({ err: billingError, requestId }, 'failed to settle relay request')
        reply.code(500).send({ error: { message: '账务结算失败，请稍后重试', type: 'billing_error', request_id: requestId } })
        return
      }
      // Attempt analytics are deliberately best-effort. A database hiccup in
      // this secondary table must not turn an already-settled paid response
      // into a 500 (or cause a second billing action on retry).
      await recordAttempts(db, requestId, relay.attempts, estimatedFailedAttemptCost(price as PriceSnapshot, parsed))
        .catch((error) => app.log.warn({ err: error, requestId }, 'failed to record relay attempts'))
    }
    reply.code(response.statusCode)
    for (const [key, value] of Object.entries(responseHeaders)) if (shouldForwardRelayResponseHeader(key) && value !== undefined) reply.header(key, value as any)
    // Billing above always receives the unmodified upstream metadata.
    const successfulAgnesResponse = relay.responseAdapter === 'agnes_responses'
      && response.statusCode >= 200 && response.statusCode < 300 && parsedResponse
    const outgoingData = successfulAgnesResponse
      ? Buffer.from(JSON.stringify(chatToResponses(parsedResponse, model)))
      : rewriteModel ? Buffer.from(rewritePublicModel(data.toString('utf8'), model)) : data
    reply.send(outgoingData)
  }

  // CC Switch installations created before v1.0.6 sometimes retain the host
  // root as their endpoint instead of `/v1`. Keep common OpenAI paths working
  // at the root so those providers can be repaired without deleting keys.
  const rootApiRoutes = [
    '/models/*', '/chat/completions', '/responses', '/embeddings',
    '/moderations', '/images/generations', '/images/edits', '/audio/speech',
    '/audio/transcriptions', '/audio/translations', '/video/generations',
  ]
  app.all('/v1/*', (request, reply) => relayRequest(request, reply, '/v1'))
  for (const route of rootApiRoutes) app.all(route, (request, reply) => relayRequest(request, reply, ''))

  app.setErrorHandler((error: any, _request, reply) => { if (!reply.sent) reply.code(errorStatus(error)).send({ error: { message: error?.message || '服务器错误' } }) })
  app.get('/api/admin/laya-shadow', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    reply.header('Cache-Control', 'no-store')
    return layaShadow.snapshot()
  })
  app.addHook('onClose', async () => { await layaShadow.close(); await redis.close() })
  return { app, db, redis, config, auth, billing, affiliate, channels, orders, mail, profit }
}

async function recordAttempts(db: Database, requestId: string, attempts: any[], failedAttemptCostMicros = 0n): Promise<void> {
  for (const [index, attempt] of attempts.entries()) {
    const failed = attempt.outcome !== 'success'
    await db.query(`INSERT INTO relay_attempts(
      request_id,channel_id,channel_name_snapshot,attempt_no,attempt_number,upstream_model,status_code,outcome,
      error_type,error_message,error_code,retryable,cost_micros,cost_estimated,latency_ms,duration_ms,is_final,finished_at)
      VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13,$13,$14,now())
      ON CONFLICT(request_id,attempt_no) DO UPDATE SET
        channel_name_snapshot=excluded.channel_name_snapshot,upstream_model=excluded.upstream_model,
        status_code=excluded.status_code,outcome=excluded.outcome,error_type=excluded.error_type,
        error_message=excluded.error_message,retryable=excluded.retryable,cost_micros=excluded.cost_micros,
        latency_ms=excluded.latency_ms,duration_ms=excluded.duration_ms,is_final=excluded.is_final,finished_at=excluded.finished_at`,
    [requestId, attempt.channelId, attempt.channelName || null, attempt.attemptNo, attempt.upstreamModel || null,
      attempt.statusCode ?? null, attempt.outcome || (attempt.statusCode && attempt.statusCode < 400 ? 'success' : 'client_error'),
      attempt.errorType || null, String(attempt.errorMessage || '').slice(0, 1000) || null,
      String(attempt.errorCode || '').slice(0, 120) || null, Boolean(attempt.retryable),
      failed ? failedAttemptCostMicros.toString() : '0', Math.max(0, Number(attempt.latencyMs) || 0), index === attempts.length - 1])
  }
}

export async function start(): Promise<void> {
  const config = loadConfig()
  const services = await buildApp(config)
  try {
    await services.db.migrate()
    await services.auth.ensureAdmin()
  } catch (error) {
    if (config.env === 'production') {
      await services.redis.close().catch(() => undefined)
      await services.db.close().catch(() => undefined)
      throw error
    }
    services.app.log.warn({ err: error }, 'database bootstrap unavailable; serving health/static routes')
  }
  const media = new MediaService(services.db, config)
  let mediaBusy = false
  const mediaTimer = setInterval(() => { if(mediaBusy)return;mediaBusy=true;void media.tick().catch((error)=>services.app.log.error({ err: error }, 'Media worker tick failed')).finally(()=>{mediaBusy=false}) }, 3000)
  mediaTimer.unref()
  let creditBusy = false
  const creditTimer = setInterval(() => { if(creditBusy)return;creditBusy=true;void services.orders.reconcilePending(25).catch(()=>services.app.log.error('Order credit reconciliation failed')).finally(()=>{creditBusy=false}) }, 30000)
  creditTimer.unref()
  let paymentQueryBusy = false
  const paymentQueryTimer = setInterval(() => {
    if (paymentQueryBusy) return
    paymentQueryBusy = true
    void optionalPaymentGateway(config)
      .then((gateway) => gateway ? services.orders.reconcilePendingProviderPayments((orderNo) => gateway.queryNativeOrder(orderNo, 'wechat'), 20) : undefined)
      .catch(() => services.app.log.warn('WeChat payment reconciliation failed'))
      .finally(() => { paymentQueryBusy = false })
  }, 60_000)
  paymentQueryTimer.unref()
  services.app.addHook('onClose',async()=>{clearInterval(mediaTimer);clearInterval(creditTimer);clearInterval(paymentQueryTimer)})
  await services.app.listen({ host: config.host, port: config.port })
}

if (import.meta.url === `file://${process.argv[1]}`) start().catch((error) => { console.error(error); process.exitCode = 1 })
