import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Readable } from 'node:stream'
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib'
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { ChannelService } from '../src/services/channels.js'
import { encryptSecret } from '../src/lib/crypto.js'
import { isPublicFallbackModel, isSolFallback, PublicModelSse, rewritePublicModel } from '../src/lib/public-model.js'
import { decodeResponseStream } from '../src/lib/response-compression.js'
import { buildApp, type RelayApp } from '../src/server.js'
import { loadConfig } from '../src/config.js'

const model = 'gpt-5.6-sol'
const upstream = 'agnes-3.0-flash'
const key = Buffer.alloc(32, 4)
const config = { channelEncryptionKey: key } as any
let agent: MockAgent
const originalDispatcher = getGlobalDispatcher()
beforeEach(() => { agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent) })
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); setGlobalDispatcher(originalDispatcher); await agent.close() })

function routing() {
  const rows = [
    { id: 'real', name: 'Real', priority: 90, model_map: { [model]: model, 'gpt-6-astra': 'gpt-6-astra' } },
    { id: 'fallback', name: '低价plus', priority: 1000, model_map: { [model]: upstream, 'gpt-6-astra': 'gpt-6-astra' } },
  ].map(row => ({ ...row, base_url: `http://${row.id}.test/v1`, encrypted_api_key: encryptSecret('test-provider-key', key), timeout_ms: 1000, enabled: true, circuit_open_until: null as Date | null }))
  const db = { query: vi.fn(async (sql: string, params: any[] = []) => {
    if (sql.startsWith('SELECT')) {
      expect(sql).toContain('circuit_open_until < now()')
      expect(sql).toContain('ORDER BY priority ASC')
      return rows.filter(r => r.enabled && (!r.circuit_open_until || r.circuit_open_until.getTime() < Date.now())).sort((a, b) => a.priority - b.priority)
    }
    const row = rows.find(r => r.id === params[0])!
    if (sql.includes('failure_count = 0')) row.circuit_open_until = null
    return []
  }) }
  return { rows, service: new ChannelService(db as any, config) }
}
function respond(host: string, status = 200, responseModel = model) {
  agent.get(`http://${host}.test`).intercept({ path: '/v1/chat/completions', method: 'POST' })
    .reply(status, { model: responseModel, choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }, { headers: { 'content-type': 'application/json' } })
}
const body = Buffer.from(JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }] }))
const call = (service: ChannelService, path = '/chat/completions', requestedModel = model) => service.relay(path, 'POST', { 'content-type': 'application/json' }, body, requestedModel)

describe('sol fallback routing', () => {
  test.each(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])('recognizes %s as an Agnes-compatible public model', requestedModel => {
    expect(isPublicFallbackModel(requestedModel)).toBe(true)
    expect(isSolFallback(requestedModel, upstream)).toBe(true)
  })
  test('keeps real providers first even if an administrator gives fallback a lower priority', async () => {
    const { service, rows } = routing(); rows[1].priority = 1
    respond('real')
    const result = await call(service)
    expect(result.channel.id).toBe('real'); expect(result.attempts).toHaveLength(1)
    await result.response.body.dump()
  })
  test('skips open circuits, rewrites the request, and automatically returns to real after recovery', async () => {
    const { service, rows } = routing(); rows[0].circuit_open_until = new Date(Date.now() + 30000)
    agent.get('http://fallback.test').intercept({ path: '/v1/chat/completions', method: 'POST', body: value => JSON.parse(String(value)).model === upstream })
      .reply(200, { model: upstream }, { headers: { 'content-type': 'application/json' } })
    const result = await call(service)
    expect(result.channel.id).toBe('fallback'); expect(result.upstreamModel).toBe(upstream)
    expect(result.attempts[0]).toMatchObject({ upstreamModel: upstream, channelName: '低价plus' })
    await result.response.body.dump()
    rows[0].circuit_open_until = new Date(Date.now() - 1)
    respond('real')
    const recovered = await call(service)
    expect(recovered.channel.id).toBe('real'); await recovered.response.body.dump()
  })
  test.each([401, 403, 408, 429, 500, 502, 503])('fails over HTTP %i', async status => {
    const { service } = routing(); respond('real', status); respond('fallback', 200, upstream)
    const result = await call(service)
    expect(result.channel.id).toBe('fallback')
    expect(result.attempts.map(a => a.statusCode)).toEqual([status, 200]); await result.response.body.dump()
  })
  test.each(['UND_ERR_HEADERS_TIMEOUT', 'ECONNRESET'])('fails over %s', async code => {
    const { service } = routing()
    agent.get('http://real.test').intercept({ path: '/v1/chat/completions', method: 'POST' }).replyWithError(Object.assign(new Error('test error'), { code }))
    respond('fallback', 200, upstream)
    const result = await call(service)
    expect(result.channel.id).toBe('fallback'); expect(result.attempts).toHaveLength(2); await result.response.body.dump()
  })
  test.each(['/images/generations', '/audio/speech', '/embeddings', '/responses/previous'])('excludes the text fallback for %s', async path => {
    const { service, rows } = routing(); rows[0].enabled = false
    await expect(call(service, path)).rejects.toThrow('当前请求包含工具、图片、文件或多轮状态，暂无兼容的上游渠道')
  })
  test('preserves gpt-6-astra mapping and priority', async () => {
    const { service, rows } = routing(); rows[1].priority = 1
    respond('fallback', 200, 'gpt-6-astra')
    const result = await call(service, '/chat/completions', 'gpt-6-astra')
    expect(result.channel.id).toBe('fallback'); expect(result.upstreamModel).toBe('gpt-6-astra'); await result.response.body.dump()
  })
})

