import { createSign, createVerify, randomUUID, type KeyObject } from 'node:crypto'
import type { PaymentConfig } from '../config.js'
import {
  PaymentConfigurationError,
  PaymentDecryptionError,
  PaymentInputError,
  PaymentProviderError,
  PaymentSignatureError,
} from './errors.js'
import {
  amountToFen,
  cleanDescription,
  cleanNotifyUrl,
  cleanOrderId,
  fenToYuan,
  hashEventBody,
  headerValue,
  isAbortError,
  normalizePem,
  readKeyMaterial,
  requestSignal,
  safeProviderMessage,
  validatePrivateKey,
  validatePublicKey,
  yuanToFen,
} from './utils.js'
import type {
  NativeOrderInput,
  NativeOrderResult,
  PaymentGatewayOptions,
  PaymentHeaders,
  PaymentRequestOptions,
  VerifiedPaymentCallback,
} from './types.js'

const PROVIDER = 'alipay' as const
const DEFAULT_GATEWAY = 'https://openapi.alipay.com/gateway.do'

type AlipaySettings = PaymentConfig['alipay'] & Record<string, unknown>

function settings(config: PaymentConfig): AlipaySettings {
  return (config?.alipay || {}) as AlipaySettings
}

function setting(config: PaymentConfig, camel: string, snake: string, fallback = ''): string {
  const value = settings(config)[camel] ?? settings(config)[snake]
  const result = typeof value === 'string' ? value.trim() : String(value ?? '').trim()
  return result || fallback
}

function isHttpOk(response: Response): boolean {
  const status = Number(response.status || 0)
  return typeof response.ok === 'boolean' ? response.ok : status >= 200 && status < 300
}

function canonicalParams(params: Record<string, unknown>): string {
  return Object.keys(params)
    .filter((key) => key !== 'sign' && key !== 'sign_type' && params[key] !== undefined && params[key] !== null && String(params[key]) !== '')
    .sort()
    .map((key) => `${key}=${String(params[key])}`)
    .join('&')
}

/** Canonical source used by Alipay RSA2 signatures (exported for tests/audits). */
export function buildAlipaySignContent(params: Record<string, unknown>): string {
  return canonicalParams(params)
}

function signParams(params: Record<string, unknown>, privateKey: string): string {
  return createSign('RSA-SHA256').update(canonicalParams(params)).sign(privateKey, 'base64')
}

function timestamp(now: () => number): string {
  const date = new Date(now())
  if (!Number.isFinite(date.getTime())) throw new PaymentInputError('支付时间源无效', PROVIDER)
  // Alipay expects Beijing local time without a timezone suffix. The server's
  // wall clock is UTC in many deployments, so derive the +08:00 representation.
  const beijing = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  return beijing.toISOString().slice(0, 19).replace('T', ' ')
}

function parseResponseText(raw: string): Record<string, any> {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object expected')
    return parsed as Record<string, any>
  } catch (error) {
    throw new PaymentProviderError(PROVIDER, '支付宝返回了无效响应', { cause: error })
  }
}

function flattenCallback(rawBody: string): Record<string, string> {
  const text = rawBody.trim()
  if (!text) throw new PaymentSignatureError(PROVIDER, '支付宝回调正文缺失')
  if (text.startsWith('{')) {
    try {
      const value = JSON.parse(text)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object expected')
      const result: Record<string, string> = {}
      for (const [key, item] of Object.entries(value)) {
        if (item !== undefined && item !== null) result[key] = typeof item === 'string' ? item : JSON.stringify(item)
      }
      return result
    } catch (error) {
      throw new PaymentSignatureError(PROVIDER, '支付宝回调正文格式无效')
    }
  }
  const result: Record<string, string> = {}
  try {
    const params = new URLSearchParams(text)
    for (const [key, value] of params.entries()) {
      // Duplicate scalar fields are ambiguous and can otherwise lead to a
      // different signed representation at different layers.
      if (Object.prototype.hasOwnProperty.call(result, key)) throw new Error('duplicate field')
      result[key] = value
    }
  } catch (error) {
    throw new PaymentSignatureError(PROVIDER, '支付宝回调正文格式无效')
  }
  return result
}

