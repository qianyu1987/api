import { describe, expect, test, vi } from 'vitest'
import { deriveVideoKeyCost, fixedVideoPriceMicros, maskProviderKey, rankVideoCandidates, usageDayForTimezone, VIDEO_UNIT_PRICE_MICROS, VideoKeyService } from '../src/services/video-keys.js'

type UsageBucket = { used_seconds: number; reserved_seconds: number; released_seconds: number; limit_seconds: number }

function reconciliationFixture(input: {
  bucket?: UsageBucket | null
  tasks?: Array<{ keyId: string; day: string; used: number; status?: string }>
  timezone?: string
} = {}) {
  let bucket = input.bucket === null ? null : { used_seconds: 0, reserved_seconds: 0, released_seconds: 0, limit_seconds: 500, ...input.bucket }
  const tasks = structuredClone(input.tasks || [])
  const calls: Array<{ sql: string; params: any[] }> = []
  const audits: Array<{ before: any; after: any; actor: any; resource: string }> = []
  const timezone = input.timezone || 'Asia/Shanghai'
  const client = { query: async (sql: string, params: any[] = []) => {
    calls.push({ sql, params })
    if (sql.startsWith('SELECT * FROM video_provider_keys')) {
      return { rows: [{ id: 'key', timezone, daily_limit_seconds: 500 }] }
    }
    if (sql.startsWith('INSERT INTO video_key_usage_daily')) {
      bucket ??= { used_seconds: 0, reserved_seconds: 0, released_seconds: 0, limit_seconds: Number(params[2]) }
      return { rows: [] }
    }
    if (sql.startsWith('SELECT * FROM video_key_usage_daily')) return { rows: bucket ? [{ ...bucket }] : [] }
    if (sql.startsWith('SELECT id,status,quota_seconds_reserved')) {
      return { rows: tasks.filter(task => task.keyId === params[0] && ['queued', 'submitting', 'processing', 'unknown'].includes(task.status || '')) }
    }
    if (sql.includes('sum(quota_seconds_used)')) {
      const used = tasks.filter(task => task.keyId === params[0] && task.day === params[1]).reduce((sum, task) => sum + task.used, 0)
      return { rows: [{ used_seconds: String(used) }] }
    }
    if (sql.startsWith('UPDATE video_key_usage_daily')) {
      if (!bucket) throw new Error('missing bucket')
      bucket.used_seconds = Math.max(bucket.used_seconds, Number(params[2]))
      return { rows: [] }
    }
    if (sql.startsWith('INSERT INTO config_audit_logs')) {
      audits.push({ actor: params[0], resource: params[1], before: JSON.parse(params[2]), after: JSON.parse(params[3]) })
      return { rows: [] }
    }
    throw new Error('unexpected fixture query')
  } }
  const db: any = { tx: async (fn: any) => fn(client) }
  return { service: new VideoKeyService(db, {} as any), calls, audits, tasks, bucket: () => bucket }
}

