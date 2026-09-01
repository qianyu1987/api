import { describe, expect, test } from 'vitest'
import {
  MICROS_PER_CENT,
  calculateUsageMoney,
  ceilDiv,
  centsFromMicros,
  formatMicros,
  microsFromCents,
  estimatedRequestTokens,
  tokenCharge,
  type TokenRates,
} from '../src/lib/money.js'

describe('money helpers', () => {
  test('ceilDiv rounds positive values up and rejects invalid denominators', () => {
    expect(ceilDiv(0n, 7n)).toBe(0n)
    expect(ceilDiv(1n, 7n)).toBe(1n)
    expect(ceilDiv(7n, 7n)).toBe(1n)
    expect(ceilDiv(8n, 7n)).toBe(2n)
    expect(() => ceilDiv(1n, 0n)).toThrow('denominator')
  })

  test('converts between cents and micro-yuan without floating point', () => {
    expect(microsFromCents(1234)).toBe(12_340_000n)
    expect(microsFromCents(1234n)).toBe(12_340_000n)
    expect(centsFromMicros(MICROS_PER_CENT)).toBe(1n)
    expect(centsFromMicros(MICROS_PER_CENT + 1n)).toBe(2n)
    expect(formatMicros(12_340_000n)).toBe('12.34')
    expect(formatMicros(-1_000_001n)).toBe('-1.000001')
  })

  test('rounds every token price component up to a whole micro-yuan', () => {
    const rates: TokenRates = {
      inputSellMicrosPerMillion: 1_500_000n,
      outputSellMicrosPerMillion: 1_500_000n,
      cacheSellMicrosPerMillion: 1_500_000n,
      inputCostMicrosPerMillion: 1_000_000n,
      outputCostMicrosPerMillion: 1_000_000n,
      cacheCostMicrosPerMillion: 1_000_000n,
    }

    expect(tokenCharge(1n, 1_500_000n)).toBe(2n)
    expect(calculateUsageMoney({ input: 1n, output: 2n, cache: 3n, reportedTotal: 6n }, rates)).toEqual({
      chargeMicros: 10n,
      costMicros: 6n,
    })
  })

  test('keeps large token calculations exact with bigint', () => {
    expect(tokenCharge(9_007_199_254_740_993n, 2_000_000n)).toBe(18_014_398_509_481_986n)
  })

  test('uses a conservative request-size estimate and every common output limit', () => {
    const payload = { input: '你好', max_completion_tokens: '8192' }
    const usage = estimatedRequestTokens(payload)
    expect(usage.input).toBe(BigInt(Buffer.byteLength(JSON.stringify(payload), 'utf8')))
    expect(usage.output).toBe(8192n)
    expect(estimatedRequestTokens({ max_output_tokens: 22 }).output).toBe(22n)
    expect(estimatedRequestTokens({ max_tokens: 7 }).output).toBe(7n)
  })
})
