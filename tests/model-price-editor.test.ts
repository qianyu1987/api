import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { buildApp, type RelayApp } from '../src/server.js'
import { loadConfig } from '../src/config.js'
import { ProfitService } from '../src/services/profit.js'

let services: RelayApp
let headers: { cookie: string }
let role: string
let writes: any[][]
let audits: any[][]
const payload = {
  modelPattern: 'gpt-5.6-sol', active: true,
  inputCostYuanPerMillion: '3', outputCostYuanPerMillion: '20', cacheCostYuanPerMillion: '0.576',
  inputSellYuanPerMillion: '30', outputSellYuanPerMillion: '200', cacheSellYuanPerMillion: '5.76',
}

beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test')
  services = await buildApp(loadConfig())
  role = 'admin'; writes = []; audits = []
  vi.spyOn(services.db, 'one').mockImplementation(async () => ({ id: 'actor', username: 'tester', status: 'active', role, created_at: new Date() }) as any)
  vi.spyOn(ProfitService.prototype, 'overview').mockResolvedValue({ minimumMarginBps: 1500, paymentFeeRateBps: 0, affiliateRateBps: 1000, walletTopupMultiplierBps: 50000 } as any)
  vi.spyOn(services.db, 'tx').mockImplementation(async (fn: any) => fn({ query: async (sql: string, values: any[]) => {
    if (sql.startsWith('SELECT * FROM model_prices')) return { rows: [{ id: 'price', model_pattern: payload.modelPattern, price_source: '历史导入报价' }] }
    if (sql.startsWith('INSERT INTO model_prices')) {
      writes.push(values)
      return { rows: [{ id: 'price', model_pattern: values[0], price_source: values[10], input_sell_micros_per_million: values[4] }] }
    }
    if (sql.includes('INSERT INTO config_audit_logs')) audits.push(values)
    return { rows: [] }
  } }))
  await services.app.ready()
  headers = { cookie: `relay_session=${services.app.jwt.sign({ sub: 'actor' })}` }
})

afterEach(async () => {
  await services.app.close(); await services.db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs()
})

const save = (patch: Record<string, unknown> = {}) => services.app.inject({ method: 'POST', url: '/api/admin/prices', headers, payload: { ...payload, ...patch } })

describe('manual model price source', () => {
  test.each([undefined, '', '   ', null])('accepts old forms with source %j and audits manual provenance', async priceSource => {
    const response = await save({ priceSource })
    expect(response.statusCode).toBe(200)
    expect(response.json().price_source).toBe('管理员手动定价')
    expect(writes[0].slice(0, 7)).toEqual(['gpt-5.6-sol', '3000000', '20000000', '576000', '30000000', '200000000', '5760000'])
    expect(audits).toHaveLength(1)
    expect(JSON.parse(audits[0][2]).price_source).toBe('历史导入报价')
    expect(JSON.parse(audits[0][3]).price_source).toBe('管理员手动定价')
  })
  test('saves an explicit source after trimming, including the 512 character boundary', async () => {
    expect((await save({ priceSource: '  自定义报价 2026-10-14  ' })).json().price_source).toBe('自定义报价 2026-10-14')
    const response = await save({ priceSource: '价'.repeat(512) })
    expect(response.statusCode).toBe(200)
    expect(response.json().price_source).toHaveLength(512)
  })
  test.each(['价'.repeat(513), { source: 'invalid' }, ['invalid']])('rejects invalid source before any write', async priceSource => {
    const response = await save({ priceSource })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toContain('价格来源')
    expect(writes).toEqual([]); expect(audits).toEqual([])
  })
  test('keeps the minimum margin check and preserves the record when it fails', async () => {
    const response = await save({ inputSellYuanPerMillion: '15', outputSellYuanPerMillion: '100', cacheSellYuanPerMillion: '2.88' })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toContain('最低现金毛利 15%')
    expect(writes).toEqual([]); expect(audits).toEqual([])
  })
  test('retains administrator-only access', async () => {
    role = 'user'
    expect((await save()).statusCode).toBe(403)
    headers = { cookie: '' }
    expect((await save()).statusCode).toBe(401)
    expect(writes).toEqual([]); expect(audits).toEqual([])
  })
})
