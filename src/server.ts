import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import sensible from '@fastify/sensible'
import fastifyStatic from '@fastify/static'
import QRCode from 'qrcode'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { loadConfig, type AppConfig } from './config.js'
import { Database } from './db/index.js'
import { RedisStore } from './db/redis.js'
import { AuthService, type PublicUser } from './services/auth.js'
import { BillingService, type PriceSnapshot } from './services/billing.js'
import { AffiliateService } from './services/affiliate.js'
import { ChannelService } from './services/channels.js'
import { OrderService } from './services/orders.js'
import { MailService } from './services/mail.js'
import { buildCcswitchImportLink } from './lib/ccswitch.js'
import { calculateUsageMoney, estimatedRequestTokens, formatMicros, sellForGrossMargin, yuanToMicros } from './lib/money.js'
import { parseSseUsage, usageFromPayload } from './lib/usage.js'

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
}

const OPENAI_PRICING_SOURCE = 'https://developers.openai.com/api/docs/pricing'
const OPENAI_FX_MICROS = 7_200_000n
const OPENAI_TOKEN_PRICES: Record<string, readonly [number, number, number]> = {
  // OpenAI official standard prices per 1M tokens, captured 2026-09-01.
  // Values are input, output, and cached-input USD respectively.
  'gpt-5.6-sol': [4, 20, 0.4],
  'gpt-5.6-terra': [2, 12, 0.2],
  'gpt-5.6-luna': [0.2, 1.2, 0.02],
  'gpt-5.3-codex': [1.75, 14, 0.175],
  'chat-latest': [5, 30, 0.5],
  'gpt-5': [1.25, 10, 0.125],
  'gpt-5-mini': [0.25, 2, 0.025],
  'gpt-5-nano': [0.05, 0.4, 0.005],
  'gpt-4.1': [2, 8, 0.5],
  'gpt-4.1-mini': [0.4, 1.6, 0.1],
  'gpt-4.1-nano': [0.1, 0.4, 0.025],
  'gpt-4o': [2.5, 10, 1.25],
  'gpt-4o-mini': [0.15, 0.6, 0.075],
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

function grossMarginSell(costMicros: bigint, marginBps: bigint): bigint {
  return sellForGrossMargin(costMicros, marginBps)
}

function officialCostMicros(usdPerMillion: number): bigint {
  const scaledUsd = BigInt(Math.round(usdPerMillion * 1_000_000))
  return (scaledUsd * OPENAI_FX_MICROS + 999_999n) / 1_000_000n
}

function cleanText(value: unknown, name: string, max = 256): string {
  const text = String(value ?? '').trim()
  if (!text || text.length > max) throw new Error(`${name}无效`)
  return text
}

function responseHeader(headers: Record<string, string | string[] | undefined>, names: string[]): string | null {
  for (const name of names) {
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
    const value = Array.isArray(entry) ? entry[0] : entry
    if (value) return String(value).slice(0, 256)
  }
  return null
}

function upstreamErrorSummary(payload: any): string | null {
  if (!payload || typeof payload !== 'object') return null
  return '上游返回错误'
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

  const requireSession = async (request: any, reply: any): Promise<PublicUser | null> => {
    try {
      await request.jwtVerify()
      const payload = request.user as any
      const user = await db.one<any>(`SELECT id, username, email, email_verified_at, role, invite_code, created_at, disabled_at, status
        FROM users WHERE id = $1`, [payload.sub])
      if (!user || user.disabled_at || user.status !== 'active') throw new Error('登录已失效')
      return { id: String(user.id), username: user.username, email: user.email || null, emailVerified: Boolean(user.email_verified_at), role: user.role === 'admin' ? 'admin' : 'user', inviteCode: user.invite_code, createdAt: new Date(user.created_at).toISOString() }
    } catch {
      reply.code(401).send({ error: { message: '请先登录', type: 'authentication_error' } })
      return null
    }
  }
  const requireAdmin = async (request: any, reply: any): Promise<PublicUser | null> => {
    const user = await requireSession(request, reply)
    if (user && user.role !== 'admin') { reply.code(403).send({ error: { message: '需要管理员权限' } }); return null }
    return user
  }

  app.get('/healthz', async () => ({ ok: true, service: 'relay-station' }))
  app.get('/', async (_request, reply) => reply.sendFile('index.html'))
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
      const token = app.jwt.sign({ sub: user.id, role: user.role }, { expiresIn: '7d' })
      reply.setCookie('relay_session', token, { httpOnly: true, sameSite: 'lax', secure: config.env === 'production', path: '/', maxAge: 7 * 86400 })
      return { user }
    } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) }
  })

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
      const body = (request.body || {}) as any
      const user = await auth.login(String(body.username || ''), String(body.password || ''))
      const token = app.jwt.sign({ sub: user.id, role: user.role }, { expiresIn: '7d' })
      reply.setCookie('relay_session', token, { httpOnly: true, sameSite: 'lax', secure: config.env === 'production', path: '/', maxAge: 7 * 86400 })
      return { user }
    } catch (error) { reply.code(401).send({ error: { message: '账号或密码错误' } }) }
  })
  app.post('/api/auth/logout', async (_request, reply) => { reply.clearCookie('relay_session', { path: '/' }); return { ok: true } })
  app.get('/api/auth/me', async (request, reply) => { const user = await requireSession(request, reply); return user ? { user } : undefined })

  app.get('/api/me/overview', async (request, reply) => {
    const user = await requireSession(request, reply); if (!user) return
    const balance = await billing.balance(user.id)
    return { user, balance: BillingService.formatBalance(balance), apiBaseUrl: `${config.publicBaseUrl}/v1`, downloads: { chatgpt: config.chatgptDownloadUrl, ccswitch: config.ccswitchDownloadUrl }, mailConfigured: mail.configured }
  })
  app.get('/api/me/balance', async (request, reply) => {
    const user = await requireSession(request, reply); if (!user) return
    return { data: BillingService.formatBalance(await billing.balance(user.id)) }
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
      if (cursor) { values.push(new Date(cursor.t), cursor.id); where.push(`(u.started_at, u.request_id) < ($${values.length - 1}, $${values.length})`) }
      const rows = await db.query<any>(`SELECT
          u.created_at, u.started_at, u.request_id, u.api_key_id, u.key_id,
          u.api_key_name_snapshot, u.requested_model, u.upstream_model,
          u.final_channel_id, u.final_channel_name_snapshot,
          u.input_tokens, u.output_tokens, u.cache_tokens, u.reported_total_tokens,
          u.plan_charge_micros, u.wallet_charge_micros, u.charge_micros,
          u.cost_micros, u.profit_micros,
          u.status_code, u.status, u.success, u.duration_ms, u.latency_ms,
          u.is_estimated_usage, u.estimated_usage,
          k.name AS current_key_name, c.name AS current_channel_name
        FROM usage_logs u
        LEFT JOIN api_keys k ON k.id = COALESCE(u.api_key_id, u.key_id)
        LEFT JOIN channels c ON c.id = u.final_channel_id
        WHERE ${where.join(' AND ')} ORDER BY u.started_at DESC, u.request_id DESC LIMIT ${limit + 1}`, values)
      const items = rows.slice(0, limit).map((row) => ({
        time: row.started_at || row.created_at, requestId: row.request_id,
        keyId: row.api_key_id || row.key_id, keyName: row.api_key_name_snapshot || row.current_key_name || '',
        model: row.requested_model, upstreamModel: row.upstream_model,
        channel: row.final_channel_name_snapshot || row.current_channel_name || '',
        inputTokens: String(row.input_tokens), outputTokens: String(row.output_tokens), cacheTokens: String(row.cache_tokens), totalTokens: String(row.reported_total_tokens),
        planCharge: publicMoney(row.plan_charge_micros), walletCharge: publicMoney(row.wallet_charge_micros), charge: publicMoney(row.charge_micros),
        estimatedCost: publicMoney(row.cost_micros), profit: publicMoney(row.profit_micros),
        statusCode: row.status_code, status: row.status, success: row.success,
        latencyMs: Number(row.duration_ms ?? row.latency_ms ?? 0), estimatedUsage: Boolean(row.is_estimated_usage ?? row.estimated_usage),
      }))
      const nextCursor = rows.length > limit ? encodeCursor(rows[limit - 1].started_at || rows[limit - 1].created_at, rows[limit - 1].request_id) : null
      const summary = await db.one<any>(`SELECT count(*)::int AS requests,
        COALESCE(sum(charge_micros),0)::bigint AS charge,
        COALESCE(sum(plan_charge_micros),0)::bigint AS plan_charge,
        COALESCE(sum(wallet_charge_micros),0)::bigint AS wallet_charge,
        COALESCE(sum(cost_micros),0)::bigint AS cost,
        COALESCE(sum(profit_micros),0)::bigint AS profit,
        COALESCE(sum(input_tokens),0)::bigint AS input,
        COALESCE(sum(output_tokens),0)::bigint AS output,
        COALESCE(sum(cache_tokens),0)::bigint AS cache
        FROM usage_logs u WHERE ${filterWhere.join(' AND ')}`, filterValues)
      return { items, nextCursor, summary: {
        requests: Number(summary?.requests || 0), charge: publicMoney(summary?.charge),
        planCharge: publicMoney(summary?.plan_charge), walletCharge: publicMoney(summary?.wallet_charge),
        estimatedCost: publicMoney(summary?.cost), profit: publicMoney(summary?.profit),
        inputTokens: String(summary?.input || 0), outputTokens: String(summary?.output || 0), cacheTokens: String(summary?.cache || 0),
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

  app.get('/api/downloads', async () => ({ chatgpt: config.chatgptDownloadUrl, ccswitch: config.ccswitchDownloadUrl }))

  app.get('/api/plans', async () => ({ items: await db.query<any>('SELECT id, name, price_micros, quota_micros FROM plans WHERE active = true AND enabled = true ORDER BY price_micros ASC') }))
  app.post('/api/orders', async (request, reply) => {
    const user = await requireSession(request, reply); if (!user) return
    let created: Awaited<ReturnType<OrderService['create']>> | null = null
    try {
      const body = (request.body || {}) as any
      const kind = body.kind === 'subscription' ? 'subscription' : 'wallet_topup'
      const method = body.paymentMethod === 'alipay' ? 'alipay' : 'wechat'
      const planId = kind === 'subscription' ? String(body.planId || '') : null
      if (kind === 'subscription' && !planId) throw new Error('请选择套餐')
      let amountMicros: bigint | undefined
      if (kind === 'wallet_topup') {
        try { amountMicros = BigInt(String(body.amountMicros ?? body.amount ?? 0)) } catch { throw new Error('金额格式无效') }
      }
      created = await orders.create(user.id, { kind, amountMicros, planId, paymentMethod: method })
      const gateway = await optionalPaymentGateway(config)
      if (!gateway) throw Object.assign(new Error('支付渠道尚未配置'), { statusCode: 503 })
      const native = await gateway.createNativeOrder({ orderId: created.orderNo, description: kind === 'subscription' ? 'GPT TOKEN 月套餐' : 'GPT TOKEN 钱包充值', amountMicros: created.amountMicros.toString(), paymentMethod: method, expiresAt: created.expiresAt })
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

  app.get('/api/orders', async (request, reply) => { const user = await requireSession(request, reply); return user ? { items: await db.query<any>('SELECT id, order_no, kind, amount_micros, payment_method, status, qr_code_url, created_at, paid_at, expires_at FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [user.id]) } : undefined })

  app.get('/api/admin/channels', async (request, reply) => { if (!await requireAdmin(request, reply)) return; return { items: await channels.allForAdmin() } })
  app.post('/api/admin/channels', async (request, reply) => { if (!await requireAdmin(request, reply)) return; try { return await channels.upsert(request.body as any) } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) } })
  app.delete('/api/admin/channels/:id', async (request, reply) => { if (!await requireAdmin(request, reply)) return; await channels.remove(String((request.params as any).id)); return { ok: true } })
  app.get('/api/admin/prices', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    return { items: await db.query<any>('SELECT * FROM model_prices ORDER BY model_pattern') }
  })
  app.post('/api/admin/prices', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
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
        String(b.priceSource || 'manual').slice(0, 512), b.priceEffectiveAt ? new Date(String(b.priceEffectiveAt)) : new Date(), b.fxRateMicros ? moneyInput(b.fxRateMicros, '汇率') : null,
      ]
      return await db.one<any>(`INSERT INTO model_prices(
        model_pattern,input_cost_micros,output_cost_micros,cache_cost_micros,
        input_sell_micros,output_sell_micros,cache_sell_micros,fixed_cost_micros,fixed_sell_micros,active,
        input_cost_micros_per_million,output_cost_micros_per_million,cache_cost_micros_per_million,
        input_sell_micros_per_million,output_sell_micros_per_million,cache_sell_micros_per_million,
        price_source,price_effective_at,fx_rate_cny_micros)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$2,$3,$4,$5,$6,$7,$11,$12,$13)
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
          price_source=excluded.price_source, price_effective_at=excluded.price_effective_at,
          fx_rate_cny_micros=excluded.fx_rate_cny_micros,
          active=excluded.active, updated_at=now() RETURNING *`, values)
    } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) }
  })
  app.delete('/api/admin/prices/:id', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    await db.query('UPDATE model_prices SET active = false, updated_at = now() WHERE id = $1', [String((request.params as any).id)])
    return { ok: true }
  })

  app.get('/api/admin/fixed-prices', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    return { items: await db.query<any>('SELECT * FROM fixed_route_prices ORDER BY match_priority, path_pattern') }
  })
  app.post('/api/admin/fixed-prices', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
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
      const sell = b.sellYuan !== undefined ? yuanInput(b.sellYuan, '固定售价') : b.sellMicros !== undefined ? moneyInput(b.sellMicros, '固定售价') : grossMarginSell(cost, BigInt(marginBps)).toString()
      if (b.id) {
        return await db.one<any>(`UPDATE fixed_route_prices SET http_method=$1,path_pattern=$2,requested_model=$3,cost_micros=$4,sell_micros=$5,enabled=$6,match_priority=$7,selectors=$8,unit_path=$9,unit_mode=$10,updated_at=now() WHERE id=$11 RETURNING *`,
          [method, pathPattern, model, cost.toString(), sell, b.enabled !== false, Math.max(0, Number(b.matchPriority ?? 100) || 0), JSON.stringify(selectors), unitPath, unitMode, String(b.id)])
      }
      return await db.one<any>(`INSERT INTO fixed_route_prices(http_method,path_pattern,requested_model,cost_micros,sell_micros,enabled,match_priority,selectors,unit_path,unit_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [method, pathPattern, model, cost.toString(), sell, b.enabled !== false, Math.max(0, Number(b.matchPriority ?? 100) || 0), JSON.stringify(selectors), unitPath, unitMode])
    } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) }
  })
  app.delete('/api/admin/fixed-prices/:id', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    await db.query('UPDATE fixed_route_prices SET enabled=false, updated_at=now() WHERE id=$1', [String((request.params as any).id)])
    return { ok: true }
  })

  app.get('/api/admin/plans', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    return { items: await db.query<any>('SELECT * FROM plans ORDER BY display_order, created_at DESC') }
  })
  app.post('/api/admin/plans', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    try {
      const b = (request.body || {}) as any
      const code = cleanText(b.code, '套餐代码', 64)
      const name = cleanText(b.name, '套餐名称', 128)
      const price = b.priceYuan !== undefined ? yuanInput(b.priceYuan, '套餐价格', false) : moneyInput(b.priceMicros, '套餐价格', false)
      const quota = b.quotaYuan !== undefined ? yuanInput(b.quotaYuan, '套餐额度', false) : moneyInput(b.quotaMicros, '套餐额度', false)
      const order = Math.max(0, Number(b.displayOrder ?? 100) || 0)
      if (b.id) return await db.one<any>(`UPDATE plans SET code=$1,name=$2,price_micros=$3,quota_micros=$4,duration_days=30,active=$5,enabled=$5,display_order=$6,updated_at=now() WHERE id=$7 RETURNING *`, [code, name, price, quota, b.active !== false, order, String(b.id)])
      return await db.one<any>(`INSERT INTO plans(code,name,price_micros,quota_micros,duration_days,active,enabled,display_order) VALUES($1,$2,$3,$4,30,$5,$5,$6) RETURNING *`, [code, name, price, quota, b.active !== false, order])
    } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) }
  })
  app.delete('/api/admin/plans/:id', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    await db.query('UPDATE plans SET active=false, enabled=false, updated_at=now() WHERE id=$1', [String((request.params as any).id)])
    return { ok: true }
  })
  app.post('/api/admin/bootstrap/openai-prices', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    try {
      const mapped = await db.query<any>(`SELECT DISTINCT requested_model FROM channel_model_mappings WHERE enabled = true
        UNION SELECT DISTINCT jsonb_object_keys(model_map) FROM channels WHERE enabled = true AND jsonb_typeof(model_map) = 'object'`)
      const models = [...new Set(mapped.map((row) => String(row.requested_model || row.jsonb_object_keys || '').trim()).filter((model) => Object.hasOwn(OPENAI_TOKEN_PRICES, model)))]
      if (!models.length) throw new Error('没有发现已启用渠道映射的 OpenAI 模型，未初始化价格')
      const effectiveAt = new Date()
      const inserted: string[] = []
      await db.tx(async (client) => {
        for (const model of models) {
          const [inputUsd, outputUsd, cacheUsd] = OPENAI_TOKEN_PRICES[model]
          const input = officialCostMicros(inputUsd)
          const output = officialCostMicros(outputUsd)
          const cache = officialCostMicros(cacheUsd)
          const values = [model, input, output, cache, grossMarginSell(input, 8000n), grossMarginSell(output, 8000n), grossMarginSell(cache, 8000n)]
          await client.query(`INSERT INTO model_prices(
            model_pattern,input_cost_micros,output_cost_micros,cache_cost_micros,input_sell_micros,output_sell_micros,cache_sell_micros,
            input_cost_micros_per_million,output_cost_micros_per_million,cache_cost_micros_per_million,input_sell_micros_per_million,output_sell_micros_per_million,cache_sell_micros_per_million,
            active,price_source,price_effective_at,fx_rate_cny_micros)
            VALUES($1,$2,$3,$4,$5,$6,$7,$2,$3,$4,$5,$6,$7,true,$8,$9,$10)
            ON CONFLICT(model_pattern) DO UPDATE SET
              input_cost_micros=excluded.input_cost_micros,output_cost_micros=excluded.output_cost_micros,cache_cost_micros=excluded.cache_cost_micros,
              input_sell_micros=excluded.input_sell_micros,output_sell_micros=excluded.output_sell_micros,cache_sell_micros=excluded.cache_sell_micros,
              input_cost_micros_per_million=excluded.input_cost_micros_per_million,output_cost_micros_per_million=excluded.output_cost_micros_per_million,cache_cost_micros_per_million=excluded.cache_cost_micros_per_million,
              input_sell_micros_per_million=excluded.input_sell_micros_per_million,output_sell_micros_per_million=excluded.output_sell_micros_per_million,cache_sell_micros_per_million=excluded.cache_sell_micros_per_million,
              active=true,price_source=excluded.price_source,price_effective_at=excluded.price_effective_at,fx_rate_cny_micros=excluded.fx_rate_cny_micros,updated_at=now()`,
            [...values.map((value) => typeof value === 'bigint' ? value.toString() : value), OPENAI_PRICING_SOURCE, effectiveAt, OPENAI_FX_MICROS.toString()],
          )
          inserted.push(model)
        }
      })
      return { items: inserted, fxRate: '7.20', margin: '80%', source: OPENAI_PRICING_SOURCE, effectiveAt: effectiveAt.toISOString() }
    } catch (error) { reply.code(errorStatus(error)).send({ error: { message: (error as Error).message } }) }
  })
  app.post('/api/admin/bootstrap/monthly-plan', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    const row = await db.one<any>(`WITH updated AS (
        UPDATE plans SET name='月套餐',price_micros=149000000,quota_micros=59600000,duration_days=30,active=true,enabled=true,display_order=10,updated_at=now()
        WHERE lower(code)=lower('monthly-149') RETURNING *
      ), inserted AS (
        INSERT INTO plans(code,name,price_micros,quota_micros,duration_days,active,enabled,display_order)
        SELECT 'monthly-149','月套餐',149000000,59600000,30,true,true,10 WHERE NOT EXISTS (SELECT 1 FROM updated)
        RETURNING *
      ) SELECT * FROM updated UNION ALL SELECT * FROM inserted LIMIT 1`)
    return { item: row, priceYuan: '149.00', quotaYuan: '59.60', grossMargin: '60%' }
  })

  app.get('/api/admin/users', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    const q = (request.query || {}) as any
    const values: unknown[] = []
    const where: string[] = []
    if (q.status) { values.push(String(q.status)); where.push(`u.status=$${values.length}`) }
    if (q.search) { values.push(`%${String(q.search).slice(0, 128)}%`); where.push(`u.username ILIKE $${values.length}`) }
    return { items: await db.query<any>(`SELECT u.id,u.username,u.role,u.status,u.invite_code,u.last_login_at,u.created_at,u.disabled_at,w.balance_micros,aw.balance_micros AS affiliate_balance_micros FROM users u LEFT JOIN wallets w ON w.user_id=u.id LEFT JOIN affiliate_wallets aw ON aw.user_id=u.id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY u.created_at DESC LIMIT 200`, values) }
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
    return { items: await db.query<any>(`SELECT o.*,u.username,p.name AS plan_name FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN plans p ON p.id=o.plan_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.created_at DESC LIMIT ${boundedLimit(q.limit, 100, 500)}`, values) }
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
      return { items: rows }
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
    if (!await requireAdmin(request, reply)) return
    const b = (request.body || {}) as any
    const enabled = b.enabled !== false
    const rateBps = Number(b.rateBps)
    if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000) { reply.code(400).send({ error: { message: '返利比例应为 0-10000 基点' } }); return }
    await db.tx(async (client) => {
      await client.query(`INSERT INTO app_settings(key,value) VALUES('affiliate_enabled',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()`, [String(enabled)])
      await client.query(`INSERT INTO app_settings(key,value) VALUES('affiliate_rate_bps',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()`, [String(rateBps)])
    })
    return { enabled, rateBps }
  })
  app.get('/api/admin/settings', async (request, reply) => {
    if (!await requireAdmin(request, reply)) return
    return { items: await db.query<any>('SELECT key, value, updated_at FROM app_settings ORDER BY key'), mail: mail.status }
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
        planExpiresAt: balance.planExpiresAt, unit: 'CNY', isValid: balance.isValid, updatedAt: new Date().toISOString(),
      }
      // Current CC Switch accepts response.data while older import scripts read
      // the root object. Keep both projections numerically compatible.
      return { success: true, ...data, data }
    } catch (error) { reply.code(401).send({ error: { message: (error as Error).message, type: 'authentication_error' } }) }
  }
  const modelCatalog = async (request: any, reply: any) => {
    reply.header('Cache-Control', 'public, max-age=300')
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
    const isMetadata = request.method === 'GET' && (path === '/models' || path.startsWith('/models/'))
    const requestPath = `/v1${path}`
    let price: PriceSnapshot | null = null
    if (!isMetadata) {
      try {
        price = await billing.priceForRequest(request.method, requestPath, model, parsed)
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
    const started = Date.now()
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(request.headers as Record<string, string | string[] | undefined>)) if (typeof value === 'string') headers[key] = value
    let relay: any
    const query = (request.raw.url || '').includes('?') ? `?${String(request.raw.url).split('?').slice(1).join('?')}` : ''
    try { relay = await channels.relay(path + query, request.method, headers, body, model) } catch (error: any) {
      if (!isMetadata) {
        try {
          await billing.settle({
            requestId, userId: identity.user.id, model, usage: null, price: price as PriceSnapshot,
            statusCode: 502, success: false, latencyMs: Date.now() - started, estimatedUsage: true,
            upstreamModel: '', channelId: null, channelName: null,
            keyId: identity.key.id, keyName: identity.key.name, requestPath, requestMethod: request.method,
            errorCode: 'upstream_unavailable', errorSummary: '所有上游渠道均不可用',
            attemptCount: Array.isArray(error?.attempts) ? error.attempts.length : 0,
          })
          if (Array.isArray(error?.attempts)) await recordAttempts(db, requestId, error.attempts, estimatedFailedAttemptCost(price as PriceSnapshot, parsed))
        } catch (billingError) {
          await billing.release(requestId).catch(() => undefined)
          app.log.error({ err: billingError, requestId }, 'failed to release relay reservation')
        }
      }
      reply.code(502).send({ error: { message: '上游渠道不可用', type: 'upstream_error', request_id: requestId } }); return
    }
    const response = relay.response
    const responseHeaders = response.headers as Record<string, string | string[] | undefined>
    const upstreamRequestId = responseHeader(responseHeaders, ['x-request-id', 'openai-request-id', 'request-id'])
    const isSse = String(responseHeaders['content-type'] || '').includes('text/event-stream')
    if (isSse) {
      reply.hijack()
      reply.raw.statusCode = response.statusCode
      reply.raw.setHeader('X-Request-Id', requestId)
      for (const [key, value] of Object.entries(responseHeaders)) if (!['content-length', 'transfer-encoding', 'connection', 'set-cookie'].includes(key.toLowerCase()) && value !== undefined) reply.raw.setHeader(key, value as any)
      const decoder = new StringDecoder('utf8')
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
        for await (const chunk of response.body as any) {
          if (clientDisconnected || reply.raw.destroyed || reply.raw.writableEnded) throw new Error('客户端连接已关闭')
          const buffer = Buffer.from(chunk)
          consumeUsage(decoder.write(buffer))
          if (!reply.raw.write(buffer)) await waitForWritableDrain(reply.raw)
        }
        if (clientDisconnected) throw new Error('客户端连接已关闭')
        consumeUsage(`${decoder.end()}\n`)
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
    try { data = Buffer.from(await response.body.arrayBuffer()) } catch (error) {
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
      try {
        await billing.settle({
          requestId, userId: identity.user.id, model, usage, price: price as PriceSnapshot,
          statusCode: response.statusCode, success, latencyMs: Date.now() - started, estimatedUsage: !usage,
          upstreamModel: String(parsedResponse?.model || relay.upstreamModel || model), channelId: relay.channel.id, channelName: relay.channel.name,
          keyId: identity.key.id, keyName: identity.key.name, requestPath, requestMethod: request.method,
          upstreamRequestId, errorCode: success ? null : 'upstream_http_error', errorSummary: success ? null : upstreamErrorSummary(parsedResponse),
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
    for (const [key, value] of Object.entries(responseHeaders)) if (!['content-length', 'transfer-encoding', 'connection', 'set-cookie'].includes(key.toLowerCase()) && value !== undefined) reply.header(key, value as any)
    reply.send(data)
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
  app.addHook('onClose', async () => { await redis.close() })
  return { app, db, redis, config, auth, billing, affiliate, channels, orders, mail }
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
  await services.app.listen({ host: config.host, port: config.port })
}

if (import.meta.url === `file://${process.argv[1]}`) start().catch((error) => { console.error(error); process.exitCode = 1 })
