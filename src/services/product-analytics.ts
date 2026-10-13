import { createHmac } from 'node:crypto'
import type { Database } from '../db/index.js'

export class ProductAnalytics {
  constructor(private db: Database, private pepper: string) {}
  subject(userId: string): string { return createHmac('sha256', this.pepper).update('product:' + userId).digest('hex') }
  async record(userId: string, event: 'visit' | 'recharge_opened'): Promise<void> {
    await this.db.query(`INSERT INTO product_events(subject_hash,event,dedupe_key)
      VALUES($1,$2,(now() AT TIME ZONE 'Asia/Shanghai')::date::text) ON CONFLICT DO NOTHING`, [this.subject(userId), event])
  }
  /** Authoritative lifecycle events are sourced from committed business rows.
   * This also backfills history without accepting payment/success claims from JS. */
  async sync(): Promise<void> {
    await this.db.query(`INSERT INTO product_events(subject_hash,event,dedupe_key,event_day,created_at)
      SELECT encode(hmac('product:'||x.user_id::text,$1,'sha256'),'hex'),x.event,x.dedupe_key,
        (x.at AT TIME ZONE 'Asia/Shanghai')::date,x.at FROM (
        SELECT id AS user_id,'registration_completed' AS event,'first' AS dedupe_key,created_at AS at FROM users WHERE role='user'
        UNION ALL SELECT l.user_id,'first_api_success','first',min(l.started_at) FROM usage_logs l JOIN users u ON u.id=l.user_id AND u.role='user' WHERE l.success GROUP BY l.user_id
        UNION ALL SELECT m.user_id,'first_media_task','first',min(m.created_at) FROM media_tasks m JOIN users u ON u.id=m.user_id AND u.role='user' GROUP BY m.user_id
        UNION ALL SELECT o.user_id,'payment_succeeded',o.id::text,o.paid_at FROM orders o JOIN users u ON u.id=o.user_id AND u.role='user' WHERE o.status='paid' AND o.paid_at IS NOT NULL
      ) x ON CONFLICT DO NOTHING`, [this.pepper])
  }
  async report(): Promise<any> {
    const [events, retention] = await Promise.all([
      this.db.query(`SELECT event,count(*)::int AS events,count(DISTINCT subject_hash)::int AS users
        FROM product_events WHERE created_at>now()-interval '30 days' GROUP BY event ORDER BY event`),
      this.db.query(`WITH tracking AS (SELECT (min(created_at) AT TIME ZONE 'Asia/Shanghai')::date AS start_day FROM product_events WHERE event='visit'),
        registrations AS (SELECT subject_hash,event_day FROM product_events,tracking WHERE event='registration_completed' AND event_day >= tracking.start_day),
        days AS (SELECT unnest(ARRAY[1,7,30]) AS day)
        SELECT d.day,count(*) FILTER(WHERE r.event_day+d.day <= (now() AT TIME ZONE 'Asia/Shanghai')::date)::int AS eligible,
          count(*) FILTER(WHERE r.event_day+d.day <= (now() AT TIME ZONE 'Asia/Shanghai')::date AND EXISTS(
            SELECT 1 FROM product_events v WHERE v.subject_hash=r.subject_hash AND v.event='visit' AND v.event_day=r.event_day+d.day))::int AS returned
        FROM registrations r CROSS JOIN days d GROUP BY d.day ORDER BY d.day`),
    ])
    return { events, retention, note: '回访从埋点上线日起统计；历史未埋点日期不计入留存率。事件仅含站内匿名标识。' }
  }
}
