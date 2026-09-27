import { describe, expect, test } from 'vitest'
import { buildPricingPreview, requiredWalletSell } from '../src/services/pricing.js'

describe('cash-margin pricing preview', () => {
  const rules = { minimumMarginBps: 5000, paymentFeeRateBps: 0, affiliateRateBps: 1000, walletTopupMultiplierBps: 30000 }

  test('uses the conservative cash-margin formula and rounds up', () => {
    expect(requiredWalletSell(1_000_000n, rules)).toBe(12_500_000n)
    expect(requiredWalletSell(1n, rules)).toBe(13n)
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

  test('prefers a model-specific channel cost over a wildcard cost', () => {
    const result = buildPricingPreview({
      rules,
      prices: [{ model_pattern: 'gpt-test', active: true }],
      channels: [{ id: 'a', name: '混合成本', enabled: true, deleted_at: null, model_map: { 'gpt-test': 'upstream' } }],
      costs: [
        { channel_id: 'a', model_pattern: '*', input_cost_micros_per_million: '10', output_cost_micros_per_million: '20', cache_cost_micros_per_million: '5', high_context_multiplier_bps: 10000, price_source: '通配成本' },
        { channel_id: 'a', model_pattern: 'gpt-test', input_cost_micros_per_million: '300', output_cost_micros_per_million: '400', cache_cost_micros_per_million: '60', high_context_multiplier_bps: 10000, price_source: '模型专属成本' },
      ],
    })
    expect(result.ready).toBe(true)
    expect(result.models[0]).toMatchObject({
      inputCostMicrosPerMillion: '300',
      outputCostMicrosPerMillion: '400',
      cacheCostMicrosPerMillion: '60',
      sources: ['模型专属成本'],
    })
  })

  test('prices from the highest 272K+ channel cost with at least the enterprise 5x multiplier', () => {
    const result = buildPricingPreview({
      rules,
      prices: [{ model_pattern: 'gpt-test', active: true }],
      channels: [{ id: 'a', name: '高上下文', enabled: true, deleted_at: null, model_map: { 'gpt-test': 'upstream' } }],
      costs: [{ channel_id: 'a', model_pattern: 'gpt-test', input_cost_micros_per_million: '300', output_cost_micros_per_million: '400', cache_cost_micros_per_million: '60', high_context_multiplier_bps: 12000, price_source: '账单' }],
    })
    expect(result.models[0]).toMatchObject({
      standardInputCostMicrosPerMillion: '300', highContextInputCostMicrosPerMillion: '360',
      inputCostMicrosPerMillion: '360', inputSellMicrosPerMillion: '4500',
    })
  })

  test('builds gpt-6-sol Standard and 272K+ prices from the four official cost parts', () => {
    const result = buildPricingPreview({
      rules: { minimumMarginBps: 3000, paymentFeeRateBps: 0, affiliateRateBps: 1000, walletTopupMultiplierBps: 50000 },
      prices: [{ model_pattern: 'gpt-6-sol', active: true }],
      channels: [{ id: 'sol', name: 'Sol', enabled: true, deleted_at: null, model_map: { 'gpt-6-sol': 'gpt-6-sol' } }],
      costs: [{ channel_id: 'sol', model_pattern: 'gpt-6-sol', provider_tier_costs: { standard: {
        inputCostMicrosPerMillion: '2000000', outputCostMicrosPerMillion: '10000000',
        cacheReadCostMicrosPerMillion: '200000', cacheWriteCostMicrosPerMillion: '2500000',
        highContextMultipliers: { input: 20000, output: 15000, cacheRead: 20000, cacheWrite: 20000 }, source: 'official screenshot',
      } } }],
    })
    expect(result.ready).toBe(true)
    expect(result.models[0]).toMatchObject({
      standardInputCostMicrosPerMillion: '2000000', highContextInputCostMicrosPerMillion: '4000000',
      standardCacheWriteCostMicrosPerMillion: '2500000', highContextCacheWriteCostMicrosPerMillion: '5000000',
      inputSellMicrosPerMillion: '16666667', outputSellMicrosPerMillion: '83333334', cacheSellMicrosPerMillion: '1666667',
      standardCacheWriteSellMicrosPerMillion: '20833334', highContextInputSellMicrosPerMillion: '33333334',
      highContextOutputSellMicrosPerMillion: '125000000', highContextCacheWriteSellMicrosPerMillion: '41666667',
    })
  })
})
