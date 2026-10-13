import type { Database } from '../db/index.js'
import { formatMicros } from '../lib/money.js'

export const sourcedCostSql = `COALESCE(pricing_snapshot->'appliedChannelCost'->>'channelId'=final_channel_id::text
  AND length(trim(pricing_snapshot->'appliedChannelCost'->>'source'))>0,false)`
export const acceptedVideoSecondsSql = `CASE WHEN quota_seconds_used>0 THEN quota_seconds_used
  WHEN upstream_id IS NOT NULL OR media_tasks.status='completed' THEN CASE WHEN COALESCE(user_input->>'seconds',request_payload->>'seconds','') ~ '^[0-9]{1,5}([.][0-9]+)?$' THEN COALESCE(user_input->>'seconds',request_payload->>'seconds')::numeric ELSE 0 END ELSE 0 END`
export const completedMediaRefundSql = `(SELECT COALESCE(sum(-w.reserved_delta_micros),0) FROM wallet_ledger w WHERE w.request_id=media_tasks.id AND w.kind='usage_release')`
const money = (value: any) => ({ micros: String(value || '0'), yuan: formatMicros(BigInt(String(value || '0'))) })

export class OperationsService {
  constructor(private db: Database) {}
  async report(from: Date, to: Date): Promise<any> {
    const params = [from, to]
    const [api, interruptions, finance, media, payments, balances, storage, host, cohorts] = await Promise.all([
      this.db.one<any>(`SELECT count(*)::int AS requests,count(*) FILTER(WHERE success)::int AS successes,
        count(DISTINCT l.user_id)::int AS users,percentile_cont(.95) WITHIN GROUP(ORDER BY duration_ms) FILTER(WHERE success) AS p95_ms,
        COALESCE(sum(charge_micros),0)::text AS charge,COALESCE(sum(cost_micros) FILTER(WHERE ${sourcedCostSql}),0)::text AS verified_cost,
        COALESCE(sum(cost_micros) FILTER(WHERE NOT ${sourcedCostSql}),0)::text AS estimated_cost,
        count(*) FILTER(WHERE success AND NOT ${sourcedCostSql})::int AS estimated_cost_requests
        FROM usage_logs l JOIN users u ON u.id=l.user_id AND u.role='user' WHERE l.started_at >= $1 AND l.started_at < $2`, params),
      this.db.query(`SELECT requested_model AS model,final_channel_name_snapshot AS channel,error_code AS reason,
        CASE WHEN duration_ms<30000 THEN '0–30秒' WHEN duration_ms<60000 THEN '30–60秒' WHEN duration_ms<120000 THEN '60–120秒' ELSE '120秒以上' END AS duration_bucket,
        count(*)::int AS requests FROM usage_logs l JOIN users u ON u.id=l.user_id AND u.role='user'
        WHERE l.started_at >= $1 AND l.started_at < $2 AND error_code IN ('stream_interrupted','client_disconnected','upstream_stream_timeout','upstream_stream_interrupted')
        GROUP BY requested_model,final_channel_name_snapshot,error_code,duration_bucket ORDER BY count(*) DESC LIMIT 100`, params),
      this.db.one<any>(`SELECT count(*)::int AS orders,count(DISTINCT o.user_id)::int AS buyers,
        COALESCE(sum(COALESCE(o.paid_amount_micros,o.amount_micros)),0)::text AS cash_received
        FROM orders o JOIN users u ON u.id=o.user_id AND u.role='user' WHERE o.status='paid' AND o.paid_at >= $1 AND o.paid_at < $2`, params),
      this.db.query(`SELECT kind,count(*)::int AS tasks,count(*) FILTER(WHERE media_tasks.status='completed')::int AS completed,
        COALESCE(sum(charge_micros) FILTER(WHERE media_tasks.status='completed'),0)::text AS charged,
        COALESCE(sum(${completedMediaRefundSql}) FILTER(WHERE media_tasks.status='failed'),0)::text AS released,
        COALESCE(sum(actual_cost_micros) FILTER(WHERE media_tasks.status='completed' OR upstream_id IS NOT NULL OR quota_seconds_used>0),0)::text AS cost_snapshot,
        COALESCE(sum(${acceptedVideoSecondsSql}) FILTER(WHERE kind='video'),0)::text AS accepted_seconds,
        COALESCE(sum(quota_seconds_reserved),0)::text AS reserved_seconds
        FROM media_tasks JOIN users u ON u.id=media_tasks.user_id AND u.role='user' WHERE media_tasks.created_at >= $1 AND media_tasks.created_at < $2 GROUP BY kind`, params),
      this.db.one<any>(`WITH p AS (SELECT o.id,o.kind,o.wallet_credit_micros,o.paid_at,
        CASE WHEN o.kind='wallet_topup' THEN w.created_at ELSE s.created_at END AS credited_at,
        w.amount_micros AS credited_micros FROM orders o JOIN users u ON u.id=o.user_id AND u.role='user'
        LEFT JOIN wallet_ledger w ON w.order_id=o.id AND w.kind='wallet_topup'
        LEFT JOIN subscription_purchases s ON s.order_id=o.id
        WHERE o.status='paid' AND o.paid_at >= $1 AND o.paid_at < $2)
        SELECT count(*) FILTER(WHERE credited_at IS NULL)::int AS missing_credit,
        count(*) FILTER(WHERE kind='wallet_topup' AND credited_at IS NOT NULL AND credited_micros IS DISTINCT FROM wallet_credit_micros)::int AS mismatched_credit,
        percentile_cont(.95) WITHIN GROUP(ORDER BY EXTRACT(epoch FROM credited_at-paid_at)) AS p95_credit_seconds FROM p`, params),
      this.db.one<any>(`SELECT COALESCE(sum(w.balance_micros),0)::text AS wallet_face_value,
        COALESCE(sum(w.reserved_micros),0)::text AS wallet_reserved FROM wallets w JOIN users u ON u.id=w.user_id AND u.role='user'`),
      this.db.query(`SELECT relname AS name,pg_total_relation_size(relid)::text AS bytes FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 8`),
      this.db.one<any>(`SELECT metrics,checked_at FROM operations_snapshots WHERE id='host'`),
      this.db.one<any>(`SELECT count(*)::int AS registered,
        count(*) FILTER(WHERE EXISTS(SELECT 1 FROM usage_logs l WHERE l.user_id=u.id AND l.success AND l.started_at<$2))::int AS api_activated,
        count(*) FILTER(WHERE EXISTS(SELECT 1 FROM orders o WHERE o.user_id=u.id AND o.status='paid' AND o.paid_at<$2))::int AS paid
        FROM users u WHERE u.role='user' AND u.created_at >= $1 AND u.created_at < $2`, params),
    ])
    return { from: from.toISOString(), to: to.toISOString(), audience: 'user', api: { ...api, charge: money(api?.charge), verifiedCost: money(api?.verified_cost), estimatedCost: money(api?.estimated_cost) },
      cashReceived: money(finance?.cash_received), paidOrders: Number(finance?.orders || 0), buyers: Number(finance?.buyers || 0),
      media: media.map(m => ({ ...m, charged: money(m.charged), released: money(m.released), costSnapshot: money(m.cost_snapshot) })),
      payments, interruptions, balances: { walletFaceValue: money(balances?.wallet_face_value), walletReserved: money(balances?.wallet_reserved) },
      storage, host, cohorts, note: '扣费为钱包/套餐额度面值；实付为支付现金。钱包未消费额度为面值负债，不能直接相减计算现金净利润。媒体成本为历史成本快照，释放冻结额不重复扣减已结算收入。' }
  }
}
