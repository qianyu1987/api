import { randomUUID } from 'node:crypto'
import type { Database } from '../db/index.js'

export type ChannelHealth = {
  channel_id: string; model: string; samples: number; successes: number
  compatible?: boolean | null; compatibility_checked_at?: string | Date | null
  p95_ms: number | null; consecutive_failures: number; circuit_open_until: string | Date | null
  last_success_at?: string | Date | null; channel_name?: string
}
export type HealthObservation = {
  id?: string; channelId: string; model: string; outcome: string; latencyMs: number
  durationMs?: number; statusCode?: number | null
}

export function affectsChannelHealth(outcome: string, status?: number | null): boolean {
  return outcome !== 'canceled' && status !== 413 && !(outcome === 'client_error' && ![401, 403].includes(status || 0))
}

export function healthStatus(h?: ChannelHealth, now = Date.now()): 'unknown' | 'healthy' | 'degraded' | 'cooldown' | 'unavailable' {
  if (!h) return 'unknown'
  if (h.compatible === false) return 'unavailable'
  if (h.circuit_open_until && new Date(h.circuit_open_until).getTime() > now) return 'cooldown'
  if (Number(h.consecutive_failures) >= 3 || (Number(h.samples) >= 5 && Number(h.successes) / Number(h.samples) < .85)) return 'degraded'
  return Number(h.samples) ? 'healthy' : 'unknown'
}

/** Cold channels keep their configured order. A healthy preferred channel is
 * sticky; degraded channels are ranked using completed responses, not headers. */
export function rankChannels<T extends { id: string; priority: number; timeoutMs: number }>(channels: T[], health: ChannelHealth[]): T[] {
  const byId = new Map(health.map(h => [h.channel_id, h]))
  const active = channels.filter(c => !['cooldown','unavailable'].includes(healthStatus(byId.get(c.id))))
  const preferred = [...active].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))[0]
  const sticky = preferred && preferred.priority < Math.min(...active.filter(c => c.id !== preferred.id).map(c => c.priority))
    && ['healthy', 'unknown'].includes(healthStatus(byId.get(preferred.id)))
    && Number(byId.get(preferred.id)?.p95_ms || 0) <= preferred.timeoutMs
  return [...active].sort((a, b) => {
    if (sticky && (a.id === preferred.id || b.id === preferred.id)) return a.id === preferred.id ? -1 : 1
    const ah = byId.get(a.id), bh = byId.get(b.id)
    const degraded = Number(healthStatus(ah) === 'degraded') - Number(healthStatus(bh) === 'degraded')
    if (degraded) return degraded
    const rate = (h?: ChannelHealth) => h && Number(h.samples) >= 5 ? Number(h.successes) / Number(h.samples) : .85
    return rate(bh) - rate(ah) || Number(ah?.p95_ms ?? Infinity) - Number(bh?.p95_ms ?? Infinity) || a.priority - b.priority || a.id.localeCompare(b.id)
  })
}

export class ChannelHealthService {
  private cache = new Map<string, { until: number; rows: ChannelHealth[] }>()
  constructor(private db: Database) {}
  async list(model?: string): Promise<ChannelHealth[]> {
    const key = model || '*', cached = this.cache.get(key)
    if (cached && cached.until > Date.now()) return cached.rows
    const rows = await this.db.query<ChannelHealth>(`SELECT h.channel_id,h.model,c.name AS channel_name,h.compatible,h.compatibility_checked_at,h.consecutive_failures,h.circuit_open_until,h.last_success_at,
      COALESCE(x.samples,0)::int AS samples,COALESCE(x.successes,0)::int AS successes,x.p95_ms
      FROM channel_model_health h JOIN channels c ON c.id=h.channel_id LEFT JOIN LATERAL (
        SELECT count(*) AS samples,count(*) FILTER(WHERE outcome='success') AS successes,
        percentile_cont(.95) WITHIN GROUP(ORDER BY latency_ms) FILTER(WHERE outcome='success') AS p95_ms
        FROM (SELECT outcome,latency_ms FROM channel_health_observations o WHERE o.channel_id=h.channel_id AND o.model=h.model
          AND o.created_at>now()-interval '24 hours' ORDER BY o.created_at DESC LIMIT 200) recent
      ) x ON true WHERE ($1::text IS NULL OR h.model=$1)`, [model || null])
    this.cache.set(key, { until: Date.now() + 10_000, rows })
    return rows
  }
  async observe(input: HealthObservation): Promise<void> {
    if (!input.model || !affectsChannelHealth(input.outcome, input.statusCode)) return
    await this.db.tx(async client => {
      const inserted = await client.query(`INSERT INTO channel_health_observations(id,channel_id,model,outcome,latency_ms,duration_ms,status_code)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING RETURNING id`,
      [input.id || randomUUID(), input.channelId, input.model, input.outcome, Math.max(0, input.latencyMs), Math.max(0, input.durationMs || input.latencyMs), input.statusCode ?? null])
      if (!inserted.rowCount) return
      await client.query(`INSERT INTO channel_model_health(channel_id,model,consecutive_failures,last_success_at,last_failure_at)
        VALUES($1,$2,CASE WHEN $3 THEN 0 ELSE 1 END,CASE WHEN $3 THEN now() END,CASE WHEN NOT $3 THEN now() END)
        ON CONFLICT(channel_id,model) DO UPDATE SET
          consecutive_failures=CASE WHEN $3 THEN 0 ELSE channel_model_health.consecutive_failures+1 END,
          circuit_open_until=CASE WHEN $3 THEN NULL WHEN channel_model_health.consecutive_failures+1>=3 THEN now()+interval '60 seconds' ELSE channel_model_health.circuit_open_until END,
          compatible=CASE WHEN $3 THEN true ELSE channel_model_health.compatible END,
          last_success_at=CASE WHEN $3 THEN now() ELSE channel_model_health.last_success_at END,
          last_failure_at=CASE WHEN NOT $3 THEN now() ELSE channel_model_health.last_failure_at END,updated_at=now()`, [input.channelId, input.model, input.outcome === 'success'])
    })
    this.cache.clear()
  }
}
