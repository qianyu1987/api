import { describe, expect, test, vi } from 'vitest'
import { deriveVideoKeyCost, fixedVideoPriceMicros, maskProviderKey, rankVideoCandidates, usageDayForTimezone, VIDEO_UNIT_PRICE_MICROS, VideoKeyService } from '../src/services/video-keys.js'

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
      throw new Error(`unexpected query: ${sql}`)
    }
    const db: any = { tx: async (fn: any) => fn({ query: clientQuery }) }
    await expect(new VideoKeyService(db, {} as any).resetUsage('key', '保留任务不能重置')).rejects.toThrow('不能重置')
  })

  test('allows an administrator to reset completed usage after tasks finish', async () => {
    const statements: string[] = []
    const clientQuery = async (sql: string) => {
      statements.push(sql)
      if (sql.startsWith('SELECT * FROM video_provider_keys')) return { rows: [{ id: 'key', timezone: 'Asia/Shanghai', daily_limit_seconds: 500 }] }
      if (sql.startsWith('SELECT * FROM video_key_usage_daily')) return { rows: [{ reserved_seconds: 0, used_seconds: 4, released_seconds: 12 }] }
      if (sql.includes('FROM media_tasks')) return { rows: [] }
      return { rows: [] }
    }
    const db: any = { tx: async (fn: any) => fn({ query: clientQuery }) }
    await expect(new VideoKeyService(db, {} as any).resetUsage('key', '按管理员要求刷新额度')).resolves.toBeUndefined()
    expect(statements.some((sql) => sql.includes('used_seconds=0'))).toBe(true)
  })

  test('refuses to reset while a task can still settle or release quota', async () => {
    const clientQuery = async (sql: string) => {
      if (sql.startsWith('SELECT * FROM video_provider_keys')) return { rows: [{ id: 'key', timezone: 'Asia/Shanghai', daily_limit_seconds: 500 }] }
      if (sql.startsWith('SELECT * FROM video_key_usage_daily')) return { rows: [{ reserved_seconds: 0, used_seconds: 4, released_seconds: 0 }] }
      if (sql.includes('FROM media_tasks')) return { rows: [{ id: 'task', status: 'processing', quota_seconds_reserved: 0 }] }
      throw new Error(`unexpected query: ${sql}`)
    }
    const db: any = { tx: async (fn: any) => fn({ query: clientQuery }) }
    await expect(new VideoKeyService(db, {} as any).resetUsage('key', '生成任务仍在处理中')).rejects.toThrow('不能重置')
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
})
