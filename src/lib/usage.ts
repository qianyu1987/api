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
  // OpenAI usage reports cached input as part of prompt/input tokens, while
  // Anthropic-style cache read/write counts are separate from input_tokens.
  const hasPromptTotal = usage.prompt_tokens != null
    || usage.prompt_tokens_details != null
    || (usage.input_tokens_details != null
      && usage.input_tokens != null
      && usage.cache_read_input_tokens == null
      && usage.cache_creation_input_tokens == null
      && usage.cache_write_input_tokens == null)
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
  const cacheWrite = nonNegative(
    usage.cache_write_input_tokens
      ?? usage.cache_creation_input_tokens
      ?? usage.cache_write_tokens
      ?? usage.cache_creation_tokens
      ?? usage.input_tokens_details?.cache_creation_tokens
      ?? usage.prompt_tokens_details?.cache_creation_tokens,
  )
  const hasSeparateCacheCounts = usage.cache_read_input_tokens != null
    || usage.cache_read_tokens != null
    || usage.cache_creation_input_tokens != null
    || usage.cache_creation_tokens != null
    || usage.cache_write_input_tokens != null
    || usage.cache_write_tokens != null
  const cacheCountsAreSeparate = !hasPromptTotal && hasSeparateCacheCounts
  const input = cacheCountsAreSeparate ? inputBeforeCache : inputBeforeCache > cache + cacheWrite ? inputBeforeCache - cache - cacheWrite : 0n
  const inferredTotal = inputBeforeCache + output + (cacheCountsAreSeparate ? cache + cacheWrite : 0n)
  const total = nonNegative(usage.total_tokens, inferredTotal)
  if (input === 0n && output === 0n && cache === 0n && cacheWrite === 0n && total === 0n) return null
  return { input, output, cache, cacheWrite, reportedTotal: total }
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
