import { afterEach, describe, expect, test, vi } from 'vitest'
import { buildCcswitchImportLink, ccswitchModel } from '../src/lib/ccswitch.js'
import { normalizeResponsesTools, rewriteRequestBody, safeRelayError, shouldFailover, supportsRequestedModel } from '../src/services/channels.js'

afterEach(() => vi.restoreAllMocks())

describe('channel failover policy', () => {
  test('converts Responses custom tools to function tools accepted by upstream gateways', () => {
    const payload: any = { tools: [{ type: 'custom', name: 'lookup', description: 'Look up data', format: { type: 'text' } }] }
    normalizeResponsesTools(payload)
    expect(payload.tools[0]).toMatchObject({ type: 'function', name: 'lookup', description: 'Look up data', parameters: { type: 'object' } })
  })

  test('expands Responses namespace tools into function tools', () => {
    const payload: any = { tools: [{ type: 'namespace', name: 'files', functions: [{ name: 'search', parameters: { type: 'object' } }] }] }
    normalizeResponsesTools(payload)
    expect(payload.tools).toEqual([{ type: 'function', name: 'files.search', parameters: { type: 'object' } }])
  })

  test('drops tool_choice when a Responses request has no tools', () => {
    const body = rewriteRequestBody(Buffer.from(JSON.stringify({ model: 'gpt-5.5', tool_choice: { type: 'function', name: 'tool_choice' } })), 'gpt-5.5', 'agnes-2.5-flash', '/responses?stream=true')
    expect(JSON.parse(String(body))).toEqual({ model: 'agnes-2.5-flash' })
  })
  test.each([408, 429, 500, 502, 503, 599])('fails over retryable HTTP %i', (status) => {
    expect(shouldFailover(status)).toBe(true)
  })

  test.each([200, 201, 301, 400, 401, 403, 404, 409, 422, 499])('does not fail over ordinary HTTP %i', (status) => {
    expect(shouldFailover(status)).toBe(false)
  })

  test('normalizes failed-attempt diagnostics before persistence', () => {
    expect(safeRelayError('network_error')).toEqual({
      errorType: 'network_error', errorCode: 'upstream_network_error', errorMessage: '上游网络错误',
    })
    expect(safeRelayError('timeout')).toEqual({
      errorType: 'timeout', errorCode: 'upstream_timeout', errorMessage: '上游请求超时',
    })
  })

  test('requires explicit model mapping before a channel can receive a billed request', () => {
    expect(supportsRequestedModel({ modelMap: { 'gpt-5.6-sol': 'gpt-5.6-sol' } }, 'gpt-5.6-sol')).toBe(true)
    expect(supportsRequestedModel({ modelMap: { 'gpt-5.6-sol': 'gpt-5.6-sol' } }, 'gpt-5.6-terra')).toBe(false)
    expect(supportsRequestedModel({ modelMap: { '*': 'provider-default' } }, 'gpt-5.6-terra')).toBe(true)
  })
})

describe('CC Switch import link', () => {
  test('builds the v1 deep link and does not emit the API key to console logs', () => {
    const secret = 'sk-relay-local-secret-value'
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ]

    const link = buildCcswitchImportLink({
      apiKey: secret,
      name: 'Primary key',
      endpoint: 'https://api.hhtc.top/v1',
      homepage: 'https://api.hhtc.top',
      model: ['*', 'gpt-5.5'],
    })
    const parsed = new URL(link)
    const usageScript = Buffer.from(parsed.searchParams.get('usageScript') || '', 'base64').toString('utf8')

    expect(parsed.protocol).toBe('ccswitch:')
    expect(parsed.host).toBe('v1')
    expect(parsed.pathname).toBe('/import')
    expect(parsed.searchParams.get('apiKey')).toBe(secret)
    expect(parsed.searchParams.get('endpoint')).toBe('https://api.hhtc.top/v1')
    expect(parsed.searchParams.get('model')).toBe('gpt-5.5')
    expect(parsed.searchParams.get('usageBaseUrl')).toBe('https://api.hhtc.top/v1')
    expect(usageScript).toContain('{{baseUrl}}/account/balance')
    expect(usageScript).toContain('remaining = isFinite(numeric) ? numeric : null')
    expect(usageScript).not.toContain(secret)
    expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true)
  })

  test('chooses the first concrete model and validates required fields', () => {
    expect(ccswitchModel('*, gpt-4.1, gpt-5.5')).toBe('gpt-4.1')
    expect(ccswitchModel(['*'])).toBe('gpt-5.6-sol')
    expect(() => buildCcswitchImportLink({ apiKey: '', name: 'x', endpoint: 'https://api.hhtc.top/v1', homepage: 'https://api.hhtc.top' }))
      .toThrow('CC Switch')
  })
})
