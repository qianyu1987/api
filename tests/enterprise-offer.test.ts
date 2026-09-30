import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import {
  buildApp,
  buildModelPriceComparison,
  normalizeEnterpriseLeadInput,
  shanghaiDayBounds,
  shanghaiNightDiscountWindow,
  shouldForwardRelayResponseHeader,
  type RelayApp,
} from '../src/server.js'

describe('enterprise price comparison', () => {
  test('preserves the relay billing request id instead of forwarding the upstream id', () => {
    expect(shouldForwardRelayResponseHeader('x-request-id')).toBe(false)
    expect(shouldForwardRelayResponseHeader('X-Request-ID')).toBe(false)
    expect(shouldForwardRelayResponseHeader('openai-request-id')).toBe(true)
  })

  test('uses the Beijing calendar day at the UTC boundary', () => {
    expect(shanghaiDayBounds(new Date('2026-09-27T15:59:59.999Z'))).toEqual({
      from: new Date('2026-09-26T16:00:00.000Z'),
      to: new Date('2026-09-27T16:00:00.000Z'),
    })
    expect(shanghaiDayBounds(new Date('2026-09-27T16:00:00.000Z'))).toEqual({
      from: new Date('2026-09-27T16:00:00.000Z'),
      to: new Date('2026-09-28T16:00:00.000Z'),
    })
  })

  test('uses a half-open Beijing midnight-to-04:00 night window', () => {
    expect(shanghaiNightDiscountWindow(new Date('2026-09-27T15:59:59.999Z')).active).toBe(false)
    expect(shanghaiNightDiscountWindow(new Date('2026-09-27T16:00:00.000Z'))).toMatchObject({
      active: true,
      startsAt: '2026-09-27T16:00:00.000Z',
      endsAt: '2026-09-27T20:00:00.000Z',
      nextTransitionAt: '2026-09-27T20:00:00.000Z',
    })
    expect(shanghaiNightDiscountWindow(new Date('2026-09-27T19:59:59.999Z')).active).toBe(true)
    expect(shanghaiNightDiscountWindow(new Date('2026-09-27T20:00:00.000Z'))).toMatchObject({
      active: false,
      startsAt: '2026-09-28T16:00:00.000Z',
      nextTransitionAt: '2026-09-28T16:00:00.000Z',
    })
  })

  test('applies the effective discount and rounds each display rate half-up', () => {
    const comparison = buildModelPriceComparison([{
      model_pattern: 'gpt-6-astra', active: true,
      input_sell_micros_per_million: '116600000',
      output_sell_micros_per_million: '583000000',
      cache_sell_micros_per_million: '11700000',
    }], 2500, 30000)
    expect(comparison).toMatchObject({
      unit: 'CNY_PER_MILLION_TOKENS', walletMultiplierBps: 30000,
      monthlyMultiplierBps: 40000, enterpriseMultiplierBps: 50000,
    })
    expect(comparison.models).toHaveLength(4)
    expect(comparison.models[0]).toMatchObject({
      id: 'gpt-6-astra', displayName: 'Astra', available: true,
      input: {
        standardMicros: '87450000', walletEffectiveMicros: '29150000',
        monthlyEffectiveMicros: '21862500', enterpriseEffectiveMicros: '17490000',
      },
    })
    expect(comparison.models[1]).toMatchObject({
      id: 'gpt-6-sol', displayName: 'Sol 6', available: false,
    })
    const rounded = buildModelPriceComparison([{
      model_pattern: 'gpt-5.6-terra', active: true,
      input_sell_micros_per_million: '2', output_sell_micros_per_million: '2', cache_sell_micros_per_million: '2',
    }], 0, 30000)
    expect(rounded.models[3].input.walletEffectiveMicros).toBe('1')
  })

  test('does not advertise active rows whose token prices are zero', () => {
    const comparison = buildModelPriceComparison([{
      model_pattern: 'gpt-5.6-terra', active: true,
      input_sell_micros_per_million: '1000000',
      output_sell_micros_per_million: '2000000',
      cache_sell_micros_per_million: '0',
    }], 0, 30000)
    expect(comparison.models[3]).toMatchObject({
      id: 'gpt-5.6-terra', available: false,
      cache: { standardMicros: null, walletEffectiveMicros: null, monthlyEffectiveMicros: null, enterpriseEffectiveMicros: null },
    })
  })
})

describe('enterprise lead validation', () => {
  test('requires contact fields and bounds optional text', () => {
    expect(normalizeEnterpriseLeadInput({ contactName: ' 张三 ', contactMethod: '13800000000', desiredSiteName: '', note: '需要独立域名' })).toEqual({
      contactName: '张三', contactMethod: '13800000000', desiredSiteName: null, note: '需要独立域名',
    })
    expect(() => normalizeEnterpriseLeadInput({ contactName: '', contactMethod: 'test@example.com' })).toThrow('请填写联系人')
    expect(() => normalizeEnterpriseLeadInput({ contactName: '张三', contactMethod: 'x'.repeat(161) })).toThrow('联系方式无效')
    expect(() => normalizeEnterpriseLeadInput({ contactName: '张三\u0000', contactMethod: 'test@example.com' })).toThrow('联系人无效')
  })
})

