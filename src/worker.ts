import { loadConfig } from './config.js'
import { Database } from './db/index.js'
import { BillingService } from './services/billing.js'
import { MailService } from './services/mail.js'

/** Small, repeatable maintenance worker. Billing state lives in PostgreSQL; Redis is not used as a source of truth. */
export async function runWorker(): Promise<void> {
  const config = loadConfig()
  const db = new Database(config)
  const billing = new BillingService(db)
  const mail = new MailService(db, config)
  try {
    await db.migrate()
    await db.query(`UPDATE orders
      SET status = 'expired', closed_at = COALESCE(closed_at, now()), updated_at = now()
      WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= now()`)
    // User-facing cursors and filters use request start time. Retention uses
    // the same immutable event clock so a long-lived stream cannot extend an
    // otherwise expired audit record merely by settling late.
    await db.query(`DELETE FROM usage_logs WHERE started_at < now() - ($1 || ' days')::interval`, [config.usageRetentionDays])
    await db.query(`DELETE FROM relay_attempts a WHERE NOT EXISTS (SELECT 1 FROM usage_logs u WHERE u.request_id = a.request_id)`)
    await billing.migrateLegacySubscriptions()
    await billing.resetDueSubscriptions()
    await billing.releaseExpiredReservations()
    await mail.deliverQueued(20)
  } finally {
    await db.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) runWorker().catch((error) => { console.error(error); process.exitCode = 1 })
