import { request, type Dispatcher } from 'undici'
import { decryptSecret } from '../lib/crypto.js'
import type { AppConfig } from '../config.js'
import { Database } from '../db/index.js'

export type Channel = {
  id: string
  name: string
  baseUrl: string
  encryptedApiKey: string
  priority: number
  modelMap: Record<string, string>
  timeoutMs: number
}

export type RelayAttempt = {
  channelId: string
  channelName: string
  attemptNo: number
  statusCode: number | null
  errorType: string | null
  errorMessage: string | null
  latencyMs: number
  upstreamModel?: string
  outcome?: 'success' | 'network_error' | 'timeout' | 'rate_limited' | 'server_error' | 'client_error' | 'canceled'
  retryable?: boolean
  errorCode?: string | null
}

export type RelayResult = {
  response: Dispatcher.ResponseData
  channel: Channel
  attempts: RelayAttempt[]
  upstreamModel: string
}

function jsonMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((result, [key, item]) => {
    if (typeof item === 'string') result[key] = item
    return result
  }, {})
}

/** A channel must opt in to each billed model it can serve. */
export function supportsRequestedModel(channel: Pick<Channel, 'modelMap'>, requestedModel: string): boolean {
  if (!requestedModel) return true
  return Object.hasOwn(channel.modelMap, requestedModel) || Object.hasOwn(channel.modelMap, '*')
}

/**
 * Only transient upstream failures are retried.  A normal client error is
 * returned to the caller so that an invalid request is not sent to every
 * configured provider (and so providers do not see duplicate side effects).
 */
function shouldFailover(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

export function normalizeResponsesTools(parsed: any): void {
  if (!Array.isArray(parsed?.tools)) return
  parsed.tools = parsed.tools.map((tool: any) => {
    if (!tool || typeof tool !== 'object' || tool.type !== 'custom') return tool
    const custom = tool.custom && typeof tool.custom === 'object' ? tool.custom : tool
    const format = custom.format && typeof custom.format === 'object' ? custom.format : null
    let parameters = custom.parameters || custom.input_schema || custom.schema
    // Responses custom tools may carry a grammar instead of JSON Schema. The
    // upstream accepts function tools only, so expose a permissive object
    // shape and keep the original description/name for model compatibility.
    if (!parameters && format && format.type === 'json_schema') parameters = format.schema || format.value
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) parameters = { type: 'object', properties: {}, additionalProperties: true }
    return {
      type: 'function',
      name: String(custom.name || tool.name || 'custom_tool').slice(0, 256),
      description: typeof custom.description === 'string' ? custom.description.slice(0, 4096) : undefined,
      parameters,
      strict: custom.strict === true || tool.strict === true,
    }
  })
}

