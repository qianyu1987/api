import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { buildApp, type RelayApp } from '../src/server.js'
import { loadConfig } from '../src/config.js'
import { apiKeyScopedBalance, parseUpstreamUsage } from '../src/services/channels.js'

const id = 'ee222222-2222-4222-8222-222222222222'
let services: RelayApp
let row: any
let audits: any[]
let headers: { cookie: string }
let role: string

beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test')
  services = await buildApp(loadConfig())
  row = { id, name: '测试渠道', base_url: 'https://example.invalid/v1', model_map: { test: 'test' }, enabled: true, deleted_at: null }
  audits = []; role = 'admin'
  vi.spyOn(services.db, 'one').mockImplementation(async (sql: string) => sql.includes('FROM users')
    ? { id: 'actor', username: 'tester', status: 'active', role, created_at: new Date() } as any
    : row && !row.deleted_at ? row : null)
  vi.spyOn(services.db, 'query').mockImplementation(async (sql: string) => sql.includes('FROM channels') && !sql.includes('channel_model_costs')
    ? row && !row.deleted_at && (!sql.includes('enabled = true') || row.enabled) ? [row] : [] : [])
  vi.spyOn(services.db, 'tx').mockImplementation(async (fn: any) => fn({ query: async (sql: string, values: any[]) => {
    if (sql.startsWith('SELECT id,name')) return { rows: row ? [{ ...row }] : [] }
    if (sql.startsWith('UPDATE channels')) { row = { ...row, enabled: false, deleted_at: values[1] ? new Date().toISOString() : null }; return { rows: [{ ...row }] } }
    if (sql.includes('INSERT INTO config_audit_logs')) audits.push(values)
    return { rows: [] }
  } }))
  await services.app.ready()
  headers = { cookie: `relay_session=${services.app.jwt.sign({ sub: 'actor' })}` }
})
afterEach(async () => { await services.app.close(); await services.db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

const action = (archive = false, channelId = id) => services.app.inject({ method: 'DELETE', url: `/api/admin/channels/${channelId}${archive ? '/archive' : ''}`, headers })

describe('channel administration', () => {
  test('bodyless disable succeeds, excludes routing and keeps the channel editable', async () => {
    expect((await action()).statusCode).toBe(200)
    expect(row).toMatchObject({ enabled: false, deleted_at: null })
    expect(await services.channels.list()).toEqual([])
    expect(await services.channels.allForAdmin()).toHaveLength(1)
    expect((await action()).statusCode).toBe(200)
    expect(audits).toHaveLength(1)
  })
  test('delete hides the channel, records before/after and prevents stale edits from re-enabling it', async () => {
    expect((await action(true)).statusCode).toBe(200)
    expect(row.enabled).toBe(false); expect(row.deleted_at).toBeTruthy()
    expect(await services.channels.list()).toEqual([])
    expect(await services.channels.allForAdmin()).toEqual([])
    expect((await action(true)).statusCode).toBe(200)
    expect((await action()).statusCode).toBe(200)
    expect(audits).toHaveLength(1)
    expect(JSON.parse(audits[0][2])).toMatchObject({ enabled: true, deleted_at: null })
    expect(JSON.parse(audits[0][3])).toMatchObject({ enabled: false })
    expect(JSON.stringify(audits)).not.toMatch(/encrypted_api_key|apiKey/)
    const edit = await services.app.inject({ method: 'POST', url: '/api/admin/channels', headers, payload: { id, name: 'stale', baseUrl: 'https://example.invalid/v1', enabled: true } })
    expect(edit.statusCode).toBe(404)
  })
  test.each([false, true])('ordinary users cannot change channel availability (archive=%s)', async archive => {
    role = 'user'
    expect((await action(archive)).statusCode).toBe(403)
    headers = { cookie: '' }
    expect((await action(archive)).statusCode).toBe(401)
    expect(services.db.tx).not.toHaveBeenCalled()
  })
  test('rejects malformed and missing ids without writing an audit', async () => {
    expect((await action(true, 'invalid')).statusCode).toBe(400)
    row = null
    expect((await action(true)).statusCode).toBe(404)
    expect(audits).toEqual([])
  })
})

describe('upstream balance parsing', () => {
  test('reads a verified quota response without exposing unrelated usage details', () => {
    expect(parseUpstreamUsage({ unit: '元', remaining: 18.28375748, quota: { limit: 30, remaining: 18.28375748, used: 11.71624252 }, model_stats: { secret: true } })).toEqual({ status: 'available', remaining: 18.28375748, quota: 30, used: 11.71624252, unit: '元', message: null })
  })
  test.each([null, {}, { remaining: -1 }, { remaining: '18.2' }])('rejects invalid balance payload %j', payload => {
    expect(parseUpstreamUsage(payload)).toBeNull()
  })
  test('separates a negative API Key allocation from the provider account wallet', () => {
    expect(apiKeyScopedBalance({ available: -4.56, granted: 0, used: 4.56, unit: '¥', checkedAt: '2026-09-20T00:00:00.000Z' })).toMatchObject({
      remaining: 0,
      quota: 0,
      used: 4.56,
      scope: 'api_key',
      overdraft: 4.56,
    message: '该 API Key 已超额使用；上游账户钱包余额请以供应商后台为准',
    })
  })
})

describe('browser request headers regression', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  const apiSource = source.slice(source.indexOf('  async function api('), source.indexOf('  async function copyText('))
  test('bodyless admin actions reach Fastify without an empty-JSON parser error', async () => {
    const fetch = vi.fn(async (url: string, options: any) => {
      expect(options.headers.has('Content-Type')).toBe(false)
      const response = await services.app.inject({ method: options.method, url, headers: { ...Object.fromEntries(options.headers), ...headers } })
      return { ok: response.statusCode === 200, status: response.statusCode, json: async () => response.json() }
    })
    const api = runInNewContext(apiSource + ';api', { fetch, Headers, FormData })
    await expect(api(`/api/admin/channels/${id}`, { method: 'DELETE' })).resolves.toEqual({ ok: true })
    await expect(api(`/api/admin/channels/${id}/archive`, { method: 'DELETE' })).resolves.toEqual({ ok: true })
  })
  test('JSON bodies keep their media type and explicit header overrides survive', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    const api = runInNewContext(apiSource + ';api', { fetch, Headers, FormData })
    await api('/json', { method: 'POST', body: '{}', headers: { 'X-Test': 'yes' } })
    expect((fetch.mock.calls as any)[0][1].headers.get('Content-Type')).toBe('application/json')
    expect((fetch.mock.calls as any)[0][1].headers.get('X-Test')).toBe('yes')
    await api('/text', { method: 'POST', body: 'text', headers: { 'Content-Type': 'text/plain' } })
    expect((fetch.mock.calls as any)[1][1].headers.get('Content-Type')).toBe('text/plain')
    await api('/upload', { method: 'POST', body: new FormData() })
    expect((fetch.mock.calls as any)[2][1].headers.has('Content-Type')).toBe(false)
  })
})

