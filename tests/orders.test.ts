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