describe('public response model', () => {
  test('rewrites response metadata and leaves tools, usage and text intact', () => {
    const input = { model: upstream, response: { model: upstream, usage: { input_tokens: 3 } }, choices: [{ tool_calls: [{ function: { arguments: '{"model":"agnes-3.0-flash"}' } }], content: upstream }] }
    const output = JSON.parse(rewritePublicModel(JSON.stringify(input), model))
    expect(output.model).toBe(model); expect(output.response.model).toBe(model)
    expect(output.choices).toEqual(input.choices); expect(output.response.usage).toEqual(input.response.usage)
    expect(input.model).toBe(upstream)
    expect(rewritePublicModel('not json', model)).toBe('not json')
  })
  test('preserves UTF-8 and SSE event semantics across every possible byte boundary', () => {
    const events = ': keepalive\r\nevent: response.created\r\nid: 42\r\ndata: {"response":\r\ndata: {"model":"agnes-3.0-flash","usage":{"input_tokens":7}}}\r\n\r\n'
      + 'data: {"model":"agnes-3.0-flash","choices":[{"delta":{"content":"你好","tool_calls":[{"function":{"arguments":"{}"}}]}}]}\n\n'
      + 'data: [DONE]\n\n'
    const expected = ': keepalive\r\nevent: response.created\r\nid: 42\r\ndata: {"response":{"model":"gpt-5.6-sol","usage":{"input_tokens":7}}}\r\n\r\n'
      + 'data: {"model":"gpt-5.6-sol","choices":[{"delta":{"content":"你好","tool_calls":[{"function":{"arguments":"{}"}}]}}]}\n\n'
      + 'data: [DONE]\n\n'
    const bytes = Buffer.from(events)
    for (let split = 0; split <= bytes.length; split++) {
      const stream = new PublicModelSse(model)
      expect(stream.write(bytes.subarray(0, split)) + stream.write(bytes.subarray(split)) + stream.end()).toBe(expected)
    }
    const stream = new PublicModelSse(model)
    expect([...bytes].map(byte => stream.write(Buffer.from([byte]))).join('') + stream.end()).toBe(expected)
  })
  test('handles a final event without a terminator and preserves malformed/provider data', () => {
    const stream = new PublicModelSse(model)
    expect(stream.write(Buffer.from('data: not json\n\ndata: {"model":"agnes-3.0-flash"}')) + stream.end())
      .toBe('data: not json\n\ndata: {"model":"gpt-5.6-sol"}')
  })
})

