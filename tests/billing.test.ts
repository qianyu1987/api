import { describe, expect, test } from 'vitest'
import {
  allocateSettlementCharge,
  deserializePriceSnapshot,
  serializePriceSnapshot,
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
})
