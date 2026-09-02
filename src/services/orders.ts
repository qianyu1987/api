import { randomUUID } from 'node:crypto'
import type { AppConfig } from '../config.js'
import { Database, one } from '../db/index.js'
import { MICROS_PER_CENT } from '../lib/money.js'
import { AffiliateService } from './affiliate.js'
import { nextShanghaiReset } from './billing.js'

export type PaymentMethod = 'wechat' | 'alipay'

/**
 * A verified provider callback.  The adapter currently calls the order number
 * `orderId` and reports an integer amount in fen.  `orderNo`/`amountMicros` and
 * `providerTradeId` are accepted as aliases so callback workers can pass their
 * normalized representation without converting it back to provider terms.
 * `rawPayload` is deliberately not persisted by the settlement code.
 */
export type VerifiedPayment = {
  provider: PaymentMethod | 'wechat_native' | 'alipay_precreate'
  eventId: string
  orderId?: string
  orderNo?: string
  transactionId?: string | null
  providerTradeId?: string | null
  status?: 'paid' | 'pending' | 'failed'
  amountFen?: number | bigint | string
  amountMicros?: number | bigint | string
  currency: string
  paidAt?: string | null
  providerStatus?: string | null
  buyerId?: string | null
  rawPayload?: unknown
}

export type CreatedOrder = {
  id: string
  orderNo: string
  kind: 'wallet_topup' | 'subscription'
  amountMicros: bigint
  paymentMethod: PaymentMethod
  planId: string | null
  expiresAt: Date
}

function bigintValue(value: unknown): bigint {
  return typeof value === 'bigint' ? value : BigInt(String(value ?? 0))
}

function orderNo(): string {
  return `RS${Date.now().toString(36).toUpperCase()}${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`
}

function paymentProvider(method: PaymentMethod): string {
  return method === 'wechat' ? 'wechat_native' : 'alipay_precreate'
}

function normalizeProvider(value: unknown): PaymentMethod | null {
  const provider = String(value || '').trim().toLowerCase()
  if (provider === 'wechat' || provider === 'wechat_native') return 'wechat'
  if (provider === 'alipay' || provider === 'alipay_precreate') return 'alipay'
  return null
}

