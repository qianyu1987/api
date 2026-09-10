import { describe, expect, test } from 'vitest'
import { assertDiscount, discountLimit, effectiveDiscountBps, profitRules } from '../src/services/profit.js'

describe('global profit discount guardrail', () => {
  const rules = profitRules({ profit_min_margin_bps: '3000', payment_fee_rate_bps: '0', affiliate_rate_bps: '1000', affiliate_enabled: 'true', global_token_discount_bps: '0' })

  test('takes the strictest personal/global discount and includes fees and rebate', () => {
    expect(effectiveDiscountBps(9000, 0)).toBe(9000)
    expect(effectiveDiscountBps(1000, 2500)).toBe(2500)
    const limit = discountLimit([{ model_pattern: 'healthy', active: true, input_cost_micros_per_million: '500000', input_sell_micros_per_million: '1000000', output_cost_micros_per_million: '500000', output_sell_micros_per_million: '1000000', cache_cost_micros_per_million: '500000', cache_sell_micros_per_million: '1000000' }], rules)
    expect(limit.maxDiscountBps).toBe(1666)
  })

  test('a loss making model forces the safe global discount to zero', () => {
    const limit = discountLimit([{ model_pattern: 'gpt-5.5', active: true, input_cost_micros_per_million: '28800000', input_sell_micros_per_million: '14400000', output_cost_micros_per_million: '144000000', output_sell_micros_per_million: '72000000', cache_cost_micros_per_million: '2880000', cache_sell_micros_per_million: '1440000' }], rules)
    expect(limit.maxDiscountBps).toBe(0)
    expect(limit.blockers.some((item) => item.model === 'gpt-5.5')).toBe(true)
    expect(() => assertDiscount([{ model_pattern: 'gpt-5.5', active: true, input_cost_micros_per_million: '28800000', input_sell_micros_per_million: '14400000', output_cost_micros_per_million: '144000000', output_sell_micros_per_million: '72000000', cache_cost_micros_per_million: '2880000', cache_sell_micros_per_million: '1440000' }], rules, 1)).toThrow('最多允许 0%')
  })

  test('checks the 272K pricing tier as well', () => {
    const limit = discountLimit([{ model_pattern: 'tiered', active: true, input_cost_micros_per_million: '500000', input_sell_micros_per_million: '1000000', output_cost_micros_per_million: '500000', output_sell_micros_per_million: '1000000', cache_cost_micros_per_million: '500000', cache_sell_micros_per_million: '1000000', pricing_tiers: [{ thresholdTokens: '272001', label: '272K+', inputCostMicrosPerMillion: '900000', inputSellMicrosPerMillion: '1000000', outputCostMicrosPerMillion: '500000', outputSellMicrosPerMillion: '1000000', cacheCostMicrosPerMillion: '500000', cacheSellMicrosPerMillion: '1000000' }] }], rules)
    expect(limit.maxDiscountBps).toBe(0)
  })
})
