import type { PaymentConfig } from '../config.js'

/**
 * Headers accepted by payment callback verification.  Fastify exposes a
 * plain object while tests and other adapters commonly use `Headers`.
 */
export type PaymentHeaders =
  | Headers
  | Record<string, string | string[] | undefined>
  | Iterable<[string, string]>

export type PaymentProvider = 'wechat' | 'alipay'

export type PaymentRequestOptions = {
  /** Abort the provider request after this many milliseconds. */
  timeoutMs?: number
  /** Inject a fetch implementation for tests or an alternative HTTP stack. */
  fetch?: typeof globalThis.fetch
  /** Current time source, useful for deterministic signature tests. */
  now?: () => number
  /** Maximum accepted callback timestamp skew (WeChat only). */
  maxClockSkewSeconds?: number
  /** Skip WeChat callback freshness validation only in a controlled test. */
  enforceFreshness?: boolean
}

export type NativeOrderInput = {
  /** Optional provider selector used by the compatibility facade. */
  provider?: PaymentProvider
  paymentMethod?: PaymentProvider
  method?: PaymentProvider
  /** Merchant order number. It must be unique at the application level. */
  orderId: string
  /** Human-readable order description/subject. */
  description: string
  /** Amount in integer fen (recommended for payment calls). */
  amountFen?: number | bigint | string
  /** Alias for amountFen, retained for callers that use cents terminology. */
  amountCents?: number | bigint | string
  /** Amount in integer CNY micro-yuan, as used by the relay database. */
  amountMicros?: number | bigint | string
  /** Decimal CNY amount, e.g. `12.50`. */
  amountYuan?: number | string
  /** Generic amount: integer values are fen, decimal values are yuan. */
  amount?: number | bigint | string
  /** Optional callback override; defaults to the provider's configured URL. */
  notifyUrl?: string
  /** Optional expiry sent to providers that support it. */
  expiresAt?: Date | string
  /** Optional provider-specific metadata carried in the order where supported. */
  attach?: string
  /** Optional request abort signal. */
  signal?: AbortSignal
}

export type NativeOrderResult = {
  provider: PaymentProvider
  orderId: string
  /** WeChat's `code_url`; Alipay's `qr_code`. */
  codeUrl: string
  /** Alias useful to UIs that call this field qrCode. */
  qrCode: string
  /** Provider transaction/prepay identifier, when returned by the provider. */
  providerOrderId: string | null
  amountFen: number
  currency: 'CNY'
}

export type PaymentStatus = 'paid' | 'pending' | 'failed'

export type VerifiedPaymentCallback = {
  provider: PaymentProvider
  /** Provider event/notification id, suitable for idempotency storage. */
  eventId: string
  orderId: string
  transactionId: string | null
  status: PaymentStatus
  amountFen: number
  currency: string
  paidAt: string | null
  /** Provider status value, retained for audit/display but not raw payload. */
  providerStatus: string | null
  /** Optional buyer identifier; never contains credentials. */
  buyerId: string | null
}

export type PaymentGatewayOptions = PaymentRequestOptions & {
  /** Override key material in tests; production callers should use config paths. */
  wechatPlatformCertificate?: string
  wechatPrivateKey?: string
  alipayPrivateKey?: string
  alipayPublicKey?: string
}

export type PaymentGatewayConfig = PaymentConfig
