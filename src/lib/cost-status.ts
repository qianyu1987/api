import { isSolFallback } from './public-model.js'
import type { Database } from '../db/index.js'

// Read the immutable request snapshot, never today's cost configuration.
export function fallbackCostPending(row: any): boolean {
  if (!isSolFallback(row.requested_model, row.upstream_model)) return false
  const cost = row.pricing_snapshot?.appliedChannelCost
  return !cost || cost.channelId !== row.final_channel_id
    || ![row.requested_model, '*'].includes(cost.model) || !String(cost.source || '').trim()
}

// The equivalent predicate for report aggregation over usage_logs.
export const pendingFallbackCostSql = `(requested_model = 'gpt-5.6-sol' AND upstream_model IN ('agnes-3.0-flash','agnes-2.5-flash')
  AND NOT COALESCE(
    pricing_snapshot->'appliedChannelCost'->>'channelId' = final_channel_id::text
    AND pricing_snapshot->'appliedChannelCost'->>'model' IN (requested_model, '*')
    AND length(trim(pricing_snapshot->'appliedChannelCost'->>'source')) > 0, false))`

/** Live configuration alerts clear as soon as a sourced cost becomes effective. */
export async function fallbackCostAlerts(db: Database) {
  const rows = await db.query<any>(`SELECT c.id,c.name,c.model_map->>'gpt-5.6-sol' AS upstream_model FROM channels c
    WHERE c.enabled AND c.model_map->>'gpt-5.6-sol' IN ('agnes-3.0-flash','agnes-2.5-flash')
    AND NOT COALESCE((SELECT length(trim(m.price_source)) > 0 FROM channel_model_costs m WHERE m.channel_id=c.id
      AND m.model_pattern IN ('gpt-5.6-sol','*')
      AND (m.price_effective_at IS NULL OR m.price_effective_at <= now())
      ORDER BY (m.model_pattern = 'gpt-5.6-sol') DESC LIMIT 1), false)`)
  return rows.map(row => ({
    id: `fallback-cost:${row.id}`, kind: 'cost_missing', severity: 'warning', status: 'open',
    resource_type: 'channel', resource_id: String(row.id),
    message: `${row.name}：${row.upstream_model} 成本待核实，当前按 gpt-5.6-sol 默认成本估算，利润仅供参考。请配置该渠道的输入、输出、缓存人民币成本及来源。`,
  }))
}
