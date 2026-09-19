import { describe, expect, test, vi } from 'vitest'
import { normalizeNewOrderPaymentMethod, OrderService, topupCreditAmount } from '../src/services/orders.js'

type PaymentEvent = {
  provider: string
  eventId: string
  orderId: string | null
  eventType: string
  verified: boolean
}

function result(rows: any[] = []) { return { rows, rowCount: rows.length } }

function callbackHarness() {
  const order: any = {
    id: 'order-1', order_no: 'RSORDER1', user_id: 'user-1', kind: 'wallet_topup',
    payment_provider: 'wechat_native', payment_method: 'wechat', amount_micros: '10000',
    topup_multiplier_bps: 30000,
    currency: 'CNY', provider_trade_id: null, status: 'pending', expires_at: null,
  }
  const events: PaymentEvent[] = []
  const walletLedger: unknown[][] = []
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      if (normalized.startsWith('SELECT id, order_id, verified, event_type FROM payment_events')) {
        const event = events.find((item) => item.provider === values[0] && item.eventId === values[1])
        return result(event ? [{ order_id: event.orderId, verified: event.verified, event_type: event.eventType }] : [])
      }
      if (normalized.startsWith('SELECT * FROM orders')) return result([order])
      if (normalized.startsWith('INSERT INTO payment_events')) {
        const event = {
          provider: String(values[0]), eventId: String(values[1]), orderId: values[2] ? String(values[2]) : null,
          eventType: String(values[4]), verified: Boolean(values[5]),
        }
        if (events.some((item) => item.provider === event.provider && item.eventId === event.eventId)) return result()
        events.push(event)
        return result([{ id: events.length, order_id: event.orderId }])
      }
      if (normalized.startsWith("UPDATE orders SET status = 'paid'")) {
        order.status = 'paid'
        order.provider_trade_id = String(values[1])
        return result([{ id: order.id }])
      }
      if (normalized.startsWith('SELECT id FROM users')) return result([{ id: order.user_id }])
      if (normalized.startsWith('SELECT balance_micros FROM wallets')) return result([{ balance_micros: '0' }])
      if (normalized.startsWith('UPDATE wallets')) return result()
      if (normalized.startsWith('INSERT INTO wallet_ledger')) { walletLedger.push(values); return result() }
      if (normalized.startsWith('UPDATE orders SET wallet_credit_micros')) { order.wallet_credit_micros = values[0]; return result() }
      throw new Error(`unexpected SQL: ${normalized}`)
    },
  }
  const db = { tx: async (action: (transaction: typeof client) => Promise<unknown>) => action(client) }
  const affiliate = { creditForTopup: vi.fn().mockResolvedValue(undefined) }
  const service = new OrderService(db as any, affiliate as any, { defaultAffiliateRateBps: 1000 } as any)
  return { service, events, affiliate, walletLedger }
}

describe('wallet top-up promotion', () => {
  test('calculates exact wallet credit from the configured multiplier', () => {
    expect(topupCreditAmount(1000000n, 30000)).toBe(3000000n)
    expect(topupCreditAmount(1250000n, 15000)).toBe(1875000n)
    expect(() => topupCreditAmount(1000000n, 9999)).toThrow('充值倍率无效')
  })
})

