import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'

const serverSource = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')

describe('video profit reporting', () => {
  test('counts provider cost for accepted failures while keeping revenue/refunds status scoped', () => {
    const acceptedCost = "sum(actual_cost_micros) FILTER (WHERE status IN ('completed','failed') AND (upstream_id IS NOT NULL OR quota_seconds_used > 0))"
    expect(serverSource.match(new RegExp(acceptedCost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(2)
    expect(serverSource).toContain("sum(charge_micros) FILTER (WHERE status='completed')")
    expect(serverSource).toContain("sum(charge_micros) FILTER (WHERE status='failed')")
  })
})