function parseInteger(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${field} 无效`)
    return BigInt(value)
  }
  const text = String(value ?? '').trim()
  if (!/^-?\d+$/.test(text)) throw new Error(`${field} 无效`)
  try { return BigInt(text) } catch { throw new Error(`${field} 无效`) }
}

function cleanMetadataText(value: unknown, maxLength = 256): string | null {
  if (value === undefined || value === null) return null
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return text ? text.slice(0, maxLength) : null
}

function isoDate(value: unknown): string | null {
  const text = cleanMetadataText(value, 80)
  if (!text) return null
  const time = Date.parse(text)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

type NormalizedPayment = {
  provider: PaymentMethod
  eventId: string
  orderNo: string
  transactionId: string | null
  status: 'paid' | 'pending' | 'failed'
  amountMicros: bigint
  amountFen: bigint
  currency: 'CNY'
  paidAt: string | null
  providerStatus: string | null
  buyerId: string | null
}

function normalizePayment(input: VerifiedPayment): NormalizedPayment {
  const provider = normalizeProvider(input.provider)
  if (!provider) throw new Error('支付渠道无效')

  const eventId = String(input.eventId || '').trim()
  if (!eventId || eventId.length > 256 || /[\u0000-\u001f\u007f]/.test(eventId)) throw new Error('支付事件编号无效')

  const orderNo = String(input.orderNo ?? input.orderId ?? '').trim()
  if (!orderNo || orderNo.length > 128 || /[\u0000-\u001f\u007f]/.test(orderNo)) throw new Error('支付订单号无效')

  const currency = String(input.currency || '').trim().toUpperCase()
  if (currency !== 'CNY') throw new Error('支付币种必须为 CNY')

  let amountMicros: bigint | undefined
  if (input.amountMicros !== undefined && input.amountMicros !== null) {
    amountMicros = parseInteger(input.amountMicros, '支付金额')
    if (amountMicros <= 0n || amountMicros % MICROS_PER_CENT !== 0n) throw new Error('支付金额无效')
  }

  let amountFen: bigint | undefined
  if (input.amountFen !== undefined && input.amountFen !== null) {
    amountFen = parseInteger(input.amountFen, '支付金额')
    if (amountFen <= 0n) throw new Error('支付金额无效')
    const fromFen = amountFen * MICROS_PER_CENT
    if (amountMicros !== undefined && amountMicros !== fromFen) throw new Error('支付金额不一致')
    amountMicros = fromFen
  }
  if (amountMicros === undefined || amountMicros <= 0n) throw new Error('支付金额缺失')
  amountFen = amountMicros / MICROS_PER_CENT

  const providerStatus = cleanMetadataText(input.providerStatus, 120)
  let status = input.status
  if (!status) {
    const state = String(providerStatus || '').toUpperCase()
    status = /SUCCESS|PAID|FINISHED|COMPLETED/.test(state)
      ? 'paid'
      : /CLOSED|REVOKED|PAYERROR|FAIL|REFUND|CANCEL/.test(state) ? 'failed' : 'pending'
  }
  if (status !== 'paid' && status !== 'pending' && status !== 'failed') throw new Error('支付状态无效')

  const transactionId = cleanMetadataText(input.providerTradeId ?? input.transactionId, 256)
  if (status === 'paid' && !transactionId) throw new Error('支付交易号缺失')
  return {
    provider,
    eventId,
    orderNo,
    transactionId,
    status,
    amountMicros,
    amountFen,
    currency: 'CNY',
    paidAt: isoDate(input.paidAt),
    providerStatus,
    buyerId: cleanMetadataText(input.buyerId, 256),
  }
}

function callbackMetadata(payment: NormalizedPayment): string {
  // Keep this whitelist intentionally small.  In particular, never include a
  // provider callback body (which may contain buyer or credential data).
  return JSON.stringify({
    status: payment.status,
    providerStatus: payment.providerStatus,
    paidAt: payment.paidAt,
    transactionId: payment.transactionId,
    buyerId: payment.buyerId,
    amountFen: payment.amountFen.toString(),
    currency: payment.currency,
  })
}

type CallbackResult = { accepted: boolean; alreadyProcessed: boolean; orderId: string | null }

function alreadyProcessed(orderId: unknown, accepted = true): CallbackResult {
  return { accepted, alreadyProcessed: true, orderId: orderId ? String(orderId) : null }
}

function eventWasAccepted(event: any): boolean {
  return Boolean(event?.verified) && !String(event?.event_type || '').startsWith('rejected_')
}

/**
 * The order service is the only path that mutates payment-derived balances.
 * It deliberately keeps provider verification outside the transaction, then
 * records the verified callback and every balance movement atomically.
 */
export class OrderService {
  constructor(
    private readonly db: Database,
    private readonly affiliate: AffiliateService,
    private readonly config: AppConfig,
  ) {}

  async create(userId: string, input: { kind: 'wallet_topup' | 'subscription'; amountMicros?: bigint; planId?: string | null; paymentMethod: PaymentMethod }): Promise<CreatedOrder> {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000)
    const planId = input.kind === 'subscription' ? String(input.planId || '') : null
    let planNameSnapshot: string | null = null
    let planQuotaSnapshot: bigint | null = null
    let planDurationSnapshot: number | null = null
    let amount = input.amountMicros || 0n
    if (input.kind === 'subscription') {
      if (!planId) throw new Error('请选择套餐')
      const plan = await this.db.one<any>('SELECT id, name, price_micros, quota_micros, duration_days, active, enabled FROM plans WHERE id = $1', [planId])
      if (!plan || !plan.active || !plan.enabled) throw new Error('套餐不可购买')
      amount = bigintValue(plan.price_micros)
      planNameSnapshot = String(plan.name || '').trim().slice(0, 128) || '套餐'
      planQuotaSnapshot = bigintValue(plan.quota_micros)
      planDurationSnapshot = Number(plan.duration_days)
      if (planQuotaSnapshot <= 0n || planDurationSnapshot !== 30) throw new Error('套餐配置无效')
    }
    if (amount <= 0n) throw new Error('金额必须大于 0')
    if (amount % MICROS_PER_CENT !== 0n) throw new Error('支付金额必须精确到分')
    const no = orderNo()
    const row = await this.db.one<any>(
      `INSERT INTO orders(
         order_no, user_id, kind, order_type, amount_micros, plan_id,
         plan_name_snapshot, plan_quota_micros, plan_duration_days,
         payment_method, payment_provider, expires_at
       ) VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, order_no, kind, amount_micros, plan_id, payment_method, expires_at`,
      [no, userId, input.kind, amount.toString(), planId, planNameSnapshot, planQuotaSnapshot?.toString() || null, planDurationSnapshot, input.paymentMethod, paymentProvider(input.paymentMethod), expiresAt],
    )
    if (!row) throw new Error('创建订单失败')
    return { id: String(row.id), orderNo: String(row.order_no), kind: row.kind, amountMicros: bigintValue(row.amount_micros), paymentMethod: row.payment_method, planId: row.plan_id ? String(row.plan_id) : null, expiresAt: new Date(row.expires_at) }
  }

  async attachNativePayment(orderId: string, payment: { providerOrderId: string | null; codeUrl: string }): Promise<void> {
    await this.db.query(
      `UPDATE orders
       SET provider_order_id = COALESCE($1, provider_order_id), qr_code_url = $2,
           metadata = metadata || $3::jsonb
       WHERE id = $4 AND status = 'pending'`,
      [payment.providerOrderId, payment.codeUrl, JSON.stringify({ codeUrl: payment.codeUrl }), orderId],
    )
  }

  async markCreationFailure(orderId: string, code: string): Promise<void> {
    await this.db.query(`UPDATE orders SET status = 'failed', failure_code = $1 WHERE id = $2 AND status = 'pending'`, [code.slice(0, 120), orderId])
  }

  async applyVerifiedCallback(payment: VerifiedPayment): Promise<CallbackResult> {
    const normalized = normalizePayment(payment)
    return this.db.tx(async (client) => {
      // A callback may be delivered more than once.  The unique payment-event
      // constraint is the cross-replica idempotency boundary; the early lookup
      // makes ordinary retries cheap, while the insert below resolves a race.
      const existingEvent = await one<any>(client,
        `SELECT id, order_id, verified, event_type FROM payment_events
         WHERE provider = $1 AND event_id = $2 FOR UPDATE`,
        [normalized.provider, normalized.eventId],
      )
      if (existingEvent) return alreadyProcessed(existingEvent.order_id, eventWasAccepted(existingEvent))

      const duplicateResult = async (fallbackOrderId: string | null): Promise<CallbackResult> => {
        const duplicate = await one<any>(client,
          `SELECT order_id, verified, event_type FROM payment_events
           WHERE provider = $1 AND event_id = $2 FOR UPDATE`,
          [normalized.provider, normalized.eventId],
        )
        return alreadyProcessed(duplicate?.order_id || fallbackOrderId, eventWasAccepted(duplicate))
      }

      // Provider callbacks carry the merchant order number.  The UUID lookup
      // is retained only for compatibility with early locally-created orders.
      const order = await one<any>(client,
        `SELECT * FROM orders
         WHERE order_no = $1 OR id::text = $1
         FOR UPDATE`,
        [normalized.orderNo],
      )
      if (!order) {
        const inserted = await this.insertPaymentEvent(client, normalized, null, false, 'unknown_order')
        return inserted ? { accepted: false, alreadyProcessed: false, orderId: null } : duplicateResult(null)
      }

      const orderId = String(order.id)
      const orderProvider = normalizeProvider(order.payment_provider)
      const orderMethod = normalizeProvider(order.payment_method)
      const providerMatches = orderProvider === normalized.provider && (!orderMethod || orderMethod === normalized.provider)
      const amountMatches = bigintValue(order.amount_micros) === normalized.amountMicros
      const orderCurrency = String(order.currency || 'CNY').trim().toUpperCase()
      if (!providerMatches || !amountMatches || orderCurrency !== 'CNY') {
        const inserted = await this.insertPaymentEvent(client, normalized, orderId, false, 'rejected_amount_or_provider_mismatch')
        return inserted ? { accepted: false, alreadyProcessed: false, orderId } : duplicateResult(orderId)
      }
      if (order.provider_trade_id && normalized.transactionId && String(order.provider_trade_id) !== normalized.transactionId) {
        const inserted = await this.insertPaymentEvent(client, normalized, orderId, false, 'rejected_transaction_mismatch')
        return inserted ? { accepted: false, alreadyProcessed: false, orderId } : duplicateResult(orderId)
      }

      // Store only a bounded, whitelisted metadata object.  `rawPayload` from
      // adapters is intentionally ignored and never reaches PostgreSQL.
      // A distinct provider event can legitimately arrive after the order was
      // settled (for example a delayed success notification). A paid order is
      // therefore acknowledged but never credited again. The accepted event
      // stays immutable for audit; terminal non-paid orders are rejected.
      if (order.status === 'paid') {
        const inserted = await this.insertPaymentEvent(client, normalized, orderId, true, `payment_${normalized.status}`)
        return inserted ? alreadyProcessed(orderId) : duplicateResult(orderId)
      }
      if (order.status !== 'pending') {
        const inserted = await this.insertPaymentEvent(client, normalized, orderId, true, 'rejected_order_not_pending')
        return inserted ? { accepted: false, alreadyProcessed: false, orderId } : duplicateResult(orderId)
      }

      const expiresAt = order.expires_at ? new Date(order.expires_at) : null
      if (expiresAt && Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() <= Date.now()) {
        const inserted = await this.insertPaymentEvent(client, normalized, orderId, true, 'rejected_order_expired')
        if (!inserted) return duplicateResult(orderId)
        await client.query(
          `UPDATE orders
           SET status = 'expired', closed_at = COALESCE(closed_at, now()),
               failure_code = COALESCE(failure_code, 'payment_order_expired'), updated_at = now()
           WHERE id = $1 AND status = 'pending'`,
          [orderId],
        )
        return { accepted: false, alreadyProcessed: false, orderId }
      }

      const insertedEvent = await this.insertPaymentEvent(client, normalized, orderId, true, `payment_${normalized.status}`)
      if (!insertedEvent) return duplicateResult(orderId)
      if (normalized.status === 'pending') return { accepted: true, alreadyProcessed: false, orderId }
      if (normalized.status === 'failed') {
        await client.query(
          `UPDATE orders
           SET status = 'failed', failure_code = $1, updated_at = now()
           WHERE id = $2 AND status = 'pending'`,
          [cleanMetadataText(normalized.providerStatus, 120) || 'provider_failed', orderId],
        )
        return { accepted: true, alreadyProcessed: false, orderId }
      }

      await client.query(
        `UPDATE orders
         SET status = 'paid', paid_amount_micros = $1,
             provider_trade_id = COALESCE($2, provider_trade_id),
             paid_at = COALESCE($3::timestamptz, now()), updated_at = now()
         WHERE id = $4 AND status = 'pending'`,
        [normalized.amountMicros.toString(), normalized.transactionId, normalized.paidAt, orderId],
      )

      if (order.kind === 'wallet_topup') {
        await this.creditWallet(client, order, normalized)
        await this.affiliate.creditForTopup(
          client,
          orderId,
          String(order.user_id),
          normalized.amountMicros,
          this.config.defaultAffiliateRateBps,
        )
      } else if (order.kind === 'subscription' || order.kind === 'subscription_purchase') {
        await this.creditSubscription(client, order, normalized.amountMicros)
      } else {
        throw new Error('订单类型无效')
      }

      return { accepted: true, alreadyProcessed: false, orderId }
    }, { isolationLevel: 'serializable' })
  }

  private async insertPaymentEvent(
    client: any,
    payment: NormalizedPayment,
    orderId: string | null,
    verified: boolean,
    eventType: string,
  ): Promise<any | null> {
    return one<any>(client,
      `INSERT INTO payment_events(
         provider, event_id, order_id, provider_transaction_id, event_type,
         verified, amount_micros, payload
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(provider, event_id) DO NOTHING
       RETURNING id, order_id`,
      [
        payment.provider,
        payment.eventId,
        orderId,
        payment.transactionId,
        eventType.slice(0, 80),
        verified,
        payment.amountMicros.toString(),
        callbackMetadata(payment),
      ],
    )
  }

  private async creditWallet(client: any, order: any, payment: NormalizedPayment): Promise<void> {
    // Lock the user row as well as the wallet row.  This closes the absent-row
    // race when a new account receives two topups at the same time.
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [order.user_id])
    const wallet = await one<any>(client,
      `SELECT balance_micros FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [order.user_id],
    )
    const next = bigintValue(wallet?.balance_micros) + payment.amountMicros
    if (wallet) {
      await client.query(
        `UPDATE wallets
         SET balance_micros = $1, version = version + 1, updated_at = now()
         WHERE user_id = $2`,
        [next.toString(), order.user_id],
      )
    } else {
      await client.query(
        `INSERT INTO wallets(user_id, balance_micros, version)
         VALUES ($1, $2, 1)`,
        [order.user_id, next.toString()],
      )
    }
    await client.query(
      `INSERT INTO wallet_ledger(
         user_id, kind, amount_micros, balance_after_micros, order_id,
         reference_note, metadata
       ) VALUES ($1, 'wallet_topup', $2, $3, $4, $5, $6)`,
      [
        order.user_id,
        payment.amountMicros.toString(),
        next.toString(),
        order.id,
        'payment callback',
        JSON.stringify({ provider: payment.provider, eventId: payment.eventId }),
      ],
    )
  }

  private async creditSubscription(client: any, order: any, paidAmountMicros: bigint): Promise<void> {
    // The order owns the commercial terms. Never read quota/name/duration
    // from the mutable admin plan row at payment time.
    const plan = await one<any>(client, 'SELECT id FROM plans WHERE id = $1 FOR UPDATE', [order.plan_id])
    if (!plan) throw new Error('套餐不存在，无法结算')
    const planName = cleanMetadataText(order.plan_name_snapshot, 128)
    const quota = bigintValue(order.plan_quota_micros)
    const durationDays = Number(order.plan_duration_days)
    if (!planName || quota <= 0n || durationDays !== 30) throw new Error('订单缺少有效套餐快照，请人工核查')

    const existing = await one<any>(client,
      `SELECT * FROM subscriptions WHERE user_id = $1 FOR UPDATE`,
      [order.user_id],
    )
    const startsAt = new Date()
    const expiresAt = new Date(startsAt.getTime() + durationDays * 24 * 60 * 60 * 1000)
    const existingExpiry = existing?.expires_at ? new Date(existing.expires_at) : null
    // Quota from an expired subscription is no longer usable. Retain any
    // in-flight reservation, however, so its later settlement/release can
    // still decrement the reservation counter without violating its check.
    const active = existing?.status === 'active' && existingExpiry && existingExpiry.getTime() > startsAt.getTime()
    const existingReserved = bigintValue(existing?.reserved_micros)
    const existingRemaining = active ? bigintValue(existing.remaining_micros) : 0n
    const remaining = (active ? existingRemaining : existingReserved) + quota
    let subscriptionId: string
      if (existing) {
        subscriptionId = String(existing.id)
        await client.query(
          `UPDATE subscriptions
         SET plan_id = $1, current_plan_id = $1, remaining_micros = $2,
             reset_quota_micros = $6, reset_timezone = 'Asia/Shanghai',
             next_reset_at = $7, last_reset_at = NULL,
             status = 'active', started_at = $3, expires_at = $4,
             last_purchase_at = $3, version = version + 1, updated_at = now()
         WHERE user_id = $5`,
        [plan.id, remaining.toString(), startsAt, expiresAt, order.user_id, quota.toString(), nextShanghaiReset(startsAt)],
      )
    } else {
      const sub = await one<any>(client,
        `INSERT INTO subscriptions(
         user_id, plan_id, current_plan_id, remaining_micros, status,
           started_at, expires_at, last_purchase_at, reset_quota_micros,
           reset_timezone, next_reset_at
         ) VALUES ($1, $2, $2, $3, 'active', $4, $5, $4, $6, 'Asia/Shanghai', $7)
         RETURNING id`,
        [order.user_id, plan.id, quota.toString(), startsAt, expiresAt, quota.toString(), nextShanghaiReset(startsAt)],
      )
      if (!sub?.id) throw new Error('创建套餐余额失败')
      subscriptionId = String(sub.id)
    }

    await client.query(
      `INSERT INTO subscription_purchases(
         subscription_id, order_id, plan_id, plan_name_snapshot,
         quota_added_micros, amount_paid_micros, starts_at, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [subscriptionId, order.id, plan.id, planName, quota.toString(), paidAmountMicros.toString(), startsAt, expiresAt],
    )
    await client.query(
      `INSERT INTO subscription_ledger(
         subscription_id, user_id, kind, remaining_delta_micros,
         order_id, metadata
       ) VALUES ($1,$2,'purchase_credit',$3,$4,$5)`,
      [
        subscriptionId,
        order.user_id,
        quota.toString(),
        order.id,
        JSON.stringify({ planName, expiresAt: expiresAt.toISOString() }),
      ],
    )
  }
}
