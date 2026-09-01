import type { PaymentConfig } from '../config.js'
import { AlipayPaymentGateway } from './alipay.js'
import { PaymentConfigurationError } from './errors.js'
import { WechatPaymentGateway } from './wechat.js'
import type {
  NativeOrderInput,
  NativeOrderResult,
  PaymentGatewayOptions,
  PaymentHeaders,
  PaymentProvider,
  VerifiedPaymentCallback,
} from './types.js'

export * from './alipay.js'
export * from './errors.js'
export * from './types.js'
export * from './utils.js'
export * from './wechat.js'
export { PaymentGateway as AutoPaymentGateway } from './gateway.js'

export type PaymentGatewayAdapter = WechatPaymentGateway | AlipayPaymentGateway

/**
 * Small provider-agnostic facade used by routes. It deliberately contains no
 * persistence or business rules, keeping payment callbacks easy to audit.
 */
export class PaymentGateway {
  readonly provider: PaymentProvider
  readonly adapter: PaymentGatewayAdapter

  constructor(provider: PaymentProvider, config: PaymentConfig, options?: PaymentGatewayOptions)
  constructor(config: PaymentConfig, provider: PaymentProvider, options?: PaymentGatewayOptions)
  constructor(providerOrConfig: PaymentProvider | PaymentConfig, configOrProvider: PaymentConfig | PaymentProvider, options: PaymentGatewayOptions = {}) {
    const provider = typeof providerOrConfig === 'string' ? providerOrConfig : configOrProvider as PaymentProvider
    const config = typeof providerOrConfig === 'string' ? configOrProvider as PaymentConfig : providerOrConfig
    if (provider !== 'wechat' && provider !== 'alipay') throw new PaymentConfigurationError(String(provider || 'unknown'), ['provider'], '不支持的支付渠道')
    this.provider = provider
    this.adapter = provider === 'wechat' ? new WechatPaymentGateway(config, options) : new AlipayPaymentGateway(config, options)
  }

  createNativeOrder(input: NativeOrderInput): Promise<NativeOrderResult> {
    return this.adapter.createNativeOrder(input)
  }

  verifyCallback(headers: PaymentHeaders, rawBody: string | Buffer, options: Partial<PaymentGatewayOptions> = {}): Promise<VerifiedPaymentCallback> {
    return this.adapter.verifyCallback(headers, rawBody, options)
  }
}

export function createPaymentGateway(provider: PaymentProvider, config: PaymentConfig, options: PaymentGatewayOptions = {}): PaymentGateway {
  return new PaymentGateway(provider, config, options)
}

export function createPaymentGateways(config: PaymentConfig, options: PaymentGatewayOptions = {}): {
  wechat: PaymentGateway
  alipay: PaymentGateway
} {
  return {
    wechat: new PaymentGateway('wechat', config, options),
    alipay: new PaymentGateway('alipay', config, options),
  }
}

// Naming aliases make adapter injection explicit at call sites without
// forcing the application to depend on concrete provider class names.
export const createPaymentAdapter = createPaymentGateway
export const createPaymentAdapters = createPaymentGateways
