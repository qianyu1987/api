import { afterEach, describe, expect, test, vi } from 'vitest'
import { buildCcswitchImportLink, ccswitchModel } from '../src/lib/ccswitch.js'
import { isInvalidApiResponse, isSimpleTextRequest, responseFailure, rewriteRequestBody, safeRelayError, shouldFailover, supportsRequestedModel } from '../src/services/channels.js'
import { AgnesResponsesSse, chatToResponses, isAgnesResponsesAdapter, responsesToChat } from '../src/lib/agnes-adapter.js'

afterEach(() => vi.restoreAllMocks())

describe('channel failover policy', () => {
  test('adapts Agnes Responses requests to Chat Completions', () => {
    expect(isAgnesResponsesAdapter('https://apihub.agnes-ai.com/v1', '/responses')).toBe(true)
    const result = responsesToChat({ model: 'agnes-3.0-flash', instructions: 'be concise', input: [{ role: 'user', content: [{ type: 'input_text', text: '你好' }] }], max_output_tokens: 20 })
    expect(result).toMatchObject({ model: 'agnes-3.0-flash', messages: [{ role: 'system', content: 'be concise' }, { role: 'user', content: '你好' }], max_tokens: 20 })
    expect(result).not.toHaveProperty('input')
  })

  test('wraps Agnes Chat response in a Responses envelope', () => {
    const result = chatToResponses({ id: 'chatcmpl_1', choices: [{ message: { role: 'assistant', content: '你好' } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }, 'gpt-5.6-sol')
    expect(result).toMatchObject({ object: 'response', model: 'gpt-5.6-sol', status: 'completed', output: [{ role: 'assistant', content: [{ type: 'output_text', text: '你好' }] }], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } })
  })

  test('preserves native Responses output and normalizes array content', () => {
    const native = chatToResponses({ object: 'response', id: 'resp_native', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好' }] }] }, 'gpt-5.6-terra')
    expect(native.output).toHaveLength(1)
    expect(native.model).toBe('gpt-5.6-terra')
    const array = chatToResponses({ id: 'chatcmpl_2', choices: [{ message: { role: 'assistant', content: [{ type: 'text', text: '你' }, { type: 'text', text: '好' }] } }] }, 'gpt-5.6-sol')
    expect(array.output[0].content[0].text).toBe('你好')
    const empty = chatToResponses({ id: 'chatcmpl_empty', choices: [], usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } }, 'gpt-5.6-terra')
    expect(empty.output).toHaveLength(1)
    expect(empty.output[0].type).toBe('message')
  })

  test('includes output item in completed SSE event', () => {
    const stream = new AgnesResponsesSse('gpt-5.6-sol')
    const result = stream.write(Buffer.from('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n')) + stream.end()
    expect(result).toContain('response.output_text.delta')
    expect(result).toContain('response.output_text.done')
    expect(result).toContain('"text":"hi"')
    expect(result).toContain('"output":[{"id":')
  })

  test('uses the same adapter for the terra public model', () => {
    const result = responsesToChat({ model: 'gpt-5.6-terra', input: 'hello' })
    expect(result).toMatchObject({ model: 'gpt-5.6-terra', messages: [{ role: 'user', content: 'hello' }] })
  })
  test('rewrites only the model and preserves native Responses structures', () => {
    const input = {
      model: 'gpt-5.5',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '查一下文件' }] },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
      ],
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
      tool_choice: { type: 'function', name: 'lookup' },
      previous_response_id: 'resp_previous',
      reasoning: { effort: 'medium' },
    }
    const body = rewriteRequestBody(Buffer.from(JSON.stringify(input)), 'gpt-5.5', 'agnes-2.5-flash', '/responses?stream=true')
    expect(JSON.parse(String(body))).toEqual({ ...input, model: 'agnes-2.5-flash' })
  })

  test('accepts only stateless text requests for the simple fallback', () => {
    const chat = Buffer.from(JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: '你好' }] }))
    const responses = Buffer.from(JSON.stringify({ model: 'gpt-5.5', input: [{ role: 'user', content: [{ type: 'input_text', text: '你好' }] }] }))
    expect(isSimpleTextRequest(chat, '/chat/completions')).toBe(true)
    expect(isSimpleTextRequest(responses, '/responses')).toBe(true)
    expect(isSimpleTextRequest(Buffer.from(JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: '你好' }], tools: [{ type: 'function', name: 'lookup' }] })), '/chat/completions')).toBe(false)
    expect(isSimpleTextRequest(Buffer.from(JSON.stringify({ model: 'gpt-5.5', input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://example.test/image.png' }] }] })), '/responses')).toBe(false)
    expect(isSimpleTextRequest(Buffer.from(JSON.stringify({ model: 'gpt-5.5', input: [{ role: 'user', content: [{ type: 'input_text', text: '你好' }] }], previous_response_id: 'resp_previous' })), '/responses')).toBe(false)
  })

  test('keeps tool_choice when rewriting a request with no tools', () => {
    const input = { model: 'gpt-5.5', tool_choice: { type: 'function', name: 'tool_choice' } }
    const body = rewriteRequestBody(Buffer.from(JSON.stringify(input)), 'gpt-5.5', 'agnes-2.5-flash', '/responses?stream=true')
    expect(JSON.parse(String(body))).toEqual({ ...input, model: 'agnes-2.5-flash' })
  })
  test.each([401, 403, 408, 429, 500, 502, 503, 599])('fails over retryable provider HTTP %i', (status) => {
    expect(shouldFailover(status)).toBe(true)
  })

  test.each([200, 201, 301, 400, 404, 409, 422, 499])('does not fail over ordinary HTTP %i', (status) => {
    expect(shouldFailover(status)).toBe(false)
  })

  test('rejects an HTML dashboard returned as a successful API response', () => {
    expect(isInvalidApiResponse(200, { 'content-type': 'text/html; charset=utf-8' })).toBe(true)
    expect(isInvalidApiResponse(200, { 'content-type': 'application/json; charset=utf-8' })).toBe(false)
    expect(isInvalidApiResponse(500, { 'content-type': 'text/html' })).toBe(false)
  })

  test('normalizes failed-attempt diagnostics before persistence', () => {
    expect(safeRelayError('network_error')).toEqual({
      errorType: 'network_error', errorCode: 'upstream_network_error', errorMessage: '上游网络错误',
    })
    expect(safeRelayError('timeout')).toEqual({
      errorType: 'timeout', errorCode: 'upstream_timeout', errorMessage: '上游请求超时',
    })
  })

  test('explains provider credential and balance failures without exposing upstream bodies', () => {
    expect(responseFailure(401)).toEqual({ errorType: 'provider_auth', errorCode: 'upstream_unauthorized', errorMessage: '上游认证失败或 Key 无效' })
    expect(responseFailure(403)).toEqual({ errorType: 'provider_access', errorCode: 'upstream_forbidden', errorMessage: '上游拒绝访问，可能是权限或余额不足' })
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
