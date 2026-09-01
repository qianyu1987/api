import {
  createDecipheriv,
  createSign,
  createVerify,
  randomBytes,
  X509Certificate,
  type KeyObject,
} from 'node:crypto'
import type { PaymentConfig } from '../config.js'
import {
  PaymentConfigurationError,
  PaymentDecryptionError,
  PaymentInputError,
  PaymentProviderError,
  PaymentSignatureError,
} from './errors.js'
import {
  DEFAULT_PAYMENT_TIMEOUT_MS,
  DEFAULT_WECHAT_CLOCK_SKEW_SECONDS,
  amountToFen,
  cleanDescription,
  cleanNotifyUrl,
  cleanOrderId,
  headerValue,
  isAbortError,
  normalizePem,
  readJsonResponse,
  readKeyMaterial,
  requestSignal,
  safeProviderMessage,
  validatePrivateKey,
  validatePublicKey,
} from './utils.js'
import type {
  NativeOrderInput,
  NativeOrderResult,
  PaymentGatewayOptions,
  PaymentHeaders,
  PaymentRequestOptions,
  VerifiedPaymentCallback,
} from './types.js'

const PROVIDER = 'wechat' as const
const API_BASE = 'https://api.mch.weixin.qq.com'
const NATIVE_PATH = '/v3/pay/transactions/native'

type WechatSettings = PaymentConfig['wechat'] & Record<string, unknown>

type CertificateMaterial = {
  publicKey: KeyObject
  serial: string | null
}

function settings(config: PaymentConfig): WechatSettings {
  return (config?.wechat || {}) as WechatSettings
}

function setting(config: PaymentConfig, camel: string, snake: string): string {
  const value = settings(config)[camel] ?? settings(config)[snake]
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim()
}

function normalizedSerial(value: unknown): string {
  return String(value || '').replace(/[^0-9a-f]/gi, '').toUpperCase()
}

function isHttpOk(response: Response): boolean {
  const status = Number(response.status || 0)
  return typeof response.ok === 'boolean' ? response.ok : status >= 200 && status < 300
}

function parseInnerObject(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PaymentDecryptionError(PROVIDER, '微信回调明文格式无效')
  return value as Record<string, any>
}

/**
 * WeChat Pay API v3 Native adapter. It performs no persistence; callers own
 * order binding, amount checks, and callback idempotency in PostgreSQL.
 */
export class WechatPaymentGateway {
  readonly provider = PROVIDER
  private privateKeyPromise?: Promise<string>
  private certificatePromise?: Promise<CertificateMaterial>

  constructor(readonly config: PaymentConfig, readonly options: PaymentGatewayOptions = {}) {}

  private createSettings() {
    const cfg = settings(this.config)
    const appId = setting(this.config, 'appId', 'app_id')
    const mchId = setting(this.config, 'mchId', 'mch_id')
    const merchantSerial = setting(this.config, 'merchantSerial', 'serial_no') || setting(this.config, 'merchantSerial', 'merchant_serial')
    const privateKeyPath = setting(this.config, 'privateKeyPath', 'private_key')
    const notifyUrl = setting(this.config, 'notifyUrl', 'notify_url')
    return { cfg, appId, mchId, merchantSerial, privateKeyPath, notifyUrl }
  }

  private callbackSettings() {
    const cfg = settings(this.config)
    const apiV3Key = setting(this.config, 'apiV3Key', 'api_v3_key')
    const platformCertificatePath = setting(this.config, 'platformCertificatePath', 'platform_certificate_path') || setting(this.config, 'platformCertificatePath', 'platform_cert_path')
    return { cfg, apiV3Key, platformCertificatePath }
  }

  private async privateKey(): Promise<string> {
    if (!this.privateKeyPromise) {
      const { privateKeyPath } = this.createSettings()
      const source = this.options.wechatPrivateKey || privateKeyPath
      this.privateKeyPromise = readKeyMaterial(source, PROVIDER, 'privateKeyPath', 'private').then((pem) => {
        validatePrivateKey(pem, PROVIDER)
        return normalizePem(pem, 'private')
      })
    }
    return this.privateKeyPromise
  }

