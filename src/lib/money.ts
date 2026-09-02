export const MICROS_PER_YUAN = 1_000_000n
export const MICROS_PER_CENT = 10_000n
export const TOKENS_PER_MILLION = 1_000_000n
// JSON request bytes are not one token each. Use a conservative, provider-
// neutral UTF-8 estimate so large Codex tool definitions do not make a user
// with sufficient funds fail preauthorization unnecessarily.
export const ESTIMATED_BYTES_PER_TOKEN = 4n
// Large Codex clients commonly declare a provider maximum that is much higher
// than the response they actually consume. Keep the reservation bounded; the
// final settlement still uses reported usage when available.
export const MAX_RESERVED_OUTPUT_TOKENS = 8_192n

export type TokenRates = {
  inputSellMicrosPerMillion: bigint
  outputSellMicrosPerMillion: bigint
  cacheSellMicrosPerMillion: bigint
  inputCostMicrosPerMillion: bigint
  outputCostMicrosPerMillion: bigint
  cacheCostMicrosPerMillion: bigint
}

export type UsageTokens = {
  input: bigint
  output: bigint
  cache: bigint
  reportedTotal: bigint
}

export function asBigInt(value: unknown, fallback = 0n): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
  return fallback
}

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('division denominator must be positive')
  return numerator <= 0n ? 0n : (numerator + denominator - 1n) / denominator
}

export function microsFromCents(cents: number | bigint): bigint {
  return asBigInt(cents) * MICROS_PER_CENT
}

export function centsFromMicros(micros: bigint): bigint {
  return ceilDiv(micros, MICROS_PER_CENT)
}

export function formatMicros(micros: bigint): string {
  const sign = micros < 0n ? '-' : ''
  const absolute = micros < 0n ? -micros : micros
  const yuan = absolute / MICROS_PER_YUAN
  const decimals = (absolute % MICROS_PER_YUAN).toString().padStart(6, '0').replace(/0+$/, '')
  return `${sign}${yuan.toString()}${decimals ? `.${decimals}` : ''}`
}

/** Converts a non-negative yuan string to micro-yuan without float rounding. */
export function yuanToMicros(value: string | number | bigint): bigint {
  const text = String(value).trim()
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) throw new Error('金额必须是最多 6 位小数的人民币金额')
  const [whole, fraction = ''] = text.split('.')
  return BigInt(whole) * MICROS_PER_YUAN + BigInt(fraction.padEnd(6, '0'))
}

/**
 * Calculates the selling price for a target gross margin. For example, a
 * 80% gross margin means sell = cost / 0.20. The result always rounds up so
 * the configured price cannot slip below the requested margin.
 */
export function sellForGrossMargin(costMicros: bigint, marginBps: bigint): bigint {
  if (costMicros <= 0n || marginBps < 0n || marginBps >= 10_000n) throw new Error('成本或毛利率无效')
  const denominator = 10_000n - marginBps
  return ceilDiv(costMicros * 10_000n, denominator)
}

export function tokenCharge(tokens: bigint, microsPerMillion: bigint): bigint {
  return ceilDiv(tokens * microsPerMillion, TOKENS_PER_MILLION)
}

export function calculateUsageMoney(tokens: UsageTokens, rates: TokenRates): { chargeMicros: bigint; costMicros: bigint } {
  const chargeMicros = tokenCharge(tokens.input, rates.inputSellMicrosPerMillion)
    + tokenCharge(tokens.output, rates.outputSellMicrosPerMillion)
    + tokenCharge(tokens.cache, rates.cacheSellMicrosPerMillion)
  const costMicros = tokenCharge(tokens.input, rates.inputCostMicrosPerMillion)
    + tokenCharge(tokens.output, rates.outputCostMicrosPerMillion)
    + tokenCharge(tokens.cache, rates.cacheCostMicrosPerMillion)
  return { chargeMicros, costMicros }
}

function declaredOutputLimit(payload: Record<string, unknown>): bigint | null {
  for (const value of [payload.max_output_tokens, payload.max_completion_tokens, payload.max_tokens]) {
    if (value === undefined || value === null) continue
    try {
      const parsed = typeof value === 'bigint'
        ? value
        : typeof value === 'number' && Number.isSafeInteger(value)
          ? BigInt(value)
          : typeof value === 'string' && /^\d+$/.test(value.trim())
            ? BigInt(value.trim())
            : null
      if (parsed !== null && parsed >= 0n) return parsed
    } catch { /* fall through to the next compatible field */ }
  }
  return null
}

function reservedOutputTokens(payload: Record<string, unknown>): bigint {
  const declared = declaredOutputLimit(payload)
  const output = declared ?? 4_096n
  return output > MAX_RESERVED_OUTPUT_TOKENS ? MAX_RESERVED_OUTPUT_TOKENS : output
}

export function estimatedRequestTokens(payload: Record<string, unknown>): UsageTokens {
  // Estimate request tokens from UTF-8 JSON size. Final settlement still uses
  // provider-reported usage where available; this estimate only reserves funds.
  let encoded = ''
  try { encoded = JSON.stringify(payload) || '' } catch { /* malformed local payloads remain billable */ }
  const inputBytes = BigInt(Math.max(1, Buffer.byteLength(encoded, 'utf8')))
  const input = ceilDiv(inputBytes, ESTIMATED_BYTES_PER_TOKEN)
  // Newer OpenAI-compatible APIs use max_completion_tokens. Honor all common
  // aliases, but cap pathological client-declared maxima for the initial hold.
  const output = reservedOutputTokens(payload)
  return { input, output, cache: 0n, reportedTotal: input + output }
}