describe('relay HTTP integration and billing boundary', () => {
  let services: RelayApp
  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'test')
    services = await buildApp(loadConfig())
    vi.spyOn(services.auth, 'authenticateApiKey').mockResolvedValue({ user: { id: 'user' }, key: { id: 'key', name: 'test' } } as any)
    vi.spyOn(services.billing, 'priceForRequest').mockResolvedValue({ modelPattern: model, billingMode: 'token',
      inputSellMicrosPerMillion: 1000000n, outputSellMicrosPerMillion: 1000000n, cacheSellMicrosPerMillion: 1000000n,
      inputCostMicrosPerMillion: 100000n, outputCostMicrosPerMillion: 100000n, cacheCostMicrosPerMillion: 100000n,
      fixedCostMicros: 0n, fixedSellMicros: 0n })
    vi.spyOn(services.billing, 'reserve').mockResolvedValue({} as any)
    vi.spyOn(services.billing, 'settle').mockResolvedValue({} as any)
    vi.spyOn(services.billing, 'release').mockResolvedValue(undefined)
    vi.spyOn(services.db, 'query').mockResolvedValue([])
    await services.app.ready()
  })
  afterEach(async () => { if (services) { await services.app.close(); await services.db.close() } })
  async function relayResponse(sse: boolean, fail = false, requestedModel = model, encoding = '', corrupt = false) {
    const finalModel = isPublicFallbackModel(requestedModel) ? upstream : requestedModel
    const payload = { model: finalModel, choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }
    const plain = Buffer.from(sse ? `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n` : JSON.stringify(payload))
    const compress = { gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync }[encoding]
    const bytes = corrupt ? Buffer.from('invalid compressed response') : compress ? compress(plain) : plain
    const attempts = [{ channelId: 'real', channelName: 'Real', attemptNo: 1, statusCode: 503, outcome: 'server_error' }, { channelId: 'fallback', channelName: '低价plus', upstreamModel: finalModel, attemptNo: 2, statusCode: fail ? 503 : 200, outcome: fail ? 'server_error' : 'success' }]
    vi.spyOn(services.channels, 'relay').mockResolvedValue({
      upstreamModel: finalModel, channel: { id: 'fallback', name: '低价plus' }, attempts,
      response: { statusCode: fail ? 503 : 200, headers: { 'content-type': sse ? 'text/event-stream' : 'application/json', ...(encoding ? { 'content-encoding': encoding, 'content-length': String(bytes.length) } : {}) },
        body: sse ? Readable.from([...bytes].map(b => Buffer.from([b]))) : { arrayBuffer: async () => bytes } },
    } as any)
    return services.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: 'Bearer test' }, payload: { model: requestedModel } })
  }
  test.each([false, true])('returns public model with SSE=%s and settles once with actual upstream identity', async sse => {
    const response = await relayResponse(sse)
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain(model); expect(response.body).not.toContain(upstream)
    if (sse) expect(response.body).toContain('[DONE]')
    expect(services.billing.reserve).toHaveBeenCalledTimes(1)
    expect(services.billing.settle).toHaveBeenCalledTimes(1)
    expect(services.billing.settle).toHaveBeenCalledWith(expect.objectContaining({ model, upstreamModel: upstream, channelId: 'fallback', success: true, attemptCount: 2, usage: { input: 5n, output: 2n, cache: 0n, reportedTotal: 7n } }))
    expect(services.billing.release).not.toHaveBeenCalled()
    const records = vi.mocked(services.db.query).mock.calls.filter(([sql]) => sql.includes('INSERT INTO relay_attempts'))
    expect(records).toHaveLength(2); expect(records[1][1]).toContain(upstream)
  })
  test.each(['gpt-5.6-terra', 'gpt-5.6-luna'])('rewrites Agnes response metadata back to %s', async requestedModel => {
    const response = await relayResponse(false, false, requestedModel)
    expect(response.statusCode).toBe(200)
    expect(response.json().model).toBe(requestedModel)
    expect(response.body).not.toContain(upstream)
    expect(services.billing.settle).toHaveBeenCalledWith(expect.objectContaining({ model: requestedModel, upstreamModel: upstream }))
  })
  test('all HTTP failures settle once without charging twice', async () => {
    const response = await relayResponse(false, true)
    expect(response.statusCode).toBe(503)
    expect(services.billing.settle).toHaveBeenCalledTimes(1)
    expect(services.billing.settle).toHaveBeenCalledWith(expect.objectContaining({ success: false }))
    expect(services.billing.release).not.toHaveBeenCalled()
  })
  test.each(['gzip', 'deflate', 'br'])('decodes %s before model rewriting and actual-usage settlement', async encoding => {
    for (const sse of [false, true]) {
      const response = await relayResponse(sse, false, model, encoding)
      expect(response.statusCode).toBe(200)
      expect(response.headers).not.toHaveProperty('content-encoding')
      expect(response.body).toContain(model)
      expect(response.body).not.toContain(upstream)
      if (sse) expect(response.body).toContain('[DONE]')
      expect(services.billing.settle).toHaveBeenLastCalledWith(expect.objectContaining({
        upstreamModel: upstream, estimatedUsage: false,
        usage: { input: 5n, output: 2n, cache: 0n, reportedTotal: 7n },
      }))
    }
  })
  test.each([false, true])('corrupt compressed response with SSE=%s settles as failed exactly once', async sse => {
    const response = await relayResponse(sse, false, model, 'gzip', true)
    if (!sse) expect(response.statusCode).toBe(502)
    expect(response.body).not.toContain('invalid compressed response')
    expect(services.billing.reserve).toHaveBeenCalledTimes(1)
    expect(services.billing.settle).toHaveBeenCalledTimes(1)
    expect(services.billing.settle).toHaveBeenCalledWith(expect.objectContaining({ success: false, usage: null }))
    expect(services.billing.release).not.toHaveBeenCalled()
  })
  test('all transport failures settle the single reservation as failed', async () => {
    vi.spyOn(services.channels, 'relay').mockRejectedValue(Object.assign(new Error('unavailable'), { attempts: [] }))
    const response = await services.app.inject({ method: 'POST', url: '/v1/responses', headers: { authorization: 'Bearer test' }, payload: { model } })
    expect(response.statusCode).toBe(502)
    expect(services.billing.reserve).toHaveBeenCalledTimes(1); expect(services.billing.settle).toHaveBeenCalledTimes(1)
    expect(services.billing.settle).toHaveBeenCalledWith(expect.objectContaining({ success: false }))
    expect(services.billing.release).not.toHaveBeenCalled()
  })
  test('other models keep their response metadata', async () => {
    const response = await relayResponse(false, false, 'gpt-6-astra')
    expect(response.json().model).toBe('gpt-6-astra')
  })
  test.each(['user', 'admin'])('serves billing and usage with appropriate model visibility for %s', async role => {
    const row = { request_id: 'request', requested_model: model, upstream_model: upstream, started_at: new Date(), charge_micros: '7', cost_micros: '2', profit_micros: '5', success: true }
    vi.spyOn(services.db, 'one').mockImplementation(async (sql: string) => sql.includes('FROM users') ? { id: 'user', username: 'tester', status: 'active', role, created_at: new Date() } : sql.includes('WHERE request_id') ? { ...row } : {} as any)
    vi.mocked(services.db.query).mockResolvedValue([{ ...row }])
    const headers = { cookie: `relay_session=${services.app.jwt.sign({ sub: 'user' })}` }
    const detail = await services.app.inject({ url: '/api/me/billing/request', headers })
    const usage = await services.app.inject({ url: '/api/me/usage', headers })
    expect(detail.statusCode).toBe(200); expect(usage.statusCode).toBe(200)
    expect(detail.json().upstream_model).toBe(role === 'admin' ? upstream : model)
    expect(usage.json().items[0].upstreamModel).toBe(role === 'admin' ? upstream : model)
    if (role === 'user') {
      expect(usage.json().items[0]).not.toHaveProperty('estimatedCost')
      expect(usage.json().items[0]).not.toHaveProperty('profit')
      expect((await services.app.inject({ url: '/api/admin/profit', headers })).statusCode).toBe(403)
      for (const url of ['/api/admin/overview', '/api/admin/risk-alerts', '/api/admin/channel-costs', '/api/admin/channels', '/api/admin/usage', '/api/admin/profit/export']) {
        expect((await services.app.inject({ url, headers })).statusCode).toBe(403)
      }
      expect((await services.app.inject({ method: 'POST', url: '/api/admin/channel-costs', headers, payload: {} })).statusCode).toBe(403)
    } else {
      const adminUsage = await services.app.inject({ url: '/api/admin/usage', headers })
      expect(adminUsage.json().items[0]).toMatchObject({ upstream_model: upstream, fallbackCostPending: true })
    }
  })
})

describe('compressed stream lifecycle', () => {
  test('propagates upstream connection failure to the reader', async () => {
    const source = new Readable({ read() { this.destroy(new Error('upstream disconnected')) } })
    const output = decodeResponseStream(source, 'gzip')
    await expect((async () => { for await (const _chunk of output) { /* consume */ } })()).rejects.toThrow('upstream disconnected')
    expect(source.destroyed).toBe(true)
  })
  test('cancels the upstream when the reader disconnects', async () => {
    const source = new Readable({ read() {} })
    const output = decodeResponseStream(source, 'gzip')
    const completed = (async () => { for await (const _chunk of output) { /* consume */ } })()
    output.destroy(new Error('client disconnected'))
    await expect(completed).rejects.toThrow('client disconnected')
    expect(source.destroyed).toBe(true)
  })
})