function parsePaidTime(value: unknown): string | null {
  const text = String(value || '').trim()
  if (!text) return null
  // Alipay timestamps are Beijing local time; append an explicit offset when
  // no timezone is included to avoid host-dependent interpretation.
  const source = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(' ', 'T')}+08:00` : text
  const parsed = Date.parse(source)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

/** Alipay face-to-face Native (trade.precreate) adapter. */
export class AlipayPaymentGateway {
  readonly provider = PROVIDER
  private privateKeyPromise?: Promise<string>
  private publicKeyPromise?: Promise<string>

  constructor(readonly config: PaymentConfig, readonly options: PaymentGatewayOptions = {}) {}

  private createSettings() {
    const appId = setting(this.config, 'appId', 'app_id')
    const privateKeyPath = setting(this.config, 'privateKeyPath', 'private_key')
    const gateway = setting(this.config, 'gateway', 'gateway', DEFAULT_GATEWAY)
    const notifyUrl = setting(this.config, 'notifyUrl', 'notify_url')
    return { appId, privateKeyPath, gateway, notifyUrl }
  }

  private callbackSettings() {
    const publicKeyPath = setting(this.config, 'publicKeyPath', 'public_key') || setting(this.config, 'publicKeyPath', 'alipay_public_key')
    const appId = setting(this.config, 'appId', 'app_id')
    return { publicKeyPath, appId }
  }

  private async privateKey(): Promise<string> {
    if (!this.privateKeyPromise) {
      const source = this.options.alipayPrivateKey || this.createSettings().privateKeyPath
      this.privateKeyPromise = readKeyMaterial(source, PROVIDER, 'privateKeyPath', 'private').then((pem) => {
        validatePrivateKey(pem, PROVIDER)
        return normalizePem(pem, 'private')
      })
    }
    return this.privateKeyPromise
  }

  private async publicKey(): Promise<string> {
    if (!this.publicKeyPromise) {
      const source = this.options.alipayPublicKey || this.callbackSettings().publicKeyPath
      this.publicKeyPromise = readKeyMaterial(source, PROVIDER, 'publicKeyPath', 'public').then((pem) => {
        validatePublicKey(pem, PROVIDER)
        return normalizePem(pem, 'public')
      })
    }
    return this.publicKeyPromise
  }

  private fetchImpl(): typeof globalThis.fetch {
    const fn = this.options.fetch || globalThis.fetch
    if (typeof fn !== 'function') throw new PaymentProviderError(PROVIDER, '当前运行环境不支持网络请求')
    return fn.bind(globalThis)
  }

  private nowMs(): number {
    return typeof this.options.now === 'function' ? Number(this.options.now()) : Date.now()
  }

  async createNativeOrder(input: NativeOrderInput): Promise<NativeOrderResult> {
    const { appId, privateKeyPath, gateway, notifyUrl } = this.createSettings()
    const missing: string[] = []
    if (!appId) missing.push('appId')
    if (!privateKeyPath && !this.options.alipayPrivateKey) missing.push('privateKeyPath')
    if (missing.length) throw new PaymentConfigurationError(PROVIDER, missing)
    let gatewayUrl: URL
    try {
      gatewayUrl = new URL(gateway)
      if (gatewayUrl.protocol !== 'https:' && gatewayUrl.protocol !== 'http:') throw new Error('protocol')
    } catch {
      throw new PaymentConfigurationError(PROVIDER, ['gateway'], '支付宝网关地址无效')
    }

    const orderId = cleanOrderId(input.orderId)
    const description = cleanDescription(input.description)
    const amountFen = amountToFen(input)
    const callback = cleanNotifyUrl(input.notifyUrl || notifyUrl)
    const bizContent: Record<string, string> = {
      out_trade_no: orderId,
      total_amount: fenToYuan(amountFen),
      subject: description,
      product_code: 'FACE_TO_FACE_PAYMENT',
    }
    if (input.expiresAt) {
      const expires = input.expiresAt instanceof Date ? input.expiresAt : new Date(input.expiresAt)
      if (!Number.isFinite(expires.getTime())) throw new PaymentInputError('expiresAt 格式无效', PROVIDER)
      const remainingSeconds = Math.max(1, Math.ceil((expires.getTime() - this.nowMs()) / 1000))
      // Alipay accepts e.g. `5m`; use seconds for short-lived orders.
      bizContent.timeout_express = `${remainingSeconds}s`
    }
    const params: Record<string, string> = {
      app_id: appId,
      method: 'alipay.trade.precreate',
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: timestamp(() => this.nowMs()),
      version: '1.0',
      notify_url: callback,
      biz_content: JSON.stringify(bizContent),
    }
    const privateKey = await this.privateKey()
    params.sign = signParams(params, privateKey)
    const encoded = new URLSearchParams(params).toString()
    let response: Response
    try {
      response = await this.fetchImpl()(gatewayUrl.toString(), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
          'User-Agent': 'RelayStation/1.0',
        },
        body: encoded,
        signal: requestSignal(this.options, input.signal),
      })
    } catch (error) {
      throw new PaymentProviderError(PROVIDER, isAbortError(error) ? '支付宝请求超时' : '支付宝请求失败', { cause: error })
    }
    let raw: string
    try { raw = await response.text() } catch (error) {
      throw new PaymentProviderError(PROVIDER, '支付宝返回读取失败', { httpStatus: response.status, cause: error })
    }
    const payload = parseResponseText(raw)
    const result = payload.alipay_trade_precreate_response
    if (!isHttpOk(response) || !result || String(result.code || '') !== '10000' || typeof result.qr_code !== 'string' || !result.qr_code.trim()) {
      throw new PaymentProviderError(PROVIDER, safeProviderMessage(result || payload, '支付宝创建订单失败'), { httpStatus: response.status })
    }
    const codeUrl = result.qr_code.trim()
    return {
      provider: PROVIDER,
      orderId,
      codeUrl,
      qrCode: codeUrl,
      providerOrderId: typeof result.trade_no === 'string' ? result.trade_no : null,
      amountFen,
      currency: 'CNY',
    }
  }

  async verifyCallback(headers: PaymentHeaders, rawBody: string | Buffer, _verifyOptions: Partial<PaymentRequestOptions> = {}): Promise<VerifiedPaymentCallback> {
    // `headers` is intentionally accepted for a common gateway interface. The
    // Alipay notify protocol carries all signed fields in the form body.
    void headers
    if (rawBody === undefined || rawBody === null) throw new PaymentSignatureError(PROVIDER, '支付宝回调正文缺失')
    const { publicKeyPath, appId } = this.callbackSettings()
    if (!publicKeyPath && !this.options.alipayPublicKey) throw new PaymentConfigurationError(PROVIDER, ['publicKeyPath'])
    const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody)
    const params = flattenCallback(body)
    const signature = String(params.sign || '').trim()
    const signType = String(params.sign_type || 'RSA2').trim().toUpperCase()
    if (!signature || signType !== 'RSA2') throw new PaymentSignatureError(PROVIDER, '支付宝回调签名缺失或算法不受支持')
    if (appId && params.app_id !== appId) throw new PaymentSignatureError(PROVIDER, '支付宝回调应用编号不匹配')
    const publicKey = await this.publicKey()
    const content = canonicalParams(params)
    let valid = false
    try { valid = createVerify('RSA-SHA256').update(content).verify(publicKey, signature, 'base64') } catch { valid = false }
    if (!valid) throw new PaymentSignatureError(PROVIDER)

    const orderId = String(params.out_trade_no || '').trim()
    if (!orderId) throw new PaymentDecryptionError(PROVIDER, '支付宝回调订单号缺失')
    let amountFen: number
    try { amountFen = yuanToFen(params.total_amount) } catch (error) {
      throw new PaymentDecryptionError(PROVIDER, '支付宝回调金额无效', error)
    }
    const providerStatus = params.trade_status ? String(params.trade_status) : null
    const status = providerStatus === 'TRADE_SUCCESS' || providerStatus === 'TRADE_FINISHED'
      ? 'paid'
      : providerStatus === 'TRADE_CLOSED' ? 'failed' : 'pending'
    const eventId = String(params.notify_id || params.trade_no || '').trim() || hashEventBody(body)
    const transactionId = params.trade_no ? String(params.trade_no) : null
    if (status === 'paid' && !transactionId) throw new PaymentDecryptionError(PROVIDER, '支付宝回调交易号缺失')
    return {
      provider: PROVIDER,
      eventId,
      orderId,
      transactionId,
      status,
      amountFen,
      currency: String(params.currency || 'CNY').toUpperCase(),
      paidAt: parsePaidTime(params.gmt_payment),
      providerStatus,
      buyerId: null,
    }
  }
}
