import type { AppConfig, PaymentConfig } from '../config.js'
import { AlipayPaymentGateway } from './alipay.js'
import { PaymentConfigurationError } from './errors.js'
import type { NativeOrderInput, NativeOrderResult, PaymentGatewayOptions, PaymentHeaders, PaymentProvider, VerifiedPaymentCallback } from './types.js'
import { WechatPaymentGateway } from './wechat.js'

/**
 * Compatibility facade for the application service. It keeps both provider
 * adapters available and chooses one from `provider`/`paymentMethod` on the
 * input; when omitted, WeChat is preferred if configured, then Alipay.
 */
export class PaymentGateway {
  readonly paymentConfig: PaymentConfig
  readonly wechat: WechatPaymentGateway
  readonly alipay: AlipayPaymentGateway

  constructor(readonly config: PaymentConfig | AppConfig, readonly options: PaymentGatewayOptions = {}) {
    this.paymentConfig = ('payments' in config ? config.payments : config) as PaymentConfig
    this.wechat = new WechatPaymentGateway(this.paymentConfig, options)
    this.alipay = new AlipayPaymentGateway(this.paymentConfig, options)
  }

  private select(input?: Partial<NativeOrderInput> & { provider?: PaymentProvider; paymentMethod?: PaymentProvider; method?: PaymentProvider }): WechatPaymentGateway | AlipayPaymentGateway {
    const requested = input?.provider || input?.paymentMethod || input?.method
    if (requested === 'wechat') return this.wechat
    if (requested === 'alipay') return this.alipay
    const wc = this.paymentConfig.wechat as any
    const ali = this.paymentConfig.alipay as any
    if (wc && (wc.appId || wc.app_id || wc.mchId || wc.mch_id)) return this.wechat
    if (ali && (ali.appId || ali.app_id)) return this.alipay
    throw new PaymentConfigurationError('payment', ['provider'], '未配置可用的支付渠道')
  }

  createNativeOrder(input: NativeOrderInput & { provider?: PaymentProvider; paymentMethod?: PaymentProvider; method?: PaymentProvider }): Promise<NativeOrderResult> {
    return this.select(input).createNativeOrder(input)
  }

  /** Provider can be supplied explicitly, or inferred from `headers.provider`. */
  verifyCallback(provider: PaymentProvider, headers: PaymentHeaders, rawBody: string | Buffer, options?: Partial<PaymentGatewayOptions>): Promise<VerifiedPaymentCallback>
  verifyCallback(headers: PaymentHeaders, rawBody: string | Buffer, options?: Partial<PaymentGatewayOptions>): Promise<VerifiedPaymentCallback>
  verifyCallback(providerOrHeaders: PaymentProvider | PaymentHeaders, headersOrBody: PaymentHeaders | string | Buffer, bodyOrOptions?: string | Buffer | Partial<PaymentGatewayOptions>, options: Partial<PaymentGatewayOptions> = {}): Promise<VerifiedPaymentCallback> {
    if (typeof providerOrHeaders === 'string') {
      const provider = providerOrHeaders
      const headers = headersOrBody as PaymentHeaders
      const body = bodyOrOptions as string | Buffer
      if (provider === 'wechat') return this.wechat.verifyCallback(headers, body, options)
      if (provider === 'alipay') return this.alipay.verifyCallback(headers, body, options)
      throw new PaymentConfigurationError(String(provider), ['provider'], '不支持的支付渠道')
    }
    const headers = providerOrHeaders
    const body = headersOrBody as string | Buffer
    const maybe = bodyOrOptions && typeof bodyOrOptions === 'object' && !Buffer.isBuffer(bodyOrOptions) ? bodyOrOptions as Partial<PaymentGatewayOptions> : undefined
    const provider = (maybe as any)?.provider as PaymentProvider | undefined
    return this.select(provider ? { provider } : undefined).verifyCallback(headers, body, maybe || options)
  }
}

export default PaymentGateway