  private async certificate(): Promise<CertificateMaterial> {
    if (!this.certificatePromise) {
      const { platformCertificatePath } = this.callbackSettings()
      const source = this.options.wechatPlatformCertificate || platformCertificatePath
      this.certificatePromise = readKeyMaterial(source, PROVIDER, 'platformCertificatePath', 'certificate').then((pem) => {
        try {
          if (pem.includes('-----BEGIN CERTIFICATE-----')) {
            const certificate = new X509Certificate(pem)
            return { publicKey: certificate.publicKey, serial: normalizedSerial(certificate.serialNumber) || null }
          }
          return { publicKey: validatePublicKey(pem, PROVIDER), serial: null }
        } catch (error) {
          throw new PaymentConfigurationError(PROVIDER, ['platformCertificatePath'], '微信平台证书格式无效')
        }
      })
    }
    return this.certificatePromise
  }

  private fetchImpl(): typeof globalThis.fetch {
    const fn = this.options.fetch || globalThis.fetch
    if (typeof fn !== 'function') throw new PaymentProviderError(PROVIDER, '当前运行环境不支持网络请求')
    return fn.bind(globalThis)
  }

  private nowMs(): number {
    return typeof this.options.now === 'function' ? Number(this.options.now()) : Date.now()
  }

  private authHeader(method: string, path: string, body: string, timestamp = Math.floor(this.nowMs() / 1000).toString(), nonce = randomBytes(16).toString('hex')): Promise<string> {
    return this.privateKey().then((privateKey) => {
      const message = `${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`
      const signature = createSign('RSA-SHA256').update(message).sign(privateKey, 'base64')
      const { mchId, merchantSerial } = this.createSettings()
      return `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${merchantSerial}",signature="${signature}"`
    })
  }

