import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  allocateSettlementCharge,
  applyTokenDiscount,
  deserializePriceSnapshot,
  serializePriceSnapshot,
  nextShanghaiReset,
  nextSubscriptionReset,
  nextGrantCycle,
  calculatePrice,
  guardTokenPrice,
  tierRates,
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
  const tieredPrice: PriceSnapshot = { ...price, pricingTiers: [
    { thresholdTokens: 0n, inputSellMicrosPerMillion: 1_000_000n, outputSellMicrosPerMillion: 2_000_000n, cacheSellMicrosPerMillion: 500_000n, inputCostMicrosPerMillion: 500_000n, outputCostMicrosPerMillion: 1_000_000n, cacheCostMicrosPerMillion: 250_000n },
    { thresholdTokens: 272001n, inputSellMicrosPerMillion: 1_200_000n, outputSellMicrosPerMillion: 2_400_000n, cacheSellMicrosPerMillion: 600_000n, inputCostMicrosPerMillion: 600_000n, outputCostMicrosPerMillion: 1_200_000n, cacheCostMicrosPerMillion: 300_000n },
  ] }
  test('selects the standard tier at 272K and the high tier above it', () => {
    expect(tierRates(tieredPrice, 272000n).inputSellMicrosPerMillion).toBe(1_000_000n)
    expect(tierRates(tieredPrice, 272001n).inputSellMicrosPerMillion).toBe(1_200_000n)
    expect(calculatePrice(tieredPrice, { input: 272001n, output: 0n, cache: 0n, reportedTotal: 272001n }).chargeMicros).toBe(ceilToken(272001n, 1_200_000n))
  })
  test('computes the next Monday 09:00 in Shanghai time', () => {
    expect(nextShanghaiReset(new Date('2026-08-31T00:30:00.000Z')).toISOString()).toBe('2026-08-31T01:00:00.000Z')
    expect(nextShanghaiReset(new Date('2026-08-31T01:00:00.000Z')).toISOString()).toBe('2026-09-07T01:00:00.000Z')
  })
  test('finite grant plans reset seven days after purchase while legacy plans keep Monday schedule', () => {
    const purchase = new Date('2026-09-01T04:00:00.000Z')
    expect(nextSubscriptionReset(purchase, true).toISOString()).toBe('2026-09-08T04:00:00.000Z')
    expect(nextSubscriptionReset(purchase, false).toISOString()).toBe('2026-09-07T01:00:00.000Z')
  })
  test('manual grants preserve the purchase cadence and delayed workers skip stale cycles', () => {
    const daySeven = new Date('2026-09-08T04:00:00.000Z')
    expect(nextGrantCycle(daySeven, new Date('2026-09-09T04:00:00.000Z'), true).toISOString()).toBe('2026-09-15T04:00:00.000Z')
    expect(nextGrantCycle(daySeven, new Date('2026-09-20T04:00:00.000Z'), true).toISOString()).toBe('2026-09-27T04:00:00.000Z')
    expect(nextGrantCycle(daySeven, new Date('2026-09-09T04:00:00.000Z'), false).toISOString()).toBe('2026-09-14T01:00:00.000Z')
  })
  test('price snapshots are immutable string values that can be restored exactly', () => {
    const snapshot = serializePriceSnapshot({ ...price, pricingTiers: [{ thresholdTokens: 272001n, ...price }] }, {
      input: 13n, output: 7n, cache: 3n, reportedTotal: 23n,
    }, {
      model: 'gpt-test', requestPath: '/v1/chat/completions', requestMethod: 'POST', keyId: 'key-1', keyName: 'main',
    })
    const restored = deserializePriceSnapshot(snapshot)
    expect(restored.price.inputSellMicrosPerMillion).toBe(1_000_000n)
    expect(restored.price.outputSellMicrosPerMillion).toBe(2_000_000n)
    expect(restored.estimatedUsage).toEqual({ input: 13n, output: 7n, cache: 3n, cacheWrite: 0n, reportedTotal: 23n })
    expect(restored.price.pricingTiers?.[0].thresholdTokens).toBe(272001n)
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

  test('applies user token discount to selling rates only', () => {
    const discounted = applyTokenDiscount(price, 2500n)
    expect(discounted.inputSellMicrosPerMillion).toBe(750_000n)
    expect(discounted.outputSellMicrosPerMillion).toBe(1_500_000n)
    expect(discounted.inputCostMicrosPerMillion).toBe(price.inputCostMicrosPerMillion)
  })

  test('clamps the maximum discount against 5x wallet cash and 272K channel cost', () => {
    const guarded = guardTokenPrice({
      price: { ...price, inputSellMicrosPerMillion: 1_200n, outputSellMicrosPerMillion: 1_200n, cacheSellMicrosPerMillion: 1_200n,
        inputCostMicrosPerMillion: 100n, outputCostMicrosPerMillion: 100n, cacheCostMicrosPerMillion: 100n },
      rules: { minimumMarginBps: 3000, paymentFeeRateBps: 0, affiliateRateBps: 1000, walletTopupMultiplierBps: 50000 },
      personalDiscountBps: 0, globalDiscountBps: 0, nightDiscountBps: 2500, nightDiscountActive: true,
      channelCosts: [{ channelId: 'channel-1', model: 'gpt-test', inputMicros: '100', outputMicros: '100', cacheMicros: '100', highContextMultiplierBps: 12000, source: 'invoice', effectiveAt: null }],
      coverageComplete: true,
    })
    expect(guarded.guard).toMatchObject({ requestedDiscountBps: 2500, appliedDiscountBps: 1666, maxSafeDiscountBps: 1666, protectionApplied: true, baselineSafe: true })
    expect(guarded.price.inputSellMicrosPerMillion).toBe(1_000n)
  })

  test('removes the night-only increase when an enabled channel cost is missing', () => {
    const guarded = guardTokenPrice({
      price: { ...price, inputSellMicrosPerMillion: 10_000_000n, outputSellMicrosPerMillion: 20_000_000n, cacheSellMicrosPerMillion: 5_000_000n },
      rules: { minimumMarginBps: 3000, paymentFeeRateBps: 0, affiliateRateBps: 1000, walletTopupMultiplierBps: 50000 },
      personalDiscountBps: 500, globalDiscountBps: 0, nightDiscountBps: 2500, nightDiscountActive: true,
      channelCosts: [], coverageComplete: false,
    })
    expect(guarded.guard).toMatchObject({ requestedDiscountBps: 2500, appliedDiscountBps: 500, protectionApplied: true, protectionReason: 'enabled_channel_cost_missing' })
  })

  test('freezes the guarded selling rate without repricing historical snapshots', () => {
    const guarded = guardTokenPrice({
      price: { ...price, inputSellMicrosPerMillion: 10_000_000n, outputSellMicrosPerMillion: 20_000_000n, cacheSellMicrosPerMillion: 5_000_000n },
      rules: { minimumMarginBps: 3000, paymentFeeRateBps: 0, affiliateRateBps: 1000, walletTopupMultiplierBps: 50000 },
      personalDiscountBps: 0, globalDiscountBps: 0, nightDiscountBps: 1000, nightDiscountActive: true,
      channelCosts: [], coverageComplete: true,
    })
    const snapshot = serializePriceSnapshot(guarded.price, { input: 1n, output: 1n, cache: 0n, reportedTotal: 2n }, {
      model: 'gpt-test', requestPath: '/v1/responses', requestMethod: 'POST',
    })
    const restored = deserializePriceSnapshot(snapshot).price
    expect(restored.cashGuard).toMatchObject({ appliedDiscountBps: 1000, walletTopupMultiplierBps: 50000 })
    expect(restored.inputSellMicrosPerMillion).toBe(9_000_000n)
  })

  test('preserves an existing personal discount when the baseline is already below the target', () => {
    const guarded = guardTokenPrice({
      price,
      rules: { minimumMarginBps: 3000, paymentFeeRateBps: 0, affiliateRateBps: 1000, walletTopupMultiplierBps: 50000 },
      personalDiscountBps: 500, globalDiscountBps: 0, nightDiscountBps: 2500, nightDiscountActive: true,
      channelCosts: [], coverageComplete: true,
    })
    expect(guarded.guard).toMatchObject({ baselineSafe: false, requestedDiscountBps: 2500, appliedDiscountBps: 500, protectionApplied: true, protectionReason: 'baseline_below_minimum_margin' })
    expect(guarded.price.inputSellMicrosPerMillion).toBe(950_000n)
  })

  test('checks each gpt-6-sol sale tier against its matching standard or 272K+ cost', () => {
    const guarded = guardTokenPrice({
      price: {
        ...price,
        modelPattern: 'gpt-6-sol',
        inputSellMicrosPerMillion: 20_000_000n, outputSellMicrosPerMillion: 100_000_000n,
        cacheSellMicrosPerMillion: 2_000_000n, cacheWriteSellMicrosPerMillion: 25_000_000n,
        inputCostMicrosPerMillion: 2_000_000n, outputCostMicrosPerMillion: 10_000_000n,
        cacheCostMicrosPerMillion: 200_000n, cacheWriteCostMicrosPerMillion: 2_500_000n,
        pricingTiers: [{
          thresholdTokens: 272001n,
          inputSellMicrosPerMillion: 40_000_000n, outputSellMicrosPerMillion: 150_000_000n,
          cacheSellMicrosPerMillion: 4_000_000n, cacheWriteSellMicrosPerMillion: 50_000_000n,
          inputCostMicrosPerMillion: 4_000_000n, outputCostMicrosPerMillion: 15_000_000n,
          cacheCostMicrosPerMillion: 400_000n, cacheWriteCostMicrosPerMillion: 5_000_000n,
        }],
      },
      rules: { minimumMarginBps: 3000, paymentFeeRateBps: 0, affiliateRateBps: 1000, walletTopupMultiplierBps: 50000 },
      personalDiscountBps: 0, globalDiscountBps: 0, nightDiscountBps: 0, nightDiscountActive: false,
      channelCosts: [{
        channelId: 'sol', model: 'gpt-6-sol', inputMicros: '2000000', outputMicros: '10000000', cacheMicros: '200000', cacheWriteMicros: '2500000',
        highContextMultiplierBps: 10000, highContextInputMultiplierBps: 20000, highContextOutputMultiplierBps: 15000,
        highContextCacheMultiplierBps: 20000, highContextCacheWriteMultiplierBps: 20000, source: 'official price screenshot', effectiveAt: null,
      }],
      coverageComplete: true,
    })
    expect(guarded.guard.baselineSafe).toBe(true)
    expect(guarded.guard.maxSafeDiscountBps).toBeGreaterThan(0)
  })

  test('formats balance with exact micro-yuan fields for UI and clients', async () => {
    const { BillingService } = await import('../src/services/billing.js')
    expect(BillingService.formatBalance({
      walletMicros: 5_186_394n,
      walletReservedMicros: 120_000n,
      planMicros: 143_527_210n,
      planBookMicros: 145_106_470n,
      planReservedMicros: 1_579_260n,
      planUsedMicros: 3_893_530n,
      planQuotaMicros: 149_000_000n,
      planExpiresAt: null,
      planNextResetAt: null,
      planLastResetAt: null,
      planStatus: 'active',
      isValid: true,
    })).toMatchObject({
      planRemaining: '143.52721',
      planRemainingMicros: '143527210',
      planUsed: '3.89353',
      planUsedMicros: '3893530',
      planQuota: '149',
      planQuotaMicros: '149000000',
      planReservedMicros: '1579260',
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

  test('does not let a fixed route bypass gpt-6-sol token tier validation', async () => {
    const billing = new (await import('../src/services/billing.js')).BillingService({
      query: async (sql: string) => sql.includes('fixed_route_prices') ? [{
        id: 'fixed-sol', http_method: 'POST', path_pattern: '/v1/responses', requested_model: 'gpt-6-sol',
        selectors: null, unit_mode: 'request', sell_micros: '1000000', cost_micros: '100000',
      }] : [],
    } as any)
    await expect(billing.priceForRequest('POST', '/v1/responses', 'gpt-6-sol', {}))
      .rejects.toMatchObject({ statusCode: 409 })
  })

  test('rejects gpt-6-sol service-tier request headers before routing', async () => {
    const billing = new (await import('../src/services/billing.js')).BillingService({
      query: async () => [],
    } as any)
    await expect(billing.priceForRequest('POST', '/v1/responses', 'gpt-6-sol', {}, {
      'x-service-tier': 'fast',
    })).rejects.toMatchObject({ statusCode: 422 })
  })
})

describe('night discount reservation guard', () => {
  afterEach(() => vi.useRealTimers())

  test('keeps an existing personal discount and removes only unsafe night contribution', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-27T17:00:00.000Z'))
    let storedSnapshot: any = null
    const client = {
      query: vi.fn(async (sql: string, values: any[] = []) => {
        if (sql.includes('SELECT id, token_discount_bps FROM users')) return { rows: [{ id: 'user-1', token_discount_bps: 500 }], rowCount: 1 }
        if (sql.includes('SELECT * FROM billing_reservations')) return { rows: [], rowCount: 0 }
        if (sql.includes('SELECT key,value FROM app_settings')) return { rows: [
          { key: 'profit_min_margin_bps', value: '3000' }, { key: 'payment_fee_rate_bps', value: '0' },
          { key: 'affiliate_enabled', value: 'true' }, { key: 'affiliate_rate_bps', value: '1000' },
          { key: 'global_token_discount_bps', value: '0' }, { key: 'night_token_discount_enabled', value: 'true' },
          { key: 'night_token_discount_bps', value: '2500' },
        ], rowCount: 7 }
        if (sql.includes('MAX(topup_multiplier_bps)')) return { rows: [{ multiplier: 50000 }], rowCount: 1 }
        if (sql.includes('SELECT id,model_map FROM channels')) return { rows: [{ id: 'channel-1', model_map: { 'gpt-test': 'gpt-test' } }], rowCount: 1 }
        if (sql.includes('SELECT * FROM channel_model_costs')) return { rows: [{
          channel_id: 'channel-1', model_pattern: 'gpt-test', input_cost_micros_per_million: '500000',
          output_cost_micros_per_million: '1000000', cache_cost_micros_per_million: '250000',
          high_context_multiplier_bps: 10000, price_source: 'provider invoice', price_effective_at: null,
        }], rowCount: 1 }
        if (sql.includes('FROM subscriptions WHERE user_id')) return { rows: [], rowCount: 0 }
        if (sql.includes('SELECT balance_micros, reserved_micros FROM wallets')) return { rows: [{ balance_micros: '1000000000', reserved_micros: '0' }], rowCount: 1 }
        if (sql.includes('INSERT INTO billing_reservations')) {
          storedSnapshot = JSON.parse(String(values[6]))
          return { rows: [{ request_id: values[0], user_id: values[1], estimated_micros: values[3], plan_reserved_micros: values[4], wallet_reserved_micros: values[5], status: 'reserved' }], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      }),
    }
    const db = { tx: (action: (tx: any) => Promise<any>) => action(client) }
    const { BillingService } = await import('../src/services/billing.js')
    const billing = new BillingService(db as any)
    await expect(billing.reserve({
      userId: 'user-1', requestId: 'request-1', model: 'gpt-test', payload: { messages: [{ role: 'user', content: 'hello' }], max_tokens: 16 },
      requestPath: '/v1/chat/completions', requestMethod: 'POST', price,
    })).resolves.toMatchObject({ requestId: 'request-1', status: 'reserved' })
    expect(storedSnapshot.cashGuard).toMatchObject({
      nightDiscountActive: true, requestedDiscountBps: 2500, appliedDiscountBps: 500,
      baselineSafe: false, protectionApplied: true, protectionReason: 'baseline_below_minimum_margin',
    })
    expect(storedSnapshot.discountBps).toBe('500')
  })
})

describe('gpt-6-sol reservation guard', () => {
  test('rejects before touching wallets when a routed channel lacks Standard costs', async () => {
    const highTier = {
      thresholdTokens: 272001n,
      inputSellMicrosPerMillion: 2_000_000n,
      outputSellMicrosPerMillion: 3_000_000n,
      cacheSellMicrosPerMillion: 1_000_000n,
      cacheWriteSellMicrosPerMillion: 2_000_000n,
      inputCostMicrosPerMillion: 1_000_000n,
      outputCostMicrosPerMillion: 1_500_000n,
      cacheCostMicrosPerMillion: 500_000n,
      cacheWriteCostMicrosPerMillion: 1_000_000n,
    }
    const gpt6Price: PriceSnapshot = {
      ...price,
      modelPattern: 'gpt-6-sol',
      cacheWriteSellMicrosPerMillion: 1_000_000n,
      cacheWriteCostMicrosPerMillion: 500_000n,
      pricingTiers: [highTier],
    }
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT id, token_discount_bps FROM users')) return { rows: [{ id: 'user-1', token_discount_bps: 0 }], rowCount: 1 }
        if (sql.includes('SELECT * FROM billing_reservations')) return { rows: [], rowCount: 0 }
        if (sql.includes('SELECT key,value FROM app_settings')) return { rows: [
          { key: 'profit_min_margin_bps', value: '3000' }, { key: 'payment_fee_rate_bps', value: '0' },
          { key: 'affiliate_enabled', value: 'true' }, { key: 'affiliate_rate_bps', value: '1000' },
          { key: 'global_token_discount_bps', value: '0' }, { key: 'night_token_discount_enabled', value: 'false' },
          { key: 'night_token_discount_bps', value: '0' },
        ], rowCount: 7 }
        if (sql.includes('MAX(topup_multiplier_bps)')) return { rows: [{ multiplier: 50000 }], rowCount: 1 }
        if (sql.includes('SELECT id,model_map FROM channels')) return { rows: [{ id: 'channel-1', model_map: { 'gpt-6-sol': 'gpt-6-sol' } }], rowCount: 1 }
        if (sql.includes('SELECT * FROM channel_model_costs')) return { rows: [{
          channel_id: 'channel-1', model_pattern: 'gpt-6-sol', price_source: 'provider invoice',
          input_cost_micros_per_million: '1000000', output_cost_micros_per_million: '2000000', cache_cost_micros_per_million: '500000',
        }], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      }),
    }
    const billing = new (await import('../src/services/billing.js')).BillingService({ tx: (fn: any) => fn(client) } as any)
    await expect(billing.reserve({
      userId: 'user-1', requestId: 'sol-guard-1', model: 'gpt-6-sol', payload: { messages: [{ role: 'user', content: 'hello' }] },
      requestPath: '/v1/chat/completions', requestMethod: 'POST', price: gpt6Price,
    })).rejects.toMatchObject({ statusCode: 409 })
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO wallets'))).toBe(false)
  })

  test('rejects an unsafe gpt-6-sol baseline before touching wallets', async () => {
    const gpt6Price: PriceSnapshot = {
      ...price,
      modelPattern: 'gpt-6-sol',
      inputSellMicrosPerMillion: 1_000_000n,
      outputSellMicrosPerMillion: 2_000_000n,
      cacheSellMicrosPerMillion: 500_000n,
      cacheWriteSellMicrosPerMillion: 500_000n,
      inputCostMicrosPerMillion: 1_000_000n,
      outputCostMicrosPerMillion: 2_000_000n,
      cacheCostMicrosPerMillion: 500_000n,
      cacheWriteCostMicrosPerMillion: 500_000n,
      pricingTiers: [{
        thresholdTokens: 272001n,
        inputSellMicrosPerMillion: 2_000_000n,
        outputSellMicrosPerMillion: 3_000_000n,
        cacheSellMicrosPerMillion: 1_000_000n,
        cacheWriteSellMicrosPerMillion: 1_000_000n,
        inputCostMicrosPerMillion: 2_000_000n,
        outputCostMicrosPerMillion: 3_000_000n,
        cacheCostMicrosPerMillion: 1_000_000n,
        cacheWriteCostMicrosPerMillion: 1_000_000n,
      }],
    }
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT id, token_discount_bps FROM users')) return { rows: [{ id: 'user-1', token_discount_bps: 0 }], rowCount: 1 }
        if (sql.includes('SELECT * FROM billing_reservations')) return { rows: [], rowCount: 0 }
        if (sql.includes('SELECT key,value FROM app_settings')) return { rows: [
          { key: 'profit_min_margin_bps', value: '3000' }, { key: 'payment_fee_rate_bps', value: '0' },
          { key: 'affiliate_enabled', value: 'true' }, { key: 'affiliate_rate_bps', value: '1000' },
          { key: 'global_token_discount_bps', value: '0' }, { key: 'night_token_discount_enabled', value: 'false' },
          { key: 'night_token_discount_bps', value: '0' },
        ], rowCount: 7 }
        if (sql.includes('MAX(topup_multiplier_bps)')) return { rows: [{ multiplier: 50000 }], rowCount: 1 }
        if (sql.includes('SELECT id,model_map FROM channels')) return { rows: [{ id: 'channel-1', model_map: { 'gpt-6-sol': 'gpt-6-sol' } }], rowCount: 1 }
        if (sql.includes('SELECT * FROM channel_model_costs')) return { rows: [{
          channel_id: 'channel-1', model_pattern: 'gpt-6-sol', price_source: null,
          provider_tier_costs: { standard: {
            inputCostMicrosPerMillion: '1000000', outputCostMicrosPerMillion: '2000000',
            cacheReadCostMicrosPerMillion: '500000', cacheWriteCostMicrosPerMillion: '500000',
            highContextMultipliers: { input: 20000, output: 15000, cacheRead: 20000, cacheWrite: 20000 }, source: 'provider invoice',
          } },
        }], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      }),
    }
    const billing = new (await import('../src/services/billing.js')).BillingService({ tx: (fn: any) => fn(client) } as any)
    await expect(billing.reserve({
      userId: 'user-1', requestId: 'sol-unsafe-1', model: 'gpt-6-sol', payload: { messages: [{ role: 'user', content: 'hello' }] },
      requestPath: '/v1/chat/completions', requestMethod: 'POST', price: gpt6Price,
    })).rejects.toMatchObject({ statusCode: 409 })
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO wallets'))).toBe(false)
  })
})

function ceilToken(tokens: bigint, rate: bigint): bigint { return (tokens * rate + 999999n) / 1000000n }