describe('Agnes video key pool helpers', () => {
  test('uses the Asia/Shanghai calendar day instead of UTC near midnight', () => {
    const instant = new Date('2026-01-01T16:30:00.000Z')
    expect(usageDayForTimezone('Asia/Shanghai', instant)).toBe('2026-01-02')
  })

  test('masks provider credentials and never returns the full key', () => {
    expect(maskProviderKey('sk-agnes-secret-1234')).toBe('***1234')
    expect(maskProviderKey('abcd')).toBe('***abcd')
    expect(maskProviderKey(null)).toBeNull()
  })

  test('charges a fixed 35000 micros per generated second', () => {
    expect(VIDEO_UNIT_PRICE_MICROS).toBe(35000)
    expect(fixedVideoPriceMicros(4)).toBe(140000n)
    expect(fixedVideoPriceMicros(10)).toBe(350000n)
    expect(fixedVideoPriceMicros(12)).toBe(420000n)
  })

  test('prefers verified per-second cost and amortizes subscription cost across 500 seconds/day', () => {
    expect(deriveVideoKeyCost([
      { actual_cost_per_second_micros: '1200', subscription_cost_micros: '999999', subscription_duration_days: 30 },
      { actual_cost_per_second_micros: null, subscription_cost_micros: '15000000', subscription_duration_days: 30 },
    ])).toEqual({ micros: 1200n, source: 'mixed_key_costs' })
    expect(deriveVideoKeyCost([
      { actual_cost_per_second_micros: null, subscription_cost_micros: '1000001', subscription_duration_days: 30 },
    ])).toEqual({ micros: 67n, source: 'subscription_cost_per_second_micros' })
    expect(deriveVideoKeyCost([{ actual_cost_per_second_micros: null, subscription_cost_micros: null, subscription_duration_days: null }])).toEqual({ micros: null, source: null })
  })

  test('ranks idle, fast and high-priority keys deterministically', () => {
    const rows = rankVideoCandidates([
      { id: 'z', activeCount: 1, latencyP95Ms: 100, priority: 1 },
      { id: 'a', activeCount: 0, latencyP95Ms: 250, priority: 99 },
      { id: 'b', activeCount: 0, latencyP95Ms: 100, priority: 1 },
      { id: 'c', activeCount: 0, latencyP95Ms: 100, priority: 1 },
    ])
    expect(rows.map((row) => row.id)).toEqual(['b', 'c', 'a', 'z'])
  })

  test('uses EWMA latency first and success rate as a stable tie breaker', () => {
    const rows = rankVideoCandidates([
      { id: 'low-success', activeCount: 0, latencyEwmaMs: 100, latencyP95Ms: 100, successCount: 1, failureCount: 9, priority: 1 },
      { id: 'high-success', activeCount: 0, latencyEwmaMs: 100, latencyP95Ms: 100, successCount: 9, failureCount: 1, priority: 99 },
      { id: 'fast-ewma', activeCount: 0, latencyEwmaMs: 50, latencyP95Ms: 500, successCount: 0, failureCount: 1, priority: 99 },
    ])
    expect(rows.map((row) => row.id)).toEqual(['fast-ewma', 'high-success', 'low-success'])
  })

  test('refuses to reset a key with reserved seconds', async () => {
    const clientQuery = async (sql: string) => {
      if (sql.startsWith('SELECT * FROM video_provider_keys')) return { rows: [{ id: 'key', timezone: 'Asia/Shanghai', daily_limit_seconds: 500 }] }
      if (sql.startsWith('SELECT * FROM video_key_usage_daily')) return { rows: [{ reserved_seconds: 4, used_seconds: 0 }] }
      if (sql.includes('FROM media_tasks')) return { rows: [] }
      if (sql.startsWith('INSERT INTO video_key_usage_daily')) return { rows: [] }
      throw new Error(`unexpected query: ${sql}`)
    }
    const db: any = { tx: async (fn: any) => fn({ query: clientQuery }) }
    await expect(new VideoKeyService(db, {} as any).resetUsage('key', '保留任务不能重置')).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('不能重置') })
  })

  test('refuses to erase accepted usage even after every task finishes', async () => {
    const statements: string[] = []
    const clientQuery = async (sql: string) => {
      statements.push(sql)
      if (sql.startsWith('SELECT * FROM video_provider_keys')) return { rows: [{ id: 'key', timezone: 'Asia/Shanghai', daily_limit_seconds: 500 }] }
      if (sql.startsWith('SELECT * FROM video_key_usage_daily')) return { rows: [{ reserved_seconds: 0, used_seconds: 4, released_seconds: 12 }] }
      if (sql.includes('FROM media_tasks')) return { rows: [] }
      return { rows: [] }
    }
    const db: any = { tx: async (fn: any) => fn({ query: clientQuery }) }
    await expect(new VideoKeyService(db, {} as any).resetUsage('key', '按管理员要求刷新额度')).rejects.toMatchObject({
      statusCode: 409, message: '不能重置已接单用量；请核对本站用量，上游额度不会被重置',
    })
    expect(statements.some((sql) => sql.includes('used_seconds=0'))).toBe(false)
  })

  test('refuses to reset while a task can still settle or release quota', async () => {
    const clientQuery = async (sql: string) => {
      if (sql.startsWith('SELECT * FROM video_provider_keys')) return { rows: [{ id: 'key', timezone: 'Asia/Shanghai', daily_limit_seconds: 500 }] }
      if (sql.startsWith('SELECT * FROM video_key_usage_daily')) return { rows: [{ reserved_seconds: 0, used_seconds: 0, released_seconds: 0 }] }
      if (sql.includes('FROM media_tasks')) return { rows: [{ id: 'task', status: 'processing', quota_seconds_reserved: 0 }] }
      if (sql.startsWith('INSERT INTO video_key_usage_daily')) return { rows: [] }
      throw new Error(`unexpected query: ${sql}`)
    }
    const db: any = { tx: async (fn: any) => fn({ query: clientQuery }) }
    await expect(new VideoKeyService(db, {} as any).resetUsage('key', '生成任务仍在处理中')).rejects.toMatchObject({ statusCode: 409 })
  })

  test('restores accepted seconds after an accidental reset, including failed upstream jobs', async () => {
    const day = usageDayForTimezone('Asia/Shanghai')
    const fixture = reconciliationFixture({
      bucket: { used_seconds: 0, reserved_seconds: 6, released_seconds: 12, limit_seconds: 500 },
      tasks: [{ keyId: 'key', day, used: 4, status: 'failed' }],
    })
    const originalTasks = structuredClone(fixture.tasks)
    const result = await fixture.service.reconcileUsage('key', 'admin')
    expect(result).toMatchObject({ usageDay: day, usedSeconds: 4, reservedSeconds: 6, releasedSeconds: 12, remainingSeconds: 490, limitSeconds: 500, knownAcceptedSeconds: 4, corrected: true })
    expect(fixture.bucket()).toEqual({ used_seconds: 4, reserved_seconds: 6, released_seconds: 12, limit_seconds: 500 })
    expect(fixture.tasks).toEqual(originalTasks)
    expect(fixture.audits).toHaveLength(1)
    expect(fixture.audits[0]).toMatchObject({ actor: 'admin', resource: 'key', before: { usedSeconds: 0 }, after: { usedSeconds: 4, reservedSeconds: 6, releasedSeconds: 12 } })
    expect(fixture.calls.some(call => call.sql.includes("'video_provider_key_usage_reconcile'"))).toBe(true)
    expect(JSON.stringify(fixture.audits)).not.toMatch(/encrypted_api_key|apiKey|channelEncryptionKey|request_payload|prompt|upstream_task_id/)
  })

  test('cannot reset known accepted tasks even when their local bucket was already erased', async () => {
    const fixture = reconciliationFixture({ tasks: [{ keyId: 'key', day: usageDayForTimezone('Asia/Shanghai'), used: 4, status: 'failed' }] })
    await expect(fixture.service.resetUsage('key', '错误清零后再次操作')).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('不能重置已接单用量') })
    expect(fixture.audits).toHaveLength(0)
    expect(fixture.calls.some(call => call.sql.startsWith('UPDATE video_key_usage_daily'))).toBe(false)
  })

  test('reconciliation is idempotent and never decreases existing used seconds', async () => {
    const day = usageDayForTimezone('Asia/Shanghai')
    const restored = reconciliationFixture({ tasks: [{ keyId: 'key', day, used: 4 }] })
    expect((await restored.service.reconcileUsage('key')).corrected).toBe(true)
    expect((await restored.service.reconcileUsage('key')).corrected).toBe(false)
    expect(restored.bucket()?.used_seconds).toBe(4)
    const higher = reconciliationFixture({
      bucket: { used_seconds: 10, reserved_seconds: 0, released_seconds: 0, limit_seconds: 500 },
      tasks: [{ keyId: 'key', day, used: 4 }],
    })
    expect(await higher.service.reconcileUsage('key')).toMatchObject({ usedSeconds: 10, knownAcceptedSeconds: 4, remainingSeconds: 490, corrected: false })
  })

  test('creates the current timezone bucket and excludes another key or day', async () => {
    const day = usageDayForTimezone('Asia/Shanghai')
    const fixture = reconciliationFixture({ bucket: null, tasks: [
      { keyId: 'key', day, used: 4 },
      { keyId: 'different-key', day, used: 100 },
      { keyId: 'key', day: '2000-01-01', used: 200 },
    ] })
    expect(await fixture.service.reconcileUsage('key')).toMatchObject({ usageDay: day, usedSeconds: 4, remainingSeconds: 496, limitSeconds: 500 })
  })

  test('rejects accepted usage over the existing cap without clipping or raising the cap', async () => {
    const fixture = reconciliationFixture({
      bucket: { used_seconds: 0, reserved_seconds: 10, released_seconds: 12, limit_seconds: 480 },
      tasks: [{ keyId: 'key', day: usageDayForTimezone('Asia/Shanghai'), used: 475 }],
    })
    await expect(fixture.service.reconcileUsage('key')).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('不会截断') })
    expect(fixture.bucket()).toEqual({ used_seconds: 0, reserved_seconds: 10, released_seconds: 12, limit_seconds: 480 })
    expect(fixture.audits).toHaveLength(0)
  })

  test('locks only the usage bucket before reading accepted totals to avoid settlement deadlocks', async () => {
    const fixture = reconciliationFixture()
    await fixture.service.reconcileUsage('key')
    const locks = fixture.calls.filter(call => call.sql.includes('FOR UPDATE'))
    expect(locks).toHaveLength(1)
    expect(locks[0].sql).toContain('FROM video_key_usage_daily')
    const locked = fixture.calls.findIndex(call => call === locks[0])
    const accepted = fixture.calls.findIndex(call => call.sql.includes('sum(quota_seconds_used)'))
    expect(accepted).toBeGreaterThan(locked)
  })

  test('returns explicit local ledger provenance and unknown upstream quota', async () => {
    const fixture = reconciliationFixture()
    expect(await fixture.service.reconcileUsage('key')).toMatchObject({ quotaSource: 'local_ledger', upstreamQuota: { status: 'unknown', message: expect.stringContaining('尚未同步 Agnes 上游额度') } })
    const db: any = { query: async () => [{ id: 'key', channel_id: 'channel', account_label: 'Agnes', timezone: 'Asia/Shanghai', daily_limit_seconds: 500, enabled: true, video_generation_enabled: true, probe_status: 'passed' }] }
    expect((await new VideoKeyService(db, {} as any).list())[0]).toMatchObject({ quotaSource: 'local_ledger', upstreamQuota: { status: 'unknown' } })
  })

  test('requires the dedicated rotate operation for credential changes', async () => {
    const db: any = { tx: vi.fn(), one: vi.fn() }
    await expect(new VideoKeyService(db, {} as any).update('key', { apiKey: 'new-secret' })).rejects.toThrow('轮换')
    expect(db.tx).not.toHaveBeenCalled()
  })

  test('does not lower an active day below used and reserved seconds', async () => {
    const current = {
      id: 'key', account_label: 'Agnes', daily_limit_seconds: 500, timezone: 'Asia/Shanghai',
      max_concurrency: 1, priority: 100, enabled: false, video_generation_enabled: false,
      probe_status: 'passed', prompt_expansion_enabled: false,
    }
    const db: any = {
      tx: async (fn: any) => fn({ query: async (sql: string) => {
        if (sql.startsWith('SELECT * FROM video_provider_keys')) return { rows: [current] }
        if (sql.startsWith('SELECT * FROM video_key_usage_daily')) return { rows: [{ used_seconds: 300, reserved_seconds: 100 }] }
        throw new Error(`unexpected query: ${sql}`)
      } }),
      one: vi.fn(),
    }
    await expect(new VideoKeyService(db, {} as any).update('key', { dailyLimitSeconds: 399 })).rejects.toThrow('每日上限')
  })

  test('rechecks active tasks after locking the usage bucket', async () => {
    const candidate = {
      id: 'key', channel_id: 'channel', account_label: 'Agnes', base_url: 'https://apihub.agnes-ai.com/v1',
      encrypted_api_key: 'encrypted', daily_limit_seconds: 500, timezone: 'Asia/Shanghai', max_concurrency: 1,
      priority: 100, enabled: true, video_generation_enabled: true, probe_status: 'passed',
      success_count: 0, failure_count: 0, latency_ewma_ms: null, latency_p95_ms: null,
    }
    const statements: string[] = []
    const db: any = {
      tx: async (fn: any) => fn({ query: async (sql: string) => {
        statements.push(sql)
        if (sql.startsWith('SELECT vk.*')) return { rows: [candidate] }
        if (sql.startsWith('SELECT * FROM video_key_usage_daily')) return { rows: [{ used_seconds: 0, reserved_seconds: 0, limit_seconds: 500 }] }
        if (sql.includes('SELECT count(*)::int AS count FROM media_tasks')) return { rows: [{ count: 1 }] }
        return { rows: [] }
      } }),
    }
    await expect(new VideoKeyService(db, {} as any).reserveForTask('task', 4)).resolves.toBeNull()
    const usageIndex = statements.findIndex((sql) => sql.startsWith('SELECT * FROM video_key_usage_daily'))
    const activeIndex = statements.findIndex((sql) => sql.includes('SELECT count(*)::int AS count FROM media_tasks'))
    expect(activeIndex).toBeGreaterThan(usageIndex)
  })

  test.each([
    { label: 'changed task', result: { rows: [], rowCount: 0 } },
    { label: 'missing returned task', result: { rowCount: 1 } },
    { label: 'missing row count', result: { rows: [{ id: 'changed-task' }] } },
  ])('rolls back reserved seconds without a confirmed task assignment: $label', async ({ result }) => {
    const candidate = {
      id: 'key', channel_id: 'channel', account_label: 'Agnes', base_url: 'https://apihub.agnes-ai.com/v1',
      encrypted_api_key: 'encrypted', daily_limit_seconds: 500, timezone: 'Asia/Shanghai', max_concurrency: 1,
      priority: 100, success_count: 0, failure_count: 0,
    }
    let reserved = 0
    let rollback = false
    const db: any = {
      tx: async (fn: any) => {
        const before = reserved
        try {
          return await fn({ query: async (sql: string, params: any[] = []) => {
            if (sql.startsWith('SELECT vk.*')) return { rows: [candidate] }
            if (sql.startsWith('SELECT * FROM video_key_usage_daily')) return { rows: [{ used_seconds: 0, reserved_seconds: reserved, limit_seconds: 500 }] }
            if (sql.includes('SELECT count(*)::int AS count FROM media_tasks')) return { rows: [{ count: 0 }] }
            if (sql.startsWith('UPDATE video_key_usage_daily')) {
              reserved += Number(params[2])
              return { rows: [{ reserved_seconds: reserved }] }
            }
            // A canceled/accepted task fails the guarded assignment.
            if (sql.startsWith('UPDATE media_tasks')) return result
            return { rows: [] }
          } })
        } catch (error) {
          reserved = before
          rollback = true
          throw error
        }
      },
    }
    await expect(new VideoKeyService(db, {} as any).reserveForTask('changed-task', 4)).rejects.toMatchObject({ statusCode: 409 })
    expect(rollback).toBe(true)
    expect(reserved).toBe(0)
  })
})
