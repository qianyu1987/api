import { createCipheriv, createSign, createVerify, generateKeyPairSync } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import type { PaymentConfig } from '../src/config.js'
import { AlipayPaymentGateway, buildAlipaySignContent } from '../src/payment/alipay.js'
import { PaymentDecryptionError, PaymentSignatureError } from '../src/payment/errors.js'
import { amountToFen, fenToYuan, yuanToFen } from '../src/payment/utils.js'
import { WechatPaymentGateway } from '../src/payment/wechat.js'

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()

function paymentConfig(): PaymentConfig {
  return {
    wechat: {
      appId: 'wx-local',
      mchId: 'merchant-local',
      merchantSerial: 'merchant-serial',
      privateKeyPath: '',
      apiV3Key: '0123456789abcdef0123456789abcdef',
      platformCertificatePath: '',
      notifyUrl: 'https://relay.example/api/payments/wechat/notify',
    },
    alipay: {
      appId: 'app-local',
      privateKeyPath: '',
      publicKeyPath: '',
      gateway: 'https://openapi.alipay.test/gateway.do',
      notifyUrl: 'https://relay.example/api/payments/alipay/notify',
    },
  }
}

function signedAlipayBody(overrides: Record<string, string> = {}): string {
  const params: Record<string, string> = {
    notify_id: 'notify-local-1',
    app_id: 'app-local',
    out_trade_no: 'RS202609010001',
    trade_no: 'ALI202609010001',
    trade_status: 'TRADE_SUCCESS',
    total_amount: '12.34',
    gmt_payment: '2026-09-01 10:20:30',
    sign_type: 'RSA2',
    ...overrides,
  }
  params.sign = createSign('RSA-SHA256')
    .update(buildAlipaySignContent(params))
    .sign(privateKey, 'base64')
  return new URLSearchParams(params).toString()
}

function encryptedWechatEnvelope(detail: Record<string, unknown>): string {
  const apiV3Key = Buffer.from(paymentConfig().wechat.apiV3Key, 'utf8')
  const nonce = Buffer.from('localnonce12', 'utf8')
  const associatedData = 'transaction'
  const cipher = createCipheriv('aes-256-gcm', apiV3Key, nonce)
  cipher.setAAD(Buffer.from(associatedData, 'utf8'))
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(detail), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  return JSON.stringify({
    id: 'wechat-event-local-1',
    event_type: 'TRANSACTION.SUCCESS',
    resource: {
      algorithm: 'AEAD_AES_256_GCM',
      ciphertext: encrypted.toString('base64'),
      nonce: nonce.toString('utf8'),
      associated_data: associatedData,
    },
  })
}

describe('payment amount conversion', () => {
  test('converts every supported amount form without float rounding', () => {
    expect(yuanToFen('12.34')).toBe(1234)
    expect(fenToYuan(1234)).toBe('12.34')
    expect(amountToFen({ orderId: 'o', description: 'd', amountMicros: 12_340_000n })).toBe(1234)
    expect(amountToFen({ orderId: 'o', description: 'd', amountYuan: '0.01' })).toBe(1)
  })

  test('rejects fractional fen and non-positive amounts', () => {
    expect(() => amountToFen({ orderId: 'o', description: 'd', amountMicros: 10_001n })).toThrow()
    expect(() => yuanToFen('1.001')).toThrow()
    expect(() => yuanToFen('0')).toThrow()
  })
})

