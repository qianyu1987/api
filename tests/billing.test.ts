import { describe, expect, test } from 'vitest'
import {
  allocateSettlementCharge,
  deserializePriceSnapshot,
  serializePriceSnapshot,
  nextShanghaiReset,
  type PriceSnapshot,
} from '../src/services/billing.js'

const price: PriceSnapshot = {
  modelPattern: 'gpt-test',
  billingMode: 'token',
  inputSellMicrosPerMillion: 1_000_000n,
  outputSellMicrosPerMillion: 2_000_000n,
  cacheSellMicrosPerMillion: 500_000n,
  inputCostMicrosPerMillion: 500_000n,
  outputCostMicrosPerMillion: 1_000_000n,
  cacheCostMicrosPerMillion: 250_000n,
  fixedSellMicros: 0n,
  fixedCostMicros: 0n,
}

describe('billing invariants', () => {
  test('computes the next Monday 09:00 in Shanghai time', () => {
    expect(nextShanghaiReset(new Date('2026-08-31T00:30:00.000Z')).toISOString()).toBe('2026-08-31T01:00:00.000Z')
    expect(nextShanghaiReset(new Date('2026-08-31T01:00:00.000Z')).toISOString()).toBe('2026-09-07T01:00:00.000Z')
  })
  test('price snapshots are immutable string values that can be restored exactly', () => {
    const snapshot = serializePriceSnapshot(price, {
      input: 13n, output: 7n, cache: 3n, reportedTotal: 23n,
    }, {
      model: 'gpt-test', requestPath: '/v1/chat/completions', requestMethod: 'POST', keyId: 'key-1', keyName: 'main',
    })
    const restored = deserializePriceSnapshot(snapshot)
    expect(restored.price.inputSellMicrosPerMillion).toBe(1_000_000n)
    expect(restored.price.outputSellMicrosPerMillion).toBe(2_000_000n)
    expect(restored.estimatedUsage).toEqual({ input: 13n, output: 7n, cache: 3n, reportedTotal: 23n })
    expect(restored.context).toMatchObject({ model: 'gpt-test', path: '/v1/chat/completions', method: 'POST' })
  })

  test('settlement uses plan first and never releases a successful overage for free', () => {
    expect(allocateSettlementCharge(120n, 50n, 30n)).toEqual({
      settledChargeMicros: 80n,
      planChargeMicros: 50n,
      walletChargeMicros: 30n,
      overageMicros: 40n,
    })
    expect(allocateSettlementCharge(20n, 50n, 30n)).toEqual({
      settledChargeMicros: 20n,
      planChargeMicros: 20n,
      walletChargeMicros: 0n,
      overageMicros: 0n,
    })
  })

  test('uses a matched fixed-route specification and rejects an unpriced specification', async () => {
    const db = {
      query: async () => [{
        id: 'fixed-price-1', http_method: 'POST', path_pattern: '/v1/images/generations', requested_model: 'gpt-image-1',
        selectors: { size: '1024x1024', quality: ['standard', 'hd'] }, unit_mode: 'count', unit_path: 'n',
        sell_micros: '5000000', cost_micros: '1000000',
      }],
    }
    const { BillingService } = await import('../src/services/billing.js')
    const billing = new BillingService(db as any)

    await expect(billing.fixedPriceFor('POST', '/v1/images/generations', 'gpt-image-1', {
      size: '1024x1024', quality: 'hd', n: 2,
    })).resolves.toMatchObject({
      billingMode: 'fixed', fixedSellMicros: 10_000_000n, fixedCostMicros: 2_000_000n,
    })

    await expect(billing.fixedPriceFor('POST', '/v1/images/generations', 'gpt-image-1', {
      size: '1024x1024', quality: 'medium', n: 1,
    })).rejects.toThrow('规格尚未配置价格')
  })
})
