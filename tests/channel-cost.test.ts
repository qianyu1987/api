import { describe, expect, test } from 'vitest'
import { applyChannelCost, type ChannelCostSnapshot } from '../src/lib/channel-cost.js'
import { calculatePrice, tierRates, type PriceSnapshot } from '../src/services/billing.js'

const price: PriceSnapshot = {
  modelPattern: 'gpt-6-astra',
  billingMode: 'token',
  inputSellMicrosPerMillion: 12_000_000n,
  outputSellMicrosPerMillion: 60_000_000n,
  cacheSellMicrosPerMillion: 2_400_000n,
  inputCostMicrosPerMillion: 0n,
  outputCostMicrosPerMillion: 0n,
  cacheCostMicrosPerMillion: 0n,
  fixedSellMicros: 0n,
  fixedCostMicros: 0n,
}

const stablePlus: ChannelCostSnapshot = {
  channelId: 'stable-plus',
  model: 'gpt-6-astra',
  inputMicros: '5760000',
  outputMicros: '28800000',
  cacheMicros: '5760000',
  highContextMultiplierBps: 12000,
  source: 'stableplus screenshot',
  effectiveAt: '2026-09-05T00:00:00.000Z',
}

describe('provider channel cost overrides', () => {
  test('uses the final channel cost while preserving the selling rates', () => {
    const applied = applyChannelCost(price, [stablePlus], 'stable-plus')
    expect(applied.inputSellMicrosPerMillion).toBe(price.inputSellMicrosPerMillion)
    expect(applied.outputSellMicrosPerMillion).toBe(price.outputSellMicrosPerMillion)
    expect(tierRates(applied, 272000n)).toMatchObject({
      inputCostMicrosPerMillion: 5_760_000n,
      outputCostMicrosPerMillion: 28_800_000n,
      cacheCostMicrosPerMillion: 5_760_000n,
    })
  })

  test('raises only the frozen provider cost by 20 percent above 272K', () => {
    const applied = applyChannelCost(price, [stablePlus], 'stable-plus')
    expect(tierRates(applied, 272001n)).toMatchObject({
      inputSellMicrosPerMillion: 12_000_000n,
      outputSellMicrosPerMillion: 60_000_000n,
      inputCostMicrosPerMillion: 6_912_000n,
      outputCostMicrosPerMillion: 34_560_000n,
      cacheCostMicrosPerMillion: 6_912_000n,
    })
    expect(calculatePrice(applied, { input: 272001n, output: 0n, cache: 0n, reportedTotal: 272001n })).toMatchObject({
      chargeMicros: 3_264_012n,
      costMicros: 1_880_071n,
    })
  })

  test('does not apply another channel cost', () => {
    const applied = applyChannelCost(price, [stablePlus], 'other-channel')
    expect(applied.inputCostMicrosPerMillion).toBe(0n)
  })
})
