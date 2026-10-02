import { describe, expect, test } from 'vitest'
import { deriveVideoKeyCost, fixedVideoPriceMicros, maskProviderKey, rankVideoCandidates, usageDayForTimezone, VIDEO_UNIT_PRICE_MICROS } from '../src/services/video-keys.js'

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
})
