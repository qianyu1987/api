import { request, type Dispatcher } from 'undici'
import { decryptSecret } from '../lib/crypto.js'
import { isSolFallback } from '../lib/public-model.js'
import type { AppConfig } from '../config.js'
import { Database, one } from '../db/index.js'
import { isAgnesResponsesAdapter, responsesToChat } from '../lib/agnes-adapter.js'

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
  protocolAdapter?: 'agnes-responses'
}

export type UpstreamBalance = {
  status: 'available' | 'unsupported' | 'error'
  remaining: number | null
  quota: number | null
  used: number | null
  unit: string | null
  checkedAt: string
  message: string | null
}

export function parseUpstreamUsage(payload: unknown): Omit<UpstreamBalance, 'checkedAt'> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const data = payload as Record<string, any>
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  const remaining = number(data.remaining ?? data.quota?.remaining)
  const quota = number(data.quota?.limit ?? data.quota)
  const used = number(data.quota?.used ?? data.usage?.total?.actual_cost)
  if (remaining === null) return null
  return { status: 'available', remaining, quota, used, unit: typeof data.unit === 'string' && data.unit.length <= 16 ? data.unit : null, message: null }
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
 * Retry provider failures that are safe to route to another configured
 * channel.  401/403 are included because channel credentials and upstream
 * balances are provider-specific; the final provider response is still
 * returned when every channel fails.
 */
function shouldFailover(status: number): boolean {
  // Provider-specific authentication, balance, and permission failures
  // should not block another configured channel from serving the model.
  // The relay still returns the final provider response when every channel
  // fails, so client errors remain visible to the caller.
  return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500
}

export function isInvalidApiResponse(status: number, headers: Record<string, unknown>): boolean {
  if (status < 200 || status >= 300) return false
  const contentType = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase()
  // A common channel misconfiguration omits `/v1`, causing the provider's
  // dashboard HTML to be returned with HTTP 200. It is never a valid OpenAI
  // API response and must participate in normal channel failover.
  return contentType.includes('text/html')
}

export function normalizeResponsesTools(parsed: any): void {
  if (!Array.isArray(parsed?.tools)) return
  parsed.tools = parsed.tools.flatMap((tool: any) => {
    if (!tool || typeof tool !== 'object') return [tool]
    if (tool.type === 'namespace') {
      const nested = Array.isArray(tool.functions) ? tool.functions : Array.isArray(tool.tools) ? tool.tools : null
      if (nested?.length) {
        const expanded = nested.map((entry: any) => ({ ...entry, name: tool.name && entry?.name ? `${String(tool.name).slice(0, 128)}.${String(entry.name).slice(0, 128)}` : entry?.name, type: entry?.type || 'function' }))
        const holder = { tools: expanded }
        normalizeResponsesTools(holder)
        return holder.tools
      }
    }
    if (tool.type !== 'custom' && tool.type !== 'namespace') return [tool]
    const custom = tool.custom && typeof tool.custom === 'object' ? tool.custom : tool
    const format = custom.format && typeof custom.format === 'object' ? custom.format : null
    let parameters = custom.parameters || custom.input_schema || custom.schema
    // Responses custom tools may carry a grammar instead of JSON Schema. The
    // upstream accepts function tools only, so expose a permissive object
    // shape and keep the original description/name for model compatibility.
    if (!parameters && format && format.type === 'json_schema') parameters = format.schema || format.value
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) parameters = { type: 'object', properties: {}, additionalProperties: true }
    return [{
      type: 'function',
      name: String(custom.name || tool.name || 'custom_tool').slice(0, 256),
      description: typeof custom.description === 'string' ? custom.description.slice(0, 4096) : undefined,
      parameters,
      strict: custom.strict === true || tool.strict === true,
    }]
  })
}