describe('Alipay callback verification', () => {
  const gateway = new AlipayPaymentGateway(paymentConfig(), { alipayPublicKey: publicKey })

  test('verifies RSA2 before normalizing a paid callback amount', async () => {
    await expect(gateway.verifyCallback({}, signedAlipayBody())).resolves.toMatchObject({
      provider: 'alipay',
      eventId: 'notify-local-1',
      orderId: 'RS202609010001',
      transactionId: 'ALI202609010001',
      status: 'paid',
      amountFen: 1234,
      currency: 'CNY',
      paidAt: '2026-09-01T02:20:30.000Z',
    })
  })

  test('rejects a callback whose signed amount was changed', async () => {
    const valid = signedAlipayBody()
    const tampered = valid.replace('total_amount=12.34', 'total_amount=12.35')
    await expect(gateway.verifyCallback({}, tampered)).rejects.toBeInstanceOf(PaymentSignatureError)
  })

  test('rejects a correctly signed but invalid amount', async () => {
    await expect(gateway.verifyCallback({}, signedAlipayBody({ total_amount: '1.001' })))
      .rejects.toBeInstanceOf(PaymentDecryptionError)
  })

  test('requires the configured app id even when a callback omits it', async () => {
    await expect(gateway.verifyCallback({}, signedAlipayBody({ app_id: '' })))
      .rejects.toBeInstanceOf(PaymentSignatureError)
  })

  test('requires a provider transaction id for a paid callback', async () => {
    await expect(gateway.verifyCallback({}, signedAlipayBody({ trade_no: '' })))
      .rejects.toBeInstanceOf(PaymentDecryptionError)
  })
})

describe('Alipay native order signing', () => {
  test('includes sign_type in the outbound RSA2 signature', async () => {
    let submitted: Record<string, string> | undefined
    const gateway = new AlipayPaymentGateway(paymentConfig(), {
      alipayPrivateKey: privateKey,
      now: () => Date.parse('2026-09-01T02:20:30.000Z'),
      fetch: async (_url, init) => {
        submitted = Object.fromEntries(new URLSearchParams(String(init?.body || '')))
        return new Response(JSON.stringify({
          alipay_trade_precreate_response: { code: '10000', qr_code: 'https://qr.example/payment' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })

    await gateway.createNativeOrder({ orderId: 'RS202609010003', description: 'Relay wallet', amountYuan: '20.00' })
    expect(submitted).toBeDefined()
    const params = submitted!
    expect(params.sign_type).toBe('RSA2')
    const source = Object.keys(params)
      .filter((key) => key !== 'sign' && params[key] !== undefined && params[key] !== '')
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join('&')
    expect(createVerify('RSA-SHA256').update(source).verify(publicKey, params.sign, 'base64')).toBe(true)
  })
})

describe('WeChat callback verification', () => {
  const nowMs = Date.parse('2026-09-01T02:20:30.000Z')
  const gateway = new WechatPaymentGateway(paymentConfig(), {
    wechatPlatformCertificate: publicKey,
    now: () => nowMs,
  })

  function signedCallback(overrides: Record<string, unknown> = {}) {
    const body = encryptedWechatEnvelope({
      out_trade_no: 'RS202609010002',
      transaction_id: 'WX202609010002',
      trade_state: 'SUCCESS',
      amount: { total: 5678, currency: 'CNY' },
      success_time: '2026-09-01T10:20:30+08:00',
      ...overrides,
    })
    const timestamp = String(Math.floor(nowMs / 1000))
    const nonce = 'signature-nonce'
    const signature = createSign('RSA-SHA256')
      .update(`${timestamp}\n${nonce}\n${body}\n`)
      .sign(privateKey, 'base64')
    return {
      body,
      headers: {
        'wechatpay-timestamp': timestamp,
        'wechatpay-nonce': nonce,
        'wechatpay-signature': signature,
        'wechatpay-serial': 'LOCAL',
      },
    }
  }

  test('verifies the outer signature and decrypts the exact integer amount', async () => {
    const callback = signedCallback()
    await expect(gateway.verifyCallback(callback.headers, callback.body)).resolves.toMatchObject({
      provider: 'wechat',
      eventId: 'wechat-event-local-1',
      orderId: 'RS202609010002',
      transactionId: 'WX202609010002',
      status: 'paid',
      amountFen: 5678,
      currency: 'CNY',
      paidAt: '2026-09-01T02:20:30.000Z',
    })
  })

  test('rejects any body change made after signing', async () => {
    const callback = signedCallback()
    const tampered = callback.body.replace('wechat-event-local-1', 'wechat-event-local-2')
    await expect(gateway.verifyCallback(callback.headers, tampered)).rejects.toBeInstanceOf(PaymentSignatureError)
  })

  test('requires a transaction id for a signed successful callback', async () => {
    const callback = signedCallback({ transaction_id: '' })
    await expect(gateway.verifyCallback(callback.headers, callback.body)).rejects.toBeInstanceOf(PaymentDecryptionError)
  })
})
