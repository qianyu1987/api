import { describe, expect, test, vi } from 'vitest'
import { ChannelCostService } from '../src/services/channel-costs.js'

const input = { channelId: '2011e151-049f-47c8-b8ed-6e8be11900d1', modelPattern: 'gpt-5.6-sol', inputCostYuanPerMillion: '0.125001', outputCostYuanPerMillion: '1.5', cacheCostYuanPerMillion: '0', priceSource: '供应商账单 2026-09-11', highContextMultiplierBps: 12000, expectedUpdatedAt: null }

describe('channel cost editing', () => {
  test.each([
    { inputCostYuanPerMillion: undefined }, { outputCostYuanPerMillion: '' }, { cacheCostYuanPerMillion: null },
    { inputCostYuanPerMillion: '-1' }, { inputCostYuanPerMillion: '0.0000001' },
    { inputCostYuanPerMillion: '99999999999999999' }, { priceSource: ' ' }, { channelId: 'invalid' },
    { highContextMultiplierBps: 9999 }, { highContextMultiplierBps: 12000.5 },
    { priceEffectiveAt: 'invalid' }, { priceEffectiveAt: '2999-01-01' },
  ])('rejects invalid or incomplete costs before writing: %j', async patch => {
    const db = { tx: vi.fn() }
    await expect(new ChannelCostService(db as any).save({ ...input, ...patch }, 'actor')).rejects.toThrow()
    expect(db.tx).not.toHaveBeenCalled()
  })
  const setup = (before: any = null, modelMap = { 'gpt-5.6-sol': 'agnes-3.0-flash' }) => {
    const query = vi.fn(async (sql: string, values: any[]) => {
      if (sql.startsWith('SELECT id,name')) return { rows: [{ id: input.channelId, model_map: modelMap }] }
      if (sql.startsWith('SELECT * FROM channel_model_costs')) return { rows: before ? [before] : [] }
      if (sql.startsWith('INSERT INTO channel_model_costs')) return { rows: [{ channel_id: values[0], model_pattern: values[1], input_cost_micros_per_million: values[2], output_cost_micros_per_million: values[3], cache_cost_micros_per_million: values[4], price_source: values[5], high_context_multiplier_bps: values[6] }] }
      return { rows: [] }
    })
    return { query, service: new ChannelCostService({ tx: (fn: any) => fn({ query }) } as any) }
  }
  test('saves exact CNY values, explicit free cache and the configured tier with a single audit', async () => {
    const { query, service } = setup()
    const after = await service.save(input, 'actor')
    expect(after).toMatchObject({ input_cost_micros_per_million: '125001', output_cost_micros_per_million: '1500000', cache_cost_micros_per_million: '0', high_context_multiplier_bps: 12000 })
    const audit = query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO config_audit_logs'))
    expect(audit).toHaveLength(1)
    expect(audit[0][1]).toEqual(['actor', input.channelId + ':' + input.modelPattern, null, JSON.stringify(after)])
  })
  test('rejects a stale administrator edit without overwriting the cost or audit', async () => {
    const { query, service } = setup({ updated_at: '2026-09-11T02:00:00Z' })
    await expect(service.save(input, 'actor')).rejects.toMatchObject({ statusCode: 409 })
    expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false)
  })
  test('requires the public model mapping', async () => {
    const { query, service } = setup()
    await expect(service.save({ ...input, modelPattern: 'agnes-3.0-flash' }, 'actor')).rejects.toThrow('公开模型名')
    expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false)
  })
  test('records the before value together with the new cost', async () => {
    const before = { updated_at: '2026-09-11T02:00:00Z', input_cost_micros_per_million: '500000' }
    const { query, service } = setup(before)
    await service.save({ ...input, expectedUpdatedAt: before.updated_at }, 'actor')
    const audit = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO config_audit_logs'))!
    expect(JSON.parse(audit[1][2])).toEqual(before)
  })
})
