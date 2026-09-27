import { describe, expect, test, vi } from 'vitest'
import {
  assertDiscount,
  buildDiscountGuardrail,
  discountLimit,
  effectiveDiscountBps,
  isShanghaiNightDiscountActive,
  ProfitService,
  profitRules,
  shanghaiNightDiscountWindow,
} from '../src/services/profit.js'

const modelPrice = {
  model_pattern: 'gpt-test', active: true,
  input_cost_micros_per_million: '50000', input_sell_micros_per_million: '2000000',
  output_cost_micros_per_million: '50000', output_sell_micros_per_million: '2000000',
  cache_cost_micros_per_million: '50000', cache_sell_micros_per_million: '2000000',
}

describe('Shanghai night discount window', () => {
  test('uses the fixed 00:00 inclusive to 04:00 exclusive Beijing window', () => {
    const before = shanghaiNightDiscountWindow('2026-09-27T15:59:59.999Z')
    expect(before).toMatchObject({ active: false, startsAt: '2026-09-27T16:00:00.000Z', endsAt: '2026-09-27T20:00:00.000Z', nextTransitionAt: '2026-09-27T16:00:00.000Z' })

    const start = shanghaiNightDiscountWindow('2026-09-27T16:00:00.000Z')
    expect(start).toMatchObject({ timezone: 'Asia/Shanghai', startHour: 0, endHour: 4, active: true, startsAt: '2026-09-27T16:00:00.000Z', endsAt: '2026-09-27T20:00:00.000Z', nextTransitionAt: '2026-09-27T20:00:00.000Z' })
    expect(isShanghaiNightDiscountActive('2026-09-27T19:59:59.999Z')).toBe(true)

    const end = shanghaiNightDiscountWindow('2026-09-27T20:00:00.000Z')
    expect(end).toMatchObject({ active: false, startsAt: '2026-09-28T16:00:00.000Z', endsAt: '2026-09-28T20:00:00.000Z', nextTransitionAt: '2026-09-28T16:00:00.000Z' })
  })
})

