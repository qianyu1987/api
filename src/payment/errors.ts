export class PaymentError extends Error {
  readonly provider: string
  readonly code: string
  readonly statusCode: number

  constructor(message: string, options: { provider?: string; code?: string; statusCode?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = new.target.name
    this.provider = options.provider || 'unknown'
    this.code = options.code || 'payment_error'
    this.statusCode = options.statusCode || 502
  }
}

/** Configuration is deliberately reported without including key material. */
export class PaymentConfigurationError extends PaymentError {
  readonly missing: readonly string[]

  constructor(provider: string, missing: string[] | string, message = '支付渠道未配置完整') {
    const fields = Array.isArray(missing) ? missing : [missing]
    super(message, { provider, code: 'payment_configuration', statusCode: 503 })
    this.missing = Object.freeze([...fields])
  }
}

export class PaymentInputError extends PaymentError {
  constructor(message: string, provider = 'unknown') {
    super(message, { provider, code: 'payment_input', statusCode: 400 })
  }
}

export class PaymentSignatureError extends PaymentError {
  constructor(provider: string, message = '支付回调签名无效') {
    super(message, { provider, code: 'payment_signature_invalid', statusCode: 400 })
  }
}

export class PaymentDecryptionError extends PaymentError {
  constructor(provider: string, message = '支付回调解密失败', cause?: unknown) {
    super(message, { provider, code: 'payment_decryption_failed', statusCode: 400, cause })
  }
}

export class PaymentProviderError extends PaymentError {
  readonly httpStatus: number | null

  constructor(provider: string, message: string, options: { httpStatus?: number; cause?: unknown } = {}) {
    super(message, { provider, code: 'payment_provider_error', statusCode: 502, cause: options.cause })
    this.httpStatus = Number.isInteger(options.httpStatus) ? Number(options.httpStatus) : null
  }
}