describe('payment callback settlement', () => {
  test('keeps a mismatched callback as immutable rejected audit and acknowledges its duplicate', async () => {
    const { service, events } = callbackHarness()
    const payment = {
      provider: 'wechat' as const, eventId: 'evt-mismatch', orderNo: 'RSORDER1', transactionId: 'trade-1',
      status: 'paid' as const, amountFen: 2, currency: 'CNY',
    }

    await expect(service.applyVerifiedCallback(payment)).resolves.toEqual({ accepted: false, alreadyProcessed: false, orderId: 'order-1' })
    expect(events).toEqual([{
      provider: 'wechat', eventId: 'evt-mismatch', orderId: 'order-1',
      eventType: 'rejected_amount_or_provider_mismatch', verified: false,
    }])
    await expect(service.applyVerifiedCallback(payment)).resolves.toEqual({ accepted: false, alreadyProcessed: true, orderId: 'order-1' })
    expect(events).toHaveLength(1)
  })

  test('credits a valid callback once and requires a provider trade id', async () => {
    const { service, events, affiliate, walletLedger } = callbackHarness()
    const payment = {
      provider: 'wechat' as const, eventId: 'evt-paid', orderNo: 'RSORDER1', transactionId: 'trade-2',
      status: 'paid' as const, amountFen: 1, currency: 'CNY',
    }

    await expect(service.applyVerifiedCallback(payment)).resolves.toEqual({ accepted: true, alreadyProcessed: false, orderId: 'order-1' })
    await expect(service.applyVerifiedCallback(payment)).resolves.toEqual({ accepted: true, alreadyProcessed: true, orderId: 'order-1' })
    expect(events).toHaveLength(1)
    expect(affiliate.creditForTopup).toHaveBeenCalledTimes(1)
    expect(walletLedger[0]?.[1]).toBe('30000')
    expect(JSON.parse(String(walletLedger[0]?.[5]))).toMatchObject({ paidAmountMicros: '10000', creditedAmountMicros: '30000', topupMultiplierBps: 30000 })
    await expect(service.applyVerifiedCallback({ ...payment, eventId: 'evt-no-trade', transactionId: null })).rejects.toThrow('支付交易号缺失')
  })
})

describe('new order payment method', () => {
  test('defaults to and accepts WeChat only', () => {
    expect(normalizeNewOrderPaymentMethod(undefined)).toBe('wechat')
    expect(normalizeNewOrderPaymentMethod('wechat')).toBe('wechat')
    expect(() => normalizeNewOrderPaymentMethod('alipay')).toThrow('目前仅支持微信支付')
    expect(() => normalizeNewOrderPaymentMethod('card')).toThrow('目前仅支持微信支付')
  })
})

function reconciliationHarness(overrides: Record<string, unknown> = {}) {
  const order: any = {
    id: 'order-1', order_no: 'RSORDER1', user_id: 'user-1', kind: 'wallet_topup',
    status: 'paid', paid_amount_micros: '10000', amount_micros: '10000',
    topup_multiplier_bps: 30000, payment_provider: 'wechat_native', payment_method: 'wechat',
    provider_trade_id: 'trade-1', paid_at: new Date('2026-09-20T00:00:00Z'), wallet_credit_micros: null,
    ...overrides,
  }
  let walletBalance = '1000'
  let ledger: any = null
  let purchase: any = null
  const audits: unknown[][] = []
  const purchaseInserts: unknown[][] = []
  const client = {
    query: vi.fn(async (sql: string, values: any[] = []) => {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      if (normalized.startsWith('SELECT * FROM orders')) return result([order])
      if (normalized.startsWith('SELECT id,amount_micros FROM wallet_ledger')) return result(ledger ? [ledger] : [])
      if (normalized.startsWith('SELECT id FROM users')) return result([{ id: order.user_id }])
      if (normalized.startsWith('SELECT balance_micros FROM wallets')) return result([{ balance_micros: walletBalance }])
      if (normalized.startsWith('UPDATE wallets')) { walletBalance = String(values[0]); return result() }
      if (normalized.startsWith('INSERT INTO wallet_ledger')) {
        ledger = { id: 'ledger-1', amount_micros: String(values[1]), created_at: new Date('2026-09-20T00:01:00Z') }
        return result()
      }
      if (normalized.startsWith('UPDATE orders SET wallet_credit_micros')) { order.wallet_credit_micros = values[0]; return result() }
      if (normalized.startsWith('SELECT id FROM subscription_purchases')) return result(purchase ? [{ id: purchase.id }] : [])
      if (normalized.startsWith('SELECT id FROM plans')) return result([{ id: order.plan_id }])
      if (normalized.startsWith('SELECT * FROM subscriptions')) return result()
      if (normalized.startsWith('INSERT INTO subscriptions')) return result([{ id: 'subscription-1' }])
      if (normalized.startsWith('INSERT INTO subscription_purchases')) {
        purchaseInserts.push(values)
        purchase = { id: 'purchase-1', quota_added_micros: String(values[4]), amount_paid_micros: String(values[5]), created_at: new Date('2026-09-20T00:01:00Z') }
        return result()
      }
      if (normalized.startsWith('INSERT INTO subscription_ledger')) return result()
      if (normalized.startsWith('INSERT INTO admin_audit_events')) { audits.push(values); return result() }
      throw new Error(`unexpected SQL: ${normalized}`)
    }),
  }
  const db = {
    tx: async (action: (transaction: typeof client) => Promise<unknown>) => action(client),
    one: vi.fn(async () => ({
      ...order,
      credit_record_id: order.kind === 'wallet_topup' ? ledger?.id : purchase?.id,
      credited_amount_micros: order.kind === 'wallet_topup' ? ledger?.amount_micros : purchase?.quota_added_micros,
      credited_at: order.kind === 'wallet_topup' ? ledger?.created_at : purchase?.created_at,
      credited_paid_amount_micros: purchase?.amount_paid_micros,
    })),
    query: vi.fn(async () => []),
  }
  const affiliate = { creditForTopup: vi.fn().mockResolvedValue(undefined) }
  const service = new OrderService(db as any, affiliate as any, { defaultAffiliateRateBps: 1000 } as any)
  return { service, order, client, affiliate, audits, purchaseInserts, walletBalance: () => walletBalance, setLedger: (value: any) => { ledger = value } }
}

