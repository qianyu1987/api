import { afterEach, expect, test, vi } from 'vitest'
import { LayaShadow, shadowText } from '../src/services/laya-shadow.js'
import { loadConfig } from '../src/config.js'
import { buildApp } from '../src/server.js'

const config = { url: 'http://127.0.0.1:19091/v1/classify', token: 'x'.repeat(32), adminUserId: 'admin-id' }
const payload = { model: 'chosen-model', messages: [{ role: 'user', content: 'hello' }] }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers() })

test('disabled and out-of-scope traffic never reaches transport', () => {
  const send = vi.fn()
  new LayaShadow(undefined, send).observe('admin', 'admin-id', 'POST', '/chat/completions', payload)
  const shadow = new LayaShadow(config, send)
  shadow.observe('user', 'admin-id', 'POST', '/chat/completions', payload)
  shadow.observe('admin', 'another-admin', 'POST', '/chat/completions', payload)
  expect(send).not.toHaveBeenCalled()
})

test('strict extraction excludes history, tools, attachments, state and metadata', () => {
  expect(shadowText('POST', '/chat/completions', payload)).toBe('hello')
  expect(shadowText('POST', '/responses', { input: 'hello' })).toBe('hello')
  for (const body of [null, [], { ...payload, tools: [] }, { ...payload, previous_response_id: 'id' },
    { ...payload, metadata: {} }, { ...payload, messages: [...payload.messages, ...payload.messages] },
    { ...payload, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: 'private' }] }] },
    { ...payload, messages: [{ role: 'system', content: 'private' }] },
    { ...payload, messages: [{ role: 'user', content: 'x'.repeat(2001) }] }]) {
    expect(shadowText('POST', '/chat/completions', body)).toBeNull()
  }
  expect(shadowText('GET', '/responses', { input: 'hello' })).toBeNull()
  expect(shadowText('POST', '/images/generations', { input: 'hello' })).toBeNull()
})

test('slow service is bounded to one request and aborts without retry', async () => {
  vi.useFakeTimers()
  const send = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')))
  }))
  const shadow = new LayaShadow(config, send as typeof fetch)
  shadow.observe('admin', 'admin-id', 'POST', '/chat/completions', payload)
  shadow.observe('admin', 'admin-id', 'POST', '/chat/completions', payload)
  expect(send).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(751)
  expect(shadow.snapshot()).toMatchObject({ failed: 1, busy: 1, completed: 0 })
  expect(payload.model).toBe('chosen-model')
})

test.each(['valid', 'oversize', 'malformed', 'http-error'])('response %s records only bounded counters', async kind => {
  const body = kind === 'valid' ? JSON.stringify({ mode: 'shadow', answers: { task_type: { choice: 'coding' } } })
    : kind === 'oversize' ? 'x'.repeat(17000) : 'invalid'
  const send = vi.fn().mockResolvedValue(new Response(body, { status: kind === 'http-error' ? 503 : 200 }))
  const shadow = new LayaShadow(config, send)
  shadow.observe('admin', 'admin-id', 'POST', '/chat/completions', payload)
  await vi.waitFor(() => expect(shadow.snapshot()).toMatchObject(kind === 'valid' ? { completed: 1 } : { failed: 1 }))
  expect(JSON.stringify(shadow.snapshot())).not.toContain('hello')
  const [url, init] = send.mock.calls[0]
  expect(url).toBe(config.url)
  expect(JSON.parse(init.body)).toEqual({ text: 'hello' })
  expect(init.redirect).toBe('error')
  shadow.close()
  shadow.observe('admin', 'admin-id', 'POST', '/chat/completions', payload)
  expect(send).toHaveBeenCalledTimes(1)
})

test('config defaults off and requires explicit loopback transport, token and admin', () => {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('LAYA_SHADOW_ENABLED', '')
  expect(loadConfig().layaShadow).toBeUndefined()
  vi.stubEnv('LAYA_SHADOW_ENABLED', 'true')
  vi.stubEnv('LAYA_SHADOW_URL', 'https://example.com/v1/classify')
  expect(() => loadConfig()).toThrow('loopback')
  vi.stubEnv('LAYA_SHADOW_URL', config.url)
  vi.stubEnv('LAYA_SHADOW_TOKEN', '')
  expect(() => loadConfig()).toThrow('token')
  vi.stubEnv('LAYA_SHADOW_TOKEN', config.token)
  vi.stubEnv('LAYA_SHADOW_ADMIN_USER_ID', config.adminUserId)
  expect(loadConfig().layaShadow).toEqual(config)
})

test('relay completes and settles the chosen model while shadow is still pending', async () => {
  vi.stubEnv('NODE_ENV', 'test')
  const transport = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('closed')))
  }))
  vi.stubGlobal('fetch', transport)
  const services = await buildApp({ ...loadConfig(), layaShadow: config })
  try {
    vi.spyOn(services.auth, 'authenticateApiKey').mockResolvedValue({
      user: { id: 'admin-id', role: 'admin' }, key: { id: 'key', name: 'test' },
    } as any)
    vi.spyOn(services.billing, 'priceForRequest').mockResolvedValue({ modelPattern: 'chosen-model', billingMode: 'token',
      inputSellMicrosPerMillion: 1000000n, outputSellMicrosPerMillion: 1000000n, cacheSellMicrosPerMillion: 1000000n,
      inputCostMicrosPerMillion: 100000n, outputCostMicrosPerMillion: 100000n, cacheCostMicrosPerMillion: 100000n,
      fixedCostMicros: 0n, fixedSellMicros: 0n } as any)
    vi.spyOn(services.billing, 'reserve').mockResolvedValue({} as any)
    vi.spyOn(services.billing, 'settle').mockResolvedValue({} as any)
    vi.spyOn(services.billing, 'release').mockResolvedValue(undefined)
    vi.spyOn(services.db, 'query').mockResolvedValue([])
    const relay = vi.spyOn(services.channels, 'relay').mockResolvedValue({
      upstreamModel: 'chosen-model', channel: { id: 'original', name: 'Original' }, attempts: [],
      response: { statusCode: 200, headers: { 'content-type': 'application/json' },
        body: { arrayBuffer: async () => Buffer.from(JSON.stringify({ model: 'chosen-model', choices: [],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })) } },
    } as any)
    const response = await services.app.inject({ method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: 'Bearer test' }, payload })
    expect(response.statusCode).toBe(200)
    expect(transport).toHaveBeenCalledTimes(1)
    expect(relay).toHaveBeenCalledTimes(1)
    expect(relay.mock.calls[0][4]).toBe('chosen-model')
    expect(JSON.parse(relay.mock.calls[0][3]!.toString())).toEqual(payload)
    expect(services.billing.reserve).toHaveBeenCalledTimes(1)
    expect(services.billing.settle).toHaveBeenCalledTimes(1)
    expect(services.billing.settle).toHaveBeenCalledWith(expect.objectContaining({
      model: 'chosen-model', channelId: 'original', success: true,
    }))
    expect(services.billing.release).not.toHaveBeenCalled()
    const stats = await services.app.inject({ method: 'GET', url: '/api/admin/laya-shadow' })
    expect(stats.statusCode).toBe(401)
  } finally { await services.app.close(); await services.db.close() }
})