export function rewriteRequestBody(body: Buffer | undefined, requestedModel: string, upstreamModel: string, path: string): Buffer | undefined {
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
    if (path.split('?')[0] === '/responses') {
      if (Array.isArray(parsed.tools) && parsed.tools.some((tool: any) => tool?.type === 'custom' || tool?.type === 'namespace')) {
        normalizeResponsesTools(parsed)
        changed = true
      }
      // Some CC Switch Codex requests carry tool_choice even when the
      // provider-specific tool list is empty. OpenAI-compatible upstreams
      // reject that combination; with no tools, tool_choice has no effect.
      if ((!Array.isArray(parsed.tools) || parsed.tools.length === 0) && Object.prototype.hasOwnProperty.call(parsed, 'tool_choice')) {
        delete parsed.tool_choice
        changed = true
      }
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

export function responseFailure(status: number): Pick<RelayAttempt, 'errorType' | 'errorMessage' | 'errorCode'> {
  if (status === 401) return { errorType: 'provider_auth', errorCode: 'upstream_unauthorized', errorMessage: '上游认证失败或 Key 无效' }
  if (status === 403) return { errorType: 'provider_access', errorCode: 'upstream_forbidden', errorMessage: '上游拒绝访问，可能是权限或余额不足' }
  return { errorType: null, errorCode: null, errorMessage: null }
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
  private readonly upstreamBalanceCache = new Map<string, { expiresAt: number; value: UpstreamBalance }>()
  constructor(private readonly db: Database, private readonly config: AppConfig) {}

  async list(): Promise<Channel[]> {
    const rows = await this.db.query<any>(`SELECT id, name, base_url, encrypted_api_key, priority, model_map, timeout_ms FROM channels WHERE deleted_at IS NULL AND enabled = true AND (circuit_open_until IS NULL OR circuit_open_until < now()) ORDER BY priority ASC, created_at ASC`)
    return rows.map((row) => ({ id: String(row.id), name: row.name, baseUrl: row.base_url, encryptedApiKey: row.encrypted_api_key, priority: Number(row.priority), modelMap: jsonMap(row.model_map), timeoutMs: Number(row.timeout_ms) || 30_000 }))
  }

  async allForAdmin(): Promise<any[]> {
    const rows = await this.db.query<any>(`SELECT id, name, base_url, priority, model_map, timeout_ms, enabled, failure_count, circuit_open_until, created_at, updated_at FROM channels WHERE deleted_at IS NULL ORDER BY priority ASC, created_at ASC`)
    return rows.map((row) => ({ id: String(row.id), name: row.name, baseUrl: row.base_url, priority: Number(row.priority), modelMap: row.model_map || {}, timeoutMs: Number(row.timeout_ms), enabled: row.enabled, failureCount: Number(row.failure_count), circuitOpenUntil: row.circuit_open_until, createdAt: row.created_at, updatedAt: row.updated_at }))
  }

  async upstreamBalances(force = false): Promise<Record<string, UpstreamBalance>> {
    const rows = await this.db.query<any>(`SELECT id,name,base_url,encrypted_api_key FROM channels WHERE deleted_at IS NULL ORDER BY priority ASC,created_at ASC`)
    const entries = await Promise.all(rows.map(async row => {
      const checkedAt = new Date().toISOString()
      const cached = this.upstreamBalanceCache.get(String(row.id))
      if (!force && cached && cached.expiresAt > Date.now()) return [String(row.id), cached.value] as const
      let value: UpstreamBalance
      const origin = new URL(row.base_url).origin
      if (origin === 'https://cdn.yyapi.cloud' || origin === 'https://ripp.best') {
        try {
          const headers = { authorization: 'Bearer ' + decryptSecret(row.encrypted_api_key, this.config.channelEncryptionKey) }
          const [usageResponse,statusResponse] = await Promise.all([
            fetch(origin + '/api/usage/token/', { headers, redirect: 'error', signal: AbortSignal.timeout(10_000) }),
            fetch(origin + '/api/status', { redirect: 'error', signal: AbortSignal.timeout(10_000) }),
          ])
          if (!usageResponse.ok || !statusResponse.ok) throw new Error('invalid response')
          const usage:any = await usageResponse.json(), status:any = await statusResponse.json()
          const unit = Number(status?.data?.quota_per_unit)
          const raw = usage?.data
          if (!raw || !Number.isFinite(unit) || unit <= 0 || ![raw.total_available,raw.total_granted,raw.total_used].every(Number.isFinite)) throw new Error('invalid balance')
          value = { status: 'available', remaining: raw.total_available / unit, quota: raw.total_granted / unit, used: raw.total_used / unit, unit: '¥', checkedAt, message: raw.total_available < 0 ? '上游额度已透支，请及时补充' : null }
        } catch {
          value = { status: 'error', remaining: null, quota: null, used: null, unit: null, checkedAt, message: '余额查询失败，请稍后刷新' }
        }
      } else if (origin !== 'https://x.ailzd.com') {
        value = { status: 'unsupported', remaining: null, quota: null, used: null, unit: null, checkedAt, message: origin === 'https://apihub.agnes-ai.com' ? '供应商未开放余额查询接口' : '此渠道尚未配置余额查询' }
      } else {
        try {
          const response = await fetch(origin + '/v1/usage', { headers: { authorization: 'Bearer ' + decryptSecret(row.encrypted_api_key, this.config.channelEncryptionKey) }, redirect: 'error', signal: AbortSignal.timeout(10_000) })
          const contentType = response.headers.get('content-type') || ''
          if (!response.ok || !contentType.includes('application/json')) throw new Error('invalid response')
          const parsed = parseUpstreamUsage(await response.json())
          if (!parsed) throw new Error('invalid balance')
          value = { ...parsed, checkedAt }
        } catch {
          value = { status: 'error', remaining: null, quota: null, used: null, unit: null, checkedAt, message: '余额查询失败，请稍后刷新' }
        }
      }
      this.upstreamBalanceCache.set(String(row.id), { expiresAt: Date.now() + 60_000, value })
      return [String(row.id), value] as const
    }))
    return Object.fromEntries(entries)
  }

  async upsert(input: { id?: string; name: string; baseUrl: string; apiKey?: string; priority?: number; modelMap?: Record<string, string>; timeoutMs?: number; enabled?: boolean }): Promise<any> {
    const { encryptSecret } = await import('../lib/crypto.js')
    const url = new URL(input.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('上游地址必须使用 HTTP(S)')
    if (input.id) {
      const current = await this.db.one<any>('SELECT encrypted_api_key FROM channels WHERE id = $1 AND deleted_at IS NULL', [input.id])
      if (!current) throw Object.assign(new Error('渠道不存在或已删除，请刷新列表'), { statusCode: 404 })
      const encrypted = input.apiKey?.trim() ? encryptSecret(input.apiKey.trim(), this.config.channelEncryptionKey) : current?.encrypted_api_key
      const row = await this.db.one<any>(`UPDATE channels SET name=$1, base_url=$2, encrypted_api_key=$3, priority=$4, model_map=$5, timeout_ms=$6, enabled=$7, updated_at=now() WHERE id=$8 AND deleted_at IS NULL RETURNING id, name, base_url, priority, model_map, timeout_ms, enabled`, [input.name.trim(), url.toString().replace(/\/$/, ''), encrypted, Number(input.priority ?? 100), JSON.stringify(input.modelMap || {}), Math.max(1000, Number(input.timeoutMs || 30000)), input.enabled !== false, input.id])
      if (!row) throw Object.assign(new Error('渠道已删除，请刷新列表'), { statusCode: 404 })
      return row
    }
    if (!input.apiKey?.trim()) throw new Error('新增渠道必须填写上游 Key')
    const row = await this.db.one<any>(`INSERT INTO channels(name, base_url, encrypted_api_key, priority, model_map, timeout_ms, enabled) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, base_url, priority, model_map, timeout_ms, enabled`, [input.name.trim(), url.toString().replace(/\/$/, ''), encryptSecret(input.apiKey.trim(), this.config.channelEncryptionKey), Number(input.priority ?? 100), JSON.stringify(input.modelMap || {}), Math.max(1000, Number(input.timeoutMs || 30000)), input.enabled !== false])
    return row
  }

  // Keep the original DELETE endpoint's disable semantics for cached clients.
  async remove(id: string, actorId: string): Promise<void> {
    await this.changeAvailability(id, actorId, false)
  }

  async archive(id: string, actorId: string): Promise<void> {
    await this.changeAvailability(id, actorId, true)
  }

  private async changeAvailability(id: string, actorId: string, archive: boolean): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw Object.assign(new Error('渠道编号无效，请刷新列表'), { statusCode: 400 })
    }
    await this.db.tx(async client => {
      // Lock against edits/cost changes and audit only non-secret fields.
      const before = await one<any>(client, 'SELECT id,name,base_url,model_map,enabled,deleted_at FROM channels WHERE id=$1 FOR UPDATE', [id])
      if (!before) throw Object.assign(new Error('渠道不存在，请刷新列表'), { statusCode: 404 })
      if (before.deleted_at || (!archive && !before.enabled)) return
      const after = await one<any>(client, `UPDATE channels SET enabled=false,
        deleted_at=CASE WHEN $2 THEN now() ELSE deleted_at END,updated_at=now()
        WHERE id=$1 RETURNING id,name,base_url,model_map,enabled,deleted_at`, [id, archive])
      // Preserve the channel row, costs and foreign keys for in-flight billing
      // and historical reports. Deleted channels are hidden from all editors.
      await client.query(`INSERT INTO config_audit_logs(actor_user_id,resource_type,resource_id,before_value,after_value)
        VALUES($1,'channel',$2,$3,$4)`, [actorId, id, JSON.stringify(before), JSON.stringify(after)])
    })
  }

  async relay(path: string, method: string, headers: Record<string, string>, body: Buffer | undefined, requestedModel: string): Promise<RelayResult> {
    const fallback = (channel: Channel) => isSolFallback(requestedModel, channel.modelMap[requestedModel] || channel.modelMap['*'] || requestedModel)
    const channels = (await this.list()).filter((channel) => {
      if (!supportsRequestedModel(channel, requestedModel)) return false
      // This text fallback supports only the synchronous Chat/Responses APIs.
      // Do not route image, audio, embedding or response-management operations to it.
      return !fallback(channel) || (method.toUpperCase() === 'POST' && ['/chat/completions', '/responses'].includes(path.split('?')[0]))
    }).sort((a, b) => Number(fallback(a)) - Number(fallback(b)))
    if (!channels.length) throw new Error(requestedModel ? '当前模型没有已启用上游渠道，请联系管理员配置模型映射' : '暂无可用上游渠道，请联系管理员')
    const attempts: RelayAttempt[] = []
    for (let index = 0; index < channels.length; index += 1) {
      const channel = channels[index]
      const upstreamModel = channel.modelMap[requestedModel] || channel.modelMap['*'] || requestedModel
      const started = Date.now()
      const adapter = isAgnesResponsesAdapter(channel.baseUrl, path, fallback(channel))
      const targetPath = adapter ? path.replace(/^\/responses(?=\?|$)/, '/chat/completions') : path
      const target = `${channel.baseUrl}${targetPath.startsWith('/') ? targetPath : `/${targetPath}`}`
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
        // Fallback metadata must be inspected and rewritten. Prefer plain bytes;
        // the response layer also handles providers that still send compression.
        if (fallback(channel)) outgoingHeaders['accept-encoding'] = 'identity'
        let outgoingBody = rewriteRequestBody(body, requestedModel, upstreamModel, path)
        if (adapter && outgoingBody) {
          try {
            const parsed = JSON.parse(outgoingBody.toString('utf8'))
            outgoingBody = Buffer.from(JSON.stringify(responsesToChat(parsed)))
          } catch { /* preserve malformed body for provider validation */ }
        }
        if (outgoingBody && outgoingBody !== body) {
          // The original content-length is deliberately removed above; undici
          // computes the new length from the rewritten payload.
          delete outgoingHeaders['content-length']
          delete outgoingHeaders['Content-Length']
        }
        const response = await request(target, { method: method as any, headers: outgoingHeaders, body: outgoingBody && outgoingBody.length ? outgoingBody : undefined, headersTimeout: channel.timeoutMs, bodyTimeout: channel.timeoutMs, maxRedirections: 0 })
        const latencyMs = Date.now() - started
        const invalidResponse = isInvalidApiResponse(response.statusCode, response.headers as Record<string, unknown>)
        const retryable = invalidResponse || shouldFailover(response.statusCode)
        const failure = responseFailure(response.statusCode)
        const attempt: RelayAttempt = { channelId: channel.id, channelName: channel.name, attemptNo: index + 1, statusCode: response.statusCode, ...failure, latencyMs }
        attempt.upstreamModel = upstreamModel
        attempt.retryable = retryable
        attempt.outcome = invalidResponse ? 'server_error' : responseOutcome(response.statusCode)
        if (invalidResponse) {
          attempt.errorType = 'invalid_response'
          attempt.errorCode = 'upstream_invalid_content_type'
          attempt.errorMessage = '上游返回非 API 响应'
        }
        attempts.push(attempt)
        if (!retryable) {
          // Metrics/circuit bookkeeping must never turn an already successful
          // upstream response into a retry. The response path remains usable
          // during a transient PostgreSQL outage.
          await this.markSuccess(channel.id).catch(() => undefined)
          return { response, channel, attempts, upstreamModel, ...(adapter ? { protocolAdapter: 'agnes-responses' as const } : {}) }
        }
        await this.markFailure(channel.id).catch(() => undefined)
        // A retryable response can only be returned when it is the final
        // channel attempt. Earlier bodies must be drained before failover; do
        // not retain one of those drained responses and accidentally return it
        // after a later network error.
        if (index === channels.length - 1 && !invalidResponse) return { response, channel, attempts, upstreamModel, ...(adapter ? { protocolAdapter: 'agnes-responses' as const } : {}) }
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
