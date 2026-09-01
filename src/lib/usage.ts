import { asBigInt, type UsageTokens } from './money.js'

function nonNegative(value: unknown, fallback = 0n): bigint {
  const parsed = asBigInt(value, fallback)
  return parsed > 0n ? parsed : 0n
}

export function usageFromPayload(payload: unknown): UsageTokens | null {
  if (!payload || typeof payload !== 'object') return null
  const root = payload as any
  const usage = root.usage || root.data?.usage || root.response?.usage
  if (!usage || typeof usage !== 'object') return null
  // OpenAI reports cached input as a subset of prompt/input tokens. Store the
  // regular input component without that subset so rate calculation applies
  // either the normal or cache price to each input token, never both.
  const inputBeforeCache = nonNegative(usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens)
  const output = nonNegative(usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens)
  const cache = nonNegative(
    usage.cache_read_input_tokens
      ?? usage.cached_tokens
      ?? usage.cache_tokens
      ?? usage.cache_read_tokens
      ?? usage.prompt_tokens_details?.cached_tokens
      ?? usage.input_tokens_details?.cached_tokens,
  )
  const input = inputBeforeCache > cache ? inputBeforeCache - cache : 0n
  const total = nonNegative(usage.total_tokens, inputBeforeCache + output)
  if (input === 0n && output === 0n && cache === 0n && total === 0n) return null
  return { input, output, cache, reportedTotal: total }
}

export function parseSseUsage(buffer: string): UsageTokens | null {
  let found: UsageTokens | null = null
  for (const line of buffer.split(/\r?\n/)) {
    const value = line.trim()
    if (!value.startsWith('data:')) continue
    const body = value.slice(5).trim()
    if (!body || body === '[DONE]') continue
    try {
      const usage = usageFromPayload(JSON.parse(body))
      if (usage) found = usage
    } catch { /* partial or provider-specific SSE frame */ }
  }
  return found
}

export function mergeSseUsage(current: UsageTokens | null, next: UsageTokens | null): UsageTokens | null {
  return next || current
}
