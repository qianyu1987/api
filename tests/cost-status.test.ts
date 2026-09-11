import { describe, expect, test } from 'vitest'
import { fallbackCostPending } from '../src/lib/cost-status.js'
import { applyChannelCost } from '../src/lib/channel-cost.js'
import { calculatePrice, deserializePriceSnapshot, serializePriceSnapshot, type PriceSnapshot } from '../src/services/billing.js'

const row = { requested_model: 'gpt-5.6-sol', upstream_model: 'agnes-2.5-flash', final_channel_id: 'fallback' }
const cost = { channelId: 'fallback', model: 'gpt-5.6-sol', inputMicros: '1000000', outputMicros: '2000000', cacheMicros: '1000000', highContextMultiplierBps: 12000, source: 'test invoice', effectiveAt: '2026-09-11T00:00:00.000Z' }

describe('fallback cost provenance', () => {
  test('flags historical default estimates and rejects unrelated or unsourced snapshots', () => {
    expect(fallbackCostPending(row)).toBe(true)
    for (const override of [{ channelId: 'different' }, { model: 'gpt-6-astra' }, { source: '' }]) {
      expect(fallbackCostPending({ ...row, pricing_snapshot: { appliedChannelCost: { ...cost, ...override } } })).toBe(true)
    }
    expect(fallbackCostPending({ ...row, pricing_snapshot: { appliedChannelCost: cost } })).toBe(false)
    expect(fallbackCostPending({ ...row, upstream_model: 'gpt-5.6-sol' })).toBe(false)
  })
  test('billing restores the frozen fallback cost despite later configuration changes', () => {
    const price: PriceSnapshot = {
      modelPattern: 'gpt-5.6-sol', billingMode: 'token',
      inputSellMicrosPerMillion: 10_000_000n, outputSellMicrosPerMillion: 20_000_000n, cacheSellMicrosPerMillion: 10_000_000n,
      inputCostMicrosPerMillion: 5_000_000n, outputCostMicrosPerMillion: 5_000_000n, cacheCostMicrosPerMillion: 5_000_000n,
      fixedCostMicros: 0n, fixedSellMicros: 0n, channelCosts: [{ ...cost }],
    }
    const usage = { input: 100n, output: 10n, cache: 50n, reportedTotal: 160n }
    const context = { model: 'gpt-5.6-sol', requestPath: '/v1/responses', requestMethod: 'POST' }
    const persisted = JSON.parse(JSON.stringify(serializePriceSnapshot(price, usage, context)))
    price.channelCosts![0].inputMicros = '90000000'
    price.inputSellMicrosPerMillion = 90_000_000n
    const restored = deserializePriceSnapshot(persisted).price
    const final = applyChannelCost(restored, restored.channelCosts!, 'fallback')
    expect(calculatePrice(final, usage)).toEqual({ chargeMicros: 1700n, costMicros: 170n })
    const audit = serializePriceSnapshot(final, usage, context)
    expect(audit.appliedChannelCost).toMatchObject({ channelId: 'fallback', inputMicros: '1000000', source: 'test invoice' })
    expect(persisted).not.toHaveProperty('appliedChannelCost')
    expect(fallbackCostPending({ ...row, pricing_snapshot: audit })).toBe(false)
  })
})