  async createNativeOrder(input: NativeOrderInput): Promise<NativeOrderResult> {
    const { appId, mchId, merchantSerial, notifyUrl } = this.createSettings()
    const { privateKeyPath } = this.createSettings()
    const apiV3Key = this.callbackSettings().apiV3Key
    // API v3 key is not needed for order creation, but checking it here catches
    // an incompletely provisioned channel before a user is charged.
    const missing: string[] = []
    if (!appId) missing.push('appId')
    if (!mchId) missing.push('mchId')
    if (!merchantSerial) missing.push('merchantSerial')
    if (!privateKeyPath && !this.options.wechatPrivateKey) missing.push('privateKeyPath')
    if (!apiV3Key) missing.push('apiV3Key')
    if (apiV3Key && Buffer.byteLength(apiV3Key, 'utf8') !== 32) throw new PaymentConfigurationError(PROVIDER, ['apiV3Key'], '微信 API v3 密钥必须为 32 字节')
    if (missing.length) throw new PaymentConfigurationError(PROVIDER, missing)

    const orderId = cleanOrderId(input.orderId)
    const description = cleanDescription(input.description)
    const amountFen = amountToFen(input)
    const callback = cleanNotifyUrl(input.notifyUrl || notifyUrl)
    const payload: Record<string, unknown> = {
      appid: appId,
      mchid: mchId,
      description,
      out_trade_no: orderId,
      notify_url: callback,
      amount: { total: amountFen, currency: 'CNY' },
    }
    if (input.attach) payload.attach = String(input.attach).slice(0, 127)
    if (input.expiresAt) {
      const date = input.expiresAt instanceof Date ? input.expiresAt : new Date(input.expiresAt)
      if (!Number.isFinite(date.getTime())) throw new PaymentInputError('expiresAt 格式无效', PROVIDER)
      payload.time_expire = date.toISOString().replace(/\.\d{3}Z$/, 'Z')
    }
    const body = JSON.stringify(payload)
    const fetchImpl = this.fetchImpl()
    let response: Response
    try {
      const authorization = await this.authHeader('POST', NATIVE_PATH, body)
      response = await fetchImpl(`${API_BASE}${NATIVE_PATH}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: authorization,
          'User-Agent': 'RelayStation/1.0',
        },
        body,
        signal: requestSignal(this.options, input.signal),
      })
    } catch (error) {
      if (error instanceof PaymentConfigurationError || error instanceof PaymentProviderError) throw error
      throw new PaymentProviderError(PROVIDER, isAbortError(error) ? '微信支付请求超时' : '微信支付请求失败', { cause: error })
    }

    let data: Record<string, any>
    try { data = await readJsonResponse(response, PROVIDER) } catch (error) {
      if (error instanceof PaymentProviderError) throw error
      throw new PaymentProviderError(PROVIDER, '微信支付返回了无效响应', { httpStatus: response.status, cause: error })
    }
    if (!isHttpOk(response) || typeof data.code_url !== 'string' || !data.code_url.trim()) {
      throw new PaymentProviderError(PROVIDER, safeProviderMessage(data, '微信支付创建订单失败'), { httpStatus: response.status })
    }
    const codeUrl = data.code_url.trim()
    return {
      provider: PROVIDER,
      orderId,
      codeUrl,
      qrCode: codeUrl,
      providerOrderId: typeof data.prepay_id === 'string' ? data.prepay_id : null,
      amountFen,
      currency: 'CNY',
    }
  }

  /** Verify WeChat's outer RSA signature, then decrypt and normalize the resource. */
  async verifyCallback(headers: PaymentHeaders, rawBody: string | Buffer, verifyOptions: Partial<PaymentRequestOptions> = {}): Promise<VerifiedPaymentCallback> {
    const { apiV3Key } = this.callbackSettings()
    const { platformCertificatePath } = this.callbackSettings()
    const missing: string[] = []
    if (!apiV3Key) missing.push('apiV3Key')
    if (!platformCertificatePath && !this.options.wechatPlatformCertificate) missing.push('platformCertificatePath')
    if (apiV3Key && Buffer.byteLength(apiV3Key, 'utf8') !== 32) throw new PaymentConfigurationError(PROVIDER, ['apiV3Key'], '微信 API v3 密钥必须为 32 字节')
    if (missing.length) throw new PaymentConfigurationError(PROVIDER, missing)
    if (rawBody === undefined || rawBody === null) throw new PaymentSignatureError(PROVIDER, '微信回调正文缺失')

    const timestampText = headerValue(headers, 'wechatpay-timestamp')
    const nonce = headerValue(headers, 'wechatpay-nonce')
    const signature = headerValue(headers, 'wechatpay-signature')
    const serial = headerValue(headers, 'wechatpay-serial')
    if (!/^\d{10}$/.test(timestampText) || !nonce || !signature || !serial) throw new PaymentSignatureError(PROVIDER, '微信回调签名头缺失')

    const now = typeof verifyOptions.now === 'function' ? Number(verifyOptions.now()) : this.nowMs()
    const maxSkew = Number.isFinite(verifyOptions.maxClockSkewSeconds) ? Number(verifyOptions.maxClockSkewSeconds) : DEFAULT_WECHAT_CLOCK_SKEW_SECONDS
    const enforceFreshness = verifyOptions.enforceFreshness ?? this.options.enforceFreshness ?? true
    if (enforceFreshness && Math.abs(Math.floor(now / 1000) - Number(timestampText)) > maxSkew) throw new PaymentSignatureError(PROVIDER, '微信回调已过期')

    const certificate = await this.certificate()
    if (certificate.serial && normalizedSerial(serial) !== certificate.serial) throw new PaymentSignatureError(PROVIDER, '微信回调证书序列号不匹配')
    const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody)
    const signedMessage = `${timestampText}\n${nonce}\n${body}\n`
    let valid = false
    try { valid = createVerify('RSA-SHA256').update(signedMessage).verify(certificate.publicKey, signature, 'base64') } catch { valid = false }
    if (!valid) throw new PaymentSignatureError(PROVIDER)

    let envelope: Record<string, any>
    try {
      const parsed = JSON.parse(body)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object expected')
      envelope = parsed
    } catch (error) {
      throw new PaymentDecryptionError(PROVIDER, '微信回调正文不是有效 JSON', error)
    }
    const eventId = typeof envelope.id === 'string' ? envelope.id.trim() : ''
    if (!eventId) throw new PaymentDecryptionError(PROVIDER, '微信回调事件编号缺失')
    const resource = envelope.resource
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) throw new PaymentDecryptionError(PROVIDER, '微信回调加密资源缺失')
    if (String(resource.algorithm || '').toUpperCase() !== 'AEAD_AES_256_GCM') throw new PaymentDecryptionError(PROVIDER, '微信回调加密算法不受支持')

    let plaintext: string
    try {
      const key = Buffer.from(apiV3Key, 'utf8')
      const nonceBytes = Buffer.from(String(resource.nonce || ''), 'utf8')
      const ciphertext = Buffer.from(String(resource.ciphertext || ''), 'base64')
      if (key.length !== 32 || nonceBytes.length < 8 || nonceBytes.length > 16 || ciphertext.length <= 16) throw new Error('invalid encrypted resource')
      const encrypted = ciphertext.subarray(0, ciphertext.length - 16)
      const authTag = ciphertext.subarray(ciphertext.length - 16)
      const decipher = createDecipheriv('aes-256-gcm', key, nonceBytes)
      decipher.setAAD(Buffer.from(String(resource.associated_data || ''), 'utf8'))
      decipher.setAuthTag(authTag)
      plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
    } catch (error) {
      throw new PaymentDecryptionError(PROVIDER, '微信回调资源解密失败', error)
    }

    let detail: Record<string, any>
    try { detail = parseInnerObject(JSON.parse(plaintext)) } catch (error) {
      if (error instanceof PaymentDecryptionError) throw error
      throw new PaymentDecryptionError(PROVIDER, '微信回调明文不是有效 JSON', error)
    }
    const orderId = String(detail.out_trade_no || '').trim()
    if (!orderId) throw new PaymentDecryptionError(PROVIDER, '微信回调订单号缺失')
    const transactionId = detail.transaction_id ? String(detail.transaction_id) : null
    const amountValue = detail.amount && typeof detail.amount === 'object' ? detail.amount.total : undefined
    let amountFen = 0
    try {
      if (amountValue !== undefined) amountFen = Number(BigInt(String(amountValue)))
      if (!Number.isSafeInteger(amountFen) || amountFen <= 0) throw new Error('invalid amount')
    } catch (error) {
      throw new PaymentDecryptionError(PROVIDER, '微信回调金额无效', error)
    }
    const providerStatus = detail.trade_state ? String(detail.trade_state) : (envelope.event_type ? String(envelope.event_type) : null)
    const isPaid = providerStatus === 'SUCCESS' || String(envelope.event_type || '').toUpperCase() === 'TRANSACTION.SUCCESS'
    const status = isPaid ? 'paid' : /CLOSED|REVOKED|PAYERROR|REFUND|FAIL/i.test(providerStatus || '') ? 'failed' : 'pending'
    if (status === 'paid' && !transactionId) throw new PaymentDecryptionError(PROVIDER, '微信回调交易号缺失')
    const currency = String(detail.amount?.currency || 'CNY').toUpperCase()
    if (currency !== 'CNY') throw new PaymentDecryptionError(PROVIDER, '微信回调币种不是人民币')
    const paidAtRaw = detail.success_time || detail.successTime
    const paidAt = paidAtRaw && Number.isFinite(Date.parse(String(paidAtRaw))) ? new Date(String(paidAtRaw)).toISOString() : null
    return {
      provider: PROVIDER,
      eventId,
      orderId,
      transactionId,
      status,
      amountFen,
      currency,
      paidAt,
      providerStatus,
      buyerId: null,
    }
  }
}