function rewriteRequestBody(body: Buffer | undefined, requestedModel: string, upstreamModel: string, path: string): Buffer | undefined {
  if (!body || !body.length) return body
  // The relay accepts JSON OpenAI-compatible requests.  Keep malformed or
  // non-JSON payloads byte-for-byte intact; the upstream can then return its
  // normal validation response.
  try {
    const parsed = JSON.parse(body.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body
    let changed = false
    if (requestedModel && upstreamModel && requestedModel !== upstreamModel && Object.prototype.hasOwnProperty.call(parsed, 'model')) {
      parsed.model = upstreamModel
      changed = true
    }
    if (path === '/responses' && Array.isArray(parsed.tools) && parsed.tools.some((tool: any) => tool?.type === 'custom')) {
      normalizeResponsesTools(parsed)
      changed = true
    }
    return changed ? Buffer.from(JSON.stringify(parsed)) : body
  } catch { return body }
}

function errorType(error: any): string {
  const name = String(error?.name || '').toLowerCase()
  const code = String(error?.code || '').toLowerCase()
  if (name.includes('timeout') || code.includes('timeout')) return 'timeout'
  if (name.includes('abort') || code === 'aborted') return 'canceled'
  return 'network_error'
}

function responseOutcome(status: number): RelayAttempt['outcome'] {
  if (status === 429) return 'rate_limited'
  if (status >= 500 || status === 408) return status === 408 ? 'timeout' : 'server_error'
  return status >= 400 ? 'client_error' : 'success'
}

/**
 * Error objects may include a provider response body, and that body can echo
 * request content. Persist only an enumerated reason in relay_attempts.
 */
export function safeRelayError(kind: RelayAttempt['outcome']): Pick<RelayAttempt, 'errorType' | 'errorMessage' | 'errorCode'> {
  switch (kind) {
    case 'timeout':
      return { errorType: 'timeout', errorCode: 'upstream_timeout', errorMessage: '上游请求超时' }
    case 'canceled':
      return { errorType: 'canceled', errorCode: 'upstream_canceled', errorMessage: '上游请求已取消' }
    case 'network_error':
      return { errorType: 'network_error', errorCode: 'upstream_network_error', errorMessage: '上游网络错误' }
    case 'rate_limited':
      return { errorType: 'rate_limited', errorCode: 'upstream_rate_limited', errorMessage: '上游请求受限' }
    case 'server_error':
      return { errorType: 'server_error', errorCode: 'upstream_server_error', errorMessage: '上游服务错误' }
    case 'client_error':
      return { errorType: 'client_error', errorCode: 'upstream_client_error', errorMessage: '上游拒绝请求' }
    default:
      return { errorType: null, errorCode: null, errorMessage: null }
  }
}

export class ChannelService {
  constructor(private readonly db: Database, private readonly config: AppConfig) {}

  async list(): Promise<Channel[]> {
    const rows = await this.db.query<any>(`SELECT id, name, base_url, encrypted_api_key, priority, model_map, timeout_ms FROM channels WHERE enabled = true AND (circuit_open_until IS NULL OR circuit_open_until < now()) ORDER BY priority ASC, created_at ASC`)
    return rows.map((row) => ({ id: String(row.id), name: row.name, baseUrl: row.base_url, encryptedApiKey: row.encrypted_api_key, priority: Number(row.priority), modelMap: jsonMap(row.model_map), timeoutMs: Number(row.timeout_ms) || 30_000 }))
  }

  async allForAdmin(): Promise<any[]> {
    const rows = await this.db.query<any>(`SELECT id, name, base_url, priority, model_map, timeout_ms, enabled, failure_count, circuit_open_until, created_at, updated_at FROM channels ORDER BY priority ASC, created_at ASC`)
    return rows.map((row) => ({ id: String(row.id), name: row.name, baseUrl: row.base_url, priority: Number(row.priority), modelMap: row.model_map || {}, timeoutMs: Number(row.timeout_ms), enabled: row.enabled, failureCount: Number(row.failure_count), circuitOpenUntil: row.circuit_open_until, createdAt: row.created_at, updatedAt: row.updated_at }))
  }

  async upsert(input: { id?: string; name: string; baseUrl: string; apiKey?: string; priority?: number; modelMap?: Record<string, string>; timeoutMs?: number; enabled?: boolean }): Promise<any> {
    const { encryptSecret } = await import('../lib/crypto.js')
    const url = new URL(input.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('上游地址必须使用 HTTP(S)')
    if (input.id) {
      const current = await this.db.one<any>('SELECT encrypted_api_key FROM channels WHERE id = $1', [input.id])
      const encrypted = input.apiKey?.trim() ? encryptSecret(input.apiKey.trim(), this.config.channelEncryptionKey) : current?.encrypted_api_key
      const row = await this.db.one<any>(`UPDATE channels SET name=$1, base_url=$2, encrypted_api_key=$3, priority=$4, model_map=$5, timeout_ms=$6, enabled=$7, updated_at=now() WHERE id=$8 RETURNING id, name, base_url, priority, model_map, timeout_ms, enabled`, [input.name.trim(), url.toString().replace(/\/$/, ''), encrypted, Number(input.priority ?? 100), JSON.stringify(input.modelMap || {}), Math.max(1000, Number(input.timeoutMs || 30000)), input.enabled !== false, input.id])
      return row
    }
    if (!input.apiKey?.trim()) throw new Error('新增渠道必须填写上游 Key')
    const row = await this.db.one<any>(`INSERT INTO channels(name, base_url, encrypted_api_key, priority, model_map, timeout_ms, enabled) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, base_url, priority, model_map, timeout_ms, enabled`, [input.name.trim(), url.toString().replace(/\/$/, ''), encryptSecret(input.apiKey.trim(), this.config.channelEncryptionKey), Number(input.priority ?? 100), JSON.stringify(input.modelMap || {}), Math.max(1000, Number(input.timeoutMs || 30000)), input.enabled !== false])
    return row
  }

  async remove(id: string): Promise<void> {
    // Historical usage/attempt rows retain this channel. Deletion therefore
    // means disable, which is also reversible for an operator.
    await this.db.query('UPDATE channels SET enabled = false, updated_at = now() WHERE id = $1', [id])
  }

  async relay(path: string, method: string, headers: Record<string, string>, body: Buffer | undefined, requestedModel: string): Promise<RelayResult> {
    const channels = (await this.list()).filter((channel) => supportsRequestedModel(channel, requestedModel))
    if (!channels.length) throw new Error(requestedModel ? '当前模型没有已启用上游渠道，请联系管理员配置模型映射' : '暂无可用上游渠道，请联系管理员')
    const attempts: RelayAttempt[] = []
    for (let index = 0; index < channels.length; index += 1) {
      const channel = channels[index]
      const upstreamModel = channel.modelMap[requestedModel] || channel.modelMap['*'] || requestedModel
      const started = Date.now()
      const target = `${channel.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
      try {
        const apiKey = decryptSecret(channel.encryptedApiKey, this.config.channelEncryptionKey)
        const outgoingHeaders: Record<string, string> = {}
        for (const [key, value] of Object.entries(headers)) {
          const lower = key.toLowerCase()
          if (![
            'host', 'content-length', 'authorization', 'connection', 'cookie',
            'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
            'proxy-authorization', 'proxy-authenticate', 'upgrade',
          ].includes(lower)) outgoingHeaders[key] = value
        }
        outgoingHeaders.authorization = `Bearer ${apiKey}`
        const outgoingBody = rewriteRequestBody(body, requestedModel, upstreamModel, path)
        if (outgoingBody && outgoingBody !== body) {
          // The original content-length is deliberately removed above; undici
          // computes the new length from the rewritten payload.
          delete outgoingHeaders['content-length']
          delete outgoingHeaders['Content-Length']
        }
        const response = await request(target, { method: method as any, headers: outgoingHeaders, body: outgoingBody && outgoingBody.length ? outgoingBody : undefined, headersTimeout: channel.timeoutMs, bodyTimeout: channel.timeoutMs, maxRedirections: 0 })
        const latencyMs = Date.now() - started
        const retryable = shouldFailover(response.statusCode)
        const attempt: RelayAttempt = { channelId: channel.id, channelName: channel.name, attemptNo: index + 1, statusCode: response.statusCode, errorType: null, errorMessage: null, latencyMs }
        attempt.upstreamModel = upstreamModel
        attempt.retryable = retryable
        attempt.outcome = responseOutcome(response.statusCode)
        attempts.push(attempt)
        if (!retryable) {
          // Metrics/circuit bookkeeping must never turn an already successful
          // upstream response into a retry. The response path remains usable
          // during a transient PostgreSQL outage.
          await this.markSuccess(channel.id).catch(() => undefined)
          return { response, channel, attempts, upstreamModel }
        }
        await this.markFailure(channel.id).catch(() => undefined)
        // A retryable response can only be returned when it is the final
        // channel attempt. Earlier bodies must be drained before failover; do
        // not retain one of those drained responses and accidentally return it
        // after a later network error.
        if (index === channels.length - 1) return { response, channel, attempts, upstreamModel }
        try { for await (const _chunk of response.body as any) { /* drain */ } } catch { /* noop */ }
      } catch (error: any) {
        const latencyMs = Date.now() - started
        const kind = errorType(error)
        const safeError = safeRelayError(kind as RelayAttempt['outcome'])
        attempts.push({ channelId: channel.id, channelName: channel.name, attemptNo: index + 1, statusCode: null, latencyMs, outcome: kind as RelayAttempt['outcome'], retryable: true, upstreamModel, ...safeError })
        await this.markFailure(channel.id).catch(() => undefined)
      }
    }
    const error = new Error('所有上游渠道均不可用')
    ;(error as any).attempts = attempts
    throw error
  }

  async markFailure(id: string): Promise<void> {
    await this.db.query(`UPDATE channels SET failure_count = failure_count + 1, last_failure_at = now(), circuit_open_until = CASE WHEN failure_count + 1 >= 3 THEN now() + interval '30 seconds' ELSE circuit_open_until END, updated_at = now() WHERE id = $1`, [id])
  }

  async markSuccess(id: string): Promise<void> {
    await this.db.query(`UPDATE channels SET failure_count = 0, circuit_open_until = NULL, last_success_at = now(), updated_at = now() WHERE id = $1`, [id])
  }
}

export { shouldFailover }
