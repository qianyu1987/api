import { describe, expect, test } from 'vitest'
import { mergeSseUsage, parseSseUsage, usageFromPayload } from '../src/lib/usage.js'

describe('usage parsing', () => {
  test('normalizes chat-completions and responses usage fields', () => {
    expect(usageFromPayload({ usage: {
      prompt_tokens: 120,
      completion_tokens: 30,
      cached_tokens: 20,
      total_tokens: 150,
    } })).toEqual({ input: 100n, output: 30n, cache: 20n, reportedTotal: 150n })

    expect(usageFromPayload({ response: { usage: {
      input_tokens: '80',
      output_tokens: '12',
      input_tokens_details: { cached_tokens: '8' },
    } } })).toEqual({ input: 72n, output: 12n, cache: 8n, reportedTotal: 92n })

    expect(usageFromPayload({ usage: {
      prompt_tokens: 50,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 15 },
      total_tokens: 55,
    } })).toEqual({ input: 35n, output: 5n, cache: 15n, reportedTotal: 55n })
  })

  test('returns the last valid usage event from an SSE transcript', () => {
    const transcript = [
      'event: response.output_text.delta',
      'data: {"delta":"hello"}',
      '',
      'data: {not-complete-json',
      '',
      'data: {"usage":{"prompt_tokens":9,"completion_tokens":3,"total_tokens":12}}',
      '',
      'data: {"response":{"usage":{"input_tokens":10,"output_tokens":4,"cached_tokens":2,"total_tokens":14}}}',
      '',
      'data: [DONE]',
    ].join('\n')

    expect(parseSseUsage(transcript)).toEqual({ input: 8n, output: 4n, cache: 2n, reportedTotal: 14n })
  })

  test('ignores empty usage and keeps the previous parsed value', () => {
    const current = { input: 3n, output: 1n, cache: 0n, reportedTotal: 4n }
    expect(parseSseUsage('data: {"usage":{}}\n\ndata: [DONE]\n')).toBeNull()
    expect(mergeSseUsage(current, null)).toBe(current)
    expect(mergeSseUsage(current, { input: 5n, output: 2n, cache: 0n, reportedTotal: 7n }))
      .toEqual({ input: 5n, output: 2n, cache: 0n, reportedTotal: 7n })
  })
})