describe('enterprise API', () => {
  let services: RelayApp
  let role = 'user'
  let lead: any = null
  let headers: { cookie: string }

  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'test')
    services = await buildApp(loadConfig())
    role = 'user'
    lead = null
    vi.spyOn(services.billing, 'balance').mockResolvedValue({
      walletMicros: 0n, walletReservedMicros: 0n, planMicros: 0n, planBookMicros: 0n,
      planReservedMicros: 0n, planUsedMicros: 0n, planQuotaMicros: 0n,
      planGrantLimit: null, planGrantCount: 0, planExpiresAt: null, planNextResetAt: null,
      planLastResetAt: null, planStatus: 'none', isValid: false,
    })
    vi.spyOn(services.db, 'one').mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes('SELECT token_discount_bps FROM users')) return { token_discount_bps: 1000 } as any
      if (sql.includes("key='global_token_discount_bps'")) return { value: '2500' } as any
      if (sql.includes('total_topup_credit_micros')) return { total_topup_credit_micros: '0', total_topup_paid_micros: '0', total_paid_micros: '0' } as any
      if (sql.includes('FROM usage_logs')) return { requests: '7', charge_micros: '1234567' } as any
      if (sql.includes('FROM users WHERE id')) return {
        id: 'user-1', username: 'tester', email: 'tester@example.com', email_verified_at: new Date(),
        role, invite_code: 'INVITE1', created_at: new Date('2026-01-01T00:00:00Z'), status: 'active', disabled_at: null,
      } as any
      if (sql.includes('FROM enterprise_site_leads')) return lead
      if (sql.includes('INSERT INTO enterprise_site_leads')) {
        const now = new Date('2026-09-27T00:00:00Z')
        lead = {
          id: 'lead-1', user_id: values[0], contact_name: values[1], contact_method: values[2],
          desired_site_name: values[3], note: values[4], created_at: lead?.created_at || now, updated_at: now,
        }
        return lead
      }
      return null
    })
    vi.spyOn(services.db, 'query').mockImplementation(async (sql: string) => {
      if (sql.includes('FROM model_prices')) return [{
        model_pattern: 'gpt-6-astra', active: true,
        input_sell_micros_per_million: '116600000', output_sell_micros_per_million: '583000000', cache_sell_micros_per_million: '11700000',
      }] as any
      if (sql.includes('FROM enterprise_site_leads l')) return lead ? [{ ...lead, username: 'tester', email: 'tester@example.com' }] as any : []
      return []
    })
    await services.app.ready()
    headers = { cookie: `relay_session=${services.app.jwt.sign({ sub: 'user-1' })}` }
  })

  afterEach(async () => {
    await services.app.close()
    await services.db.close()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  test('returns overview usage, enterprise offer and the max personal/global discount', async () => {
    const response = await services.app.inject({ url: '/api/me/overview', headers })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      effectiveTokenDiscountBps: 2500,
      todayUsage: { timezone: 'Asia/Shanghai', requests: 7, chargeMicros: '1234567' },
      enterpriseOffer: { code: 'enterprise', multiplierBps: 50000, minimumAmountMicros: '498000000' },
      modelPriceComparison: { walletMultiplierBps: 30000, monthlyMultiplierBps: 40000, enterpriseMultiplierBps: 50000 },
      nightDiscount: {
        enabled: false, configuredDiscountBps: 0, active: false, appliedDiscountBps: 0,
        effectiveTokenDiscountBps: 2500, timezone: 'Asia/Shanghai', start: '00:00', end: '04:00',
      },
    })
  })

  test('validates and returns the dedicated audited night-discount admin contract', async () => {
    role = 'admin'
    const update = vi.spyOn(services.profit, 'updateNightDiscount').mockResolvedValue({
      nightDiscountEnabled: true,
      nightDiscountBps: 1500,
      globalDiscountBps: 500,
      maxDiscountBps: 2000,
      minimumMarginBps: 5000,
    } as any)
    const response = await services.app.inject({
      method: 'PATCH', url: '/api/admin/settings/night-discount', headers,
      payload: { enabled: true, discountBps: 1500 },
    })
    expect(response.statusCode).toBe(200)
    expect(update).toHaveBeenCalledWith({ enabled: true, discountBps: 1500 }, 'user-1')
    expect(response.json().nightDiscount).toMatchObject({ enabled: true, configuredDiscountBps: 1500, maxSafeDiscountBps: 2000 })

    const invalid = await services.app.inject({
      method: 'PATCH', url: '/api/admin/settings/night-discount', headers,
      payload: { enabled: 'true', discountBps: 1500 },
    })
    expect(invalid.statusCode).toBe(400)
    expect(update).toHaveBeenCalledTimes(1)
  })

  test('requires login, upserts the caller lead and isolates the admin list', async () => {
    expect((await services.app.inject({ url: '/api/me/enterprise-site-lead' })).statusCode).toBe(401)
    const created = await services.app.inject({
      method: 'POST', url: '/api/me/enterprise-site-lead', headers,
      payload: { contactName: '张三', contactMethod: '13800000000', desiredSiteName: '企业 AI', note: '<script>作为普通文本保存</script>' },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json().item).toMatchObject({ userId: 'user-1', contactName: '张三', desiredSiteName: '企业 AI' })
    expect(created.headers['content-type']).toContain('application/json')
    expect((await services.app.inject({ url: '/api/me/enterprise-site-lead', headers })).json().item.note).toBe('<script>作为普通文本保存</script>')

    expect((await services.app.inject({ url: '/api/admin/enterprise-leads', headers })).statusCode).toBe(403)
    role = 'admin'
    const admin = await services.app.inject({ url: '/api/admin/enterprise-leads', headers })
    expect(admin.statusCode).toBe(200)
    expect(admin.json().items[0]).toMatchObject({ username: 'tester', email: 'tester@example.com', contactMethod: '13800000000' })
  })

  test('rejects invalid lead input before writing', async () => {
    const response = await services.app.inject({ method: 'POST', url: '/api/me/enterprise-site-lead', headers, payload: { contactName: '张三' } })
    expect(response.statusCode).toBe(400)
    expect(lead).toBeNull()
  })
})
