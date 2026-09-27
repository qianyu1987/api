import { describe, expect, test } from 'vitest'
import { buildPricingPreview, requiredWalletSell } from '../src/services/pricing.js'

describe('cash-margin pricing preview', () => {
  const rules = { minimumMarginBps: 5000, paymentFeeRateBps: 0, affiliateRateBps: 1000, walletTopupMultiplierBps: 30000 }

  test('uses the conservative cash-margin formula and rounds up', () => {
    expect(requiredWalletSell(1_000_000n, rules)).toBe(7_500_000n)
    expect(requiredWalletSell(1n, rules)).toBe(8n)
  })

  test('takes maximum costs across active routes and blocks missing sourced costs', () => {
    const result = buildPricingPreview({
      rules,
      prices: [{ model_pattern: 'gpt-test', active: true }],
      channels: [
        { id: 'a', name: '低价', enabled: true, deleted_at: null, model_map: { 'gpt-test': 'upstream-a' } },
        { id: 'b', name: '缺成本', enabled: true, deleted_at: null, model_map: { 'gpt-test': 'upstream-b' } },
      ],
      costs: [{ channel_id: 'a', model_pattern: 'gpt-test', input_cost_micros_per_million: '100', output_cost_micros_per_million: '200', cache_cost_micros_per_million: '50', price_source: '账单 2026-09-27' }],
    })
    expect(result.ready).toBe(false)
    expect(result.blockers).toMatchObject([{ kind: 'cost_missing', channelName: '缺成本', model: 'gpt-test' }])
    expect(result.models).toHaveLength(0)
  })

  test('publishing preview includes all active channels when costs are complete', () => {
    const result = buildPricingPreview({
      rules,
      prices: [{ model_pattern: 'gpt-test', active: true }],
      channels: [
        { id: 'a', name: '低价', enabled: true, deleted_at: null, model_map: { 'gpt-test': 'upstream-a' } },
        { id: 'b', name: '高价', enabled: true, deleted_at: null, model_map: { 'gpt-test': 'upstream-b' } },
      ],
      costs: [
        { channel_id: 'a', model_pattern: 'gpt-test', input_cost_micros_per_million: '100', output_cost_micros_per_million: '200', cache_cost_micros_per_million: '50', price_source: '账单 A' },
        { channel_id: 'b', model_pattern: 'gpt-test', input_cost_micros_per_million: '300', output_cost_micros_per_million: '400', cache_cost_micros_per_million: '60', price_source: '账单 B' },
      ],
    })
    expect(result.ready).toBe(true)
    expect(result.models[0]).toMatchObject({ inputCostMicrosPerMillion: '300', outputCostMicrosPerMillion: '400', cacheCostMicrosPerMillion: '60' })
    expect(result.models[0].sources).toEqual(['账单 A', '账单 B'])
  })
})