describe('global profit discount guardrail', () => {
  const rules = profitRules({ profit_min_margin_bps: '3000', payment_fee_rate_bps: '0', affiliate_rate_bps: '1000', affiliate_enabled: 'true', global_token_discount_bps: '0' })

  test('takes the strictest personal/global/night discount and defaults to the 1:5 offer', () => {
    expect(effectiveDiscountBps(9000, 0)).toBe(9000)
    expect(effectiveDiscountBps(1000, 2500, 3000)).toBe(3000)
    expect(rules.walletTopupMultiplierBps).toBe(50000)
    expect(profitRules({}, 30000).walletTopupMultiplierBps).toBe(50000)
    expect(profitRules({}, 60000).walletTopupMultiplierBps).toBe(60000)
    const limit = discountLimit([{ model_pattern: 'healthy', active: true, input_cost_micros_per_million: '100000', input_sell_micros_per_million: '1000000', output_cost_micros_per_million: '100000', output_sell_micros_per_million: '1000000', cache_cost_micros_per_million: '100000', cache_sell_micros_per_million: '1000000' }], rules)
    expect(limit.maxDiscountBps).toBe(1666)
  })

  test('a loss making model forces the safe global discount to zero', () => {
    const rows = [{ model_pattern: 'gpt-5.5', active: true, input_cost_micros_per_million: '28800000', input_sell_micros_per_million: '14400000', output_cost_micros_per_million: '144000000', output_sell_micros_per_million: '72000000', cache_cost_micros_per_million: '2880000', cache_sell_micros_per_million: '1440000' }]
    const limit = discountLimit(rows, rules)
    expect(limit.maxDiscountBps).toBe(0)
    expect(limit.blockers.some((item) => item.model === 'gpt-5.5')).toBe(true)
    expect(() => assertDiscount(rows, rules, 1)).toThrow('最多允许 0%')
  })

  test('checks the 272K pricing tier as well', () => {
    const limit = discountLimit([{ model_pattern: 'tiered', active: true, input_cost_micros_per_million: '100000', input_sell_micros_per_million: '1000000', output_cost_micros_per_million: '100000', output_sell_micros_per_million: '1000000', cache_cost_micros_per_million: '100000', cache_sell_micros_per_million: '1000000', pricing_tiers: [{ thresholdTokens: '272001', label: '272K+', inputCostMicrosPerMillion: '900000', inputSellMicrosPerMillion: '1000000', outputCostMicrosPerMillion: '100000', outputSellMicrosPerMillion: '1000000', cacheCostMicrosPerMillion: '100000', cacheSellMicrosPerMillion: '1000000' }] }], rules)
    expect(limit.maxDiscountBps).toBe(0)
  })

  test('does not let an explicitly free cost and sell component lock the guardrail', () => {
    const limit = discountLimit([{
      model_pattern: 'free-cache', active: true,
      input_cost_micros_per_million: '100', input_sell_micros_per_million: '1000',
      output_cost_micros_per_million: '100', output_sell_micros_per_million: '1000',
      cache_cost_micros_per_million: '0', cache_sell_micros_per_million: '0',
    }], rules)
    expect(limit.maxDiscountBps).toBe(1660)
    expect(limit.constraints.find((item) => item.part === 'cache')).toMatchObject({ maxDiscountBps: 9900, reason: null })
    expect(limit.blockers).toEqual([])
  })

  test('uses the highest 272K+ cost across every enabled channel mapping', () => {
    const guardrail = buildDiscountGuardrail({
      rules,
      prices: [modelPrice],
      channels: [
        { id: 'low', name: '低成本', enabled: true, deleted_at: null, model_map: { 'gpt-test': 'upstream-low' } },
        { id: 'high', name: '高上下文', enabled: true, deleted_at: null, model_map: { 'gpt-test': 'upstream-high' } },
      ],
      costs: [
        { channel_id: 'low', model_pattern: 'gpt-test', input_cost_micros_per_million: '100000', output_cost_micros_per_million: '100000', cache_cost_micros_per_million: '100000', high_context_multiplier_bps: 10000, price_source: '账单 A' },
        { channel_id: 'high', model_pattern: 'gpt-test', input_cost_micros_per_million: '100000', output_cost_micros_per_million: '100000', cache_cost_micros_per_million: '100000', high_context_multiplier_bps: 20000, price_source: '账单 B' },
      ],
    })
    expect(guardrail.channelCostBlockers).toEqual([])
    expect(guardrail.maxDiscountBps).toBe(1666)
    expect(guardrail.constraints.every((item) => item.requiredSellMicros === '1666667')).toBe(true)
  })

  test('diagnoses active prices without a runtime route without locking sellable models', () => {
    const guardrail = buildDiscountGuardrail({
      rules,
      prices: [
        modelPrice,
        { ...modelPrice, model_pattern: 'legacy-no-route', input_cost_micros_per_million: '999999999' },
      ],
      channels: [{ id: 'only', name: '真实路由', enabled: true, deleted_at: null, model_map: { 'gpt-test': 'upstream' } }],
      costs: [{ channel_id: 'only', model_pattern: 'gpt-test', input_cost_micros_per_million: '100000', output_cost_micros_per_million: '100000', cache_cost_micros_per_million: '100000', high_context_multiplier_bps: 10000, price_source: '账单' }],
    })
    expect(guardrail.maxDiscountBps).toBe(5833)
    expect(guardrail.channelCostBlockers).toEqual([])
    expect(guardrail.routeDiagnostics).toMatchObject([{ kind: 'no_route', model: 'legacy-no-route' }])
  })

  test('treats missing enabled-channel costs as a zero safe discount', () => {
    const guardrail = buildDiscountGuardrail({
      rules,
      prices: [modelPrice],
      channels: [{ id: 'missing', name: '缺成本', enabled: true, deleted_at: null, model_map: { 'gpt-test': 'upstream' } }],
      costs: [],
    })
    expect(guardrail.maxDiscountBps).toBe(0)
    expect(guardrail.channelCostBlockers).toMatchObject([{ kind: 'cost_missing', model: 'gpt-test', channelName: '缺成本' }])
  })
})