describe('payment refresh regression', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')
  test('uses a short, non-overlapping customer payment poll', () => {
    expect(source).toContain('let paymentPollInFlight = false')
    expect(source).toContain('if (paymentPollInFlight) return')
    expect(source).toContain('}, 3000)')
  })
  test('queries a pending WeChat order behind a distributed throttle', () => {
    expect(server).toContain('payment-order-query:${id}')
    expect(server).toContain("gateway.queryNativeOrder(String(row.order_no), 'wechat')")
  })
})

describe('public homepage', () => {
  test.each(['/healthz', '/api/v1/health'])('serves the public health check at %s', async url => {
    const response = await services.app.inject({ url })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true, service: 'relay-station' })
  })
  test.each(['/', '/login', '/register'])('serves the public entry at %s', async url => {
    const response = await services.app.inject({ url })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('id="landing-view"')
    expect(response.body).toContain('id="auth-form"')
  })
  test('public settings expose only brand and public connection/offer fields', async () => {
    vi.mocked(services.db.query).mockResolvedValue([{ key: 'site_name', value: 'Test brand' }, { key: 'channel_api_key', value: 'must-not-leak' }] as any)
    const response = await services.app.inject({ url: '/api/public/site' })
    expect(response.statusCode).toBe(200)
    const data = response.json()
    expect(Object.keys(data).sort()).toEqual(['name','title','logoUrl','apiBaseUrl','walletTopupMultiplierBps'].sort())
    expect(data.apiBaseUrl).toBe(services.config.publicBaseUrl.replace(/\/$/, '') + '/v1')
    expect(data.walletTopupMultiplierBps).toBe(services.config.walletTopupMultiplierBps)
    expect(response.body).not.toContain('must-not-leak')
  })
})

describe('media access control',()=>{
 test('anonymous users cannot list or quote media and ordinary users cannot configure costs',async()=>{
  expect((await services.app.inject({url:'/api/me/media/tasks'})).statusCode).toBe(401)
  expect((await services.app.inject({method:'POST',url:'/api/me/media/quote',payload:{kind:'image',prompt:'test'}})).statusCode).toBe(401)
  role='user'
  expect((await services.app.inject({url:'/api/admin/media',headers})).statusCode).toBe(403)
  expect((await services.app.inject({method:'POST',url:'/api/admin/media/prices',headers,payload:{}})).statusCode).toBe(403)
 })
})