describe('paid order credit reconciliation', () => {
  test('repairs a missing wallet ledger once using the order multiplier snapshot', async () => {
    const h = reconciliationHarness()
    await expect(h.service.reconcileCredit('order-1', 'admin-1')).resolves.toMatchObject({ creditStatus: 'credited', creditedAmountMicros: '30000' })
    await expect(h.service.reconcileCredit('order-1', 'admin-1')).resolves.toMatchObject({ creditStatus: 'credited', creditedAmountMicros: '30000' })
    expect(h.walletBalance()).toBe('31000')
    expect(h.client.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO wallet_ledger'))).toHaveLength(1)
    expect(h.affiliate.creditForTopup).toHaveBeenCalledTimes(1)
    expect(h.audits).toHaveLength(1)
  })

  test('does not repair an unpaid order or one missing verified payment metadata', async () => {
    for (const overrides of [{ status: 'pending' }, { provider_trade_id: null }, { paid_amount_micros: null }]) {
      const h = reconciliationHarness(overrides)
      await h.service.reconcileCredit('order-1')
      expect(h.client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO wallet_ledger'))).toBe(false)
      expect(h.affiliate.creditForTopup).not.toHaveBeenCalled()
    }
  })

  test('keeps a mismatched wallet ledger inconsistent without adding credit', async () => {
    const h = reconciliationHarness({ wallet_credit_micros: '25000' })
    h.setLedger({ id: 'ledger-1', amount_micros: '25000', created_at: new Date() })
    await expect(h.service.reconcileCredit('order-1')).resolves.toMatchObject({ creditStatus: 'inconsistent', creditedAmountMicros: '25000' })
    expect(h.walletBalance()).toBe('1000')
    expect(h.audits).toHaveLength(0)
  })

  test('repairs a subscription from immutable order snapshots and remains idempotent', async () => {
    const h = reconciliationHarness({
      kind: 'subscription', plan_id: 'plan-1', plan_name_snapshot: '专业套餐',
      plan_quota_micros: '880000', plan_duration_days: 30,
    })
    await h.service.reconcileCredit('order-1')
    await expect(h.service.reconcileCredit('order-1')).resolves.toMatchObject({ creditStatus: 'credited', creditedAmountMicros: '880000' })
    expect(h.purchaseInserts).toHaveLength(1)
    expect(h.purchaseInserts[0]?.slice(2, 6)).toEqual(['plan-1', '专业套餐', '880000', '10000'])
    expect(h.audits).toHaveLength(1)
  })

  test('maps pending, credited and malformed paid states for the API', () => {
    const h = reconciliationHarness()
    expect(h.service.creditState({ status: 'pending' })).toMatchObject({ creditStatus: 'pending', creditMessage: '等待支付' })
    expect(h.service.creditState({ status: 'paid', kind: 'wallet_topup', paid_amount_micros: '10000', provider_trade_id: null })).toMatchObject({ creditStatus: 'inconsistent' })
    expect(h.service.creditState({ status: 'paid', kind: 'wallet_topup', paid_amount_micros: '10000', provider_trade_id: 'trade', topup_multiplier_bps: 30000, credit_record_id: 'ledger', credited_amount_micros: '30000', credited_at: new Date() })).toMatchObject({ creditStatus: 'credited', creditedAmountMicros: '30000' })
  })
})