function fakeProfitDatabase(costs: any[] = [], users: any[] = [{ token_discount_bps: 0 }]) {
  const settings = new Map<string, string>([
    ['profit_min_margin_bps', '3000'], ['payment_fee_rate_bps', '0'], ['affiliate_rate_bps', '1000'],
    ['affiliate_enabled', 'true'], ['global_token_discount_bps', '0'],
    ['night_token_discount_enabled', 'true'], ['night_token_discount_bps', '1000'],
  ])
  const channels = [{ id: 'missing', name: '缺成本', enabled: true, deleted_at: null, model_map: { 'gpt-test': 'upstream' }, requested_model: null }]
  const run = async (sql: string, values: unknown[] = []): Promise<any[]> => {
    if (sql.startsWith('LOCK TABLE')) return []
    if (sql.includes('SELECT key,value FROM app_settings')) return [...settings].map(([key, value]) => ({ key, value }))
    if (sql.includes('FROM model_prices')) return [modelPrice]
    if (sql.includes('FROM channels')) return channels
    if (sql.includes('FROM channel_model_costs')) return costs
    if (sql.includes('SELECT token_discount_bps FROM users')) return users
    if (sql.includes('MAX(topup_multiplier_bps)')) return [{ multiplier: 0 }]
    if (sql.includes('INSERT INTO app_settings')) {
      settings.set(String(values[0]), String(values[2]))
      return []
    }
    if (sql.includes('INSERT INTO config_audit_logs')) return []
    throw new Error(`unexpected SQL: ${sql}`)
  }
  const client = { query: vi.fn(async (sql: string, values?: unknown[]) => ({ rows: await run(sql, values) })) }
  const db = {
    query: vi.fn(run),
    tx: vi.fn(async (action: (client: any) => Promise<any>) => action(client)),
  }
  return { db, settings, client }
}

describe('night discount settings update', () => {
  test('rejects profit, fee and rebate settings that leave no retained cash', async () => {
    const { db } = fakeProfitDatabase([{
      channel_id: 'missing', model_pattern: 'gpt-test',
      input_cost_micros_per_million: '100000', output_cost_micros_per_million: '100000', cache_cost_micros_per_million: '100000',
      high_context_multiplier_bps: 10000, price_source: '账单',
    }])
    const service = new ProfitService(db as any, 30000)
    await expect(service.update({ minimumMarginBps: 9000 }, 'actor')).rejects.toMatchObject({ statusCode: 400 })
  })

  test('blocks enabling against missing route costs but always permits disabling', async () => {
    const { db, settings, client } = fakeProfitDatabase()
    const service = new ProfitService(db as any, 30000)
    await expect(service.updateNightDiscount({ enabled: true, discountBps: 500 }, 'actor')).rejects.toMatchObject({ statusCode: 409 })

    const result = await service.updateNightDiscount({ enabled: false, discountBps: 1000 }, 'actor')
    expect(settings.get('night_token_discount_enabled')).toBe('false')
    expect(result).toMatchObject({ nightDiscountEnabled: false, nightDiscountBps: 1000, maxDiscountBps: 0 })
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("'profit_settings','night_discount'"))).toBe(true)
  })

  test('reports legacy personal risk without blocking a safe campaign setting', async () => {
    const { db } = fakeProfitDatabase([{
      channel_id: 'missing', model_pattern: 'gpt-test',
      input_cost_micros_per_million: '100000', output_cost_micros_per_million: '100000', cache_cost_micros_per_million: '100000',
      high_context_multiplier_bps: 10000, price_source: '账单',
    }], [{ token_discount_bps: 9000 }])
    const service = new ProfitService(db as any, 30000)
    const validated = await service.validateUpdate({ globalDiscountBps: 1000 })
    expect(validated).toMatchObject({
      campaignConfiguredDiscountBps: 1000,
      configuredMaximumDiscountBps: 9000,
      personalDiscountRiskCount: 1,
      configuredDiscountRiskCount: 0,
    })
    await expect(service.validateDiscount(9000)).rejects.toMatchObject({ statusCode: 400 })
  })
})
