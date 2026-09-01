import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PaymentConfigurationError, PaymentInputError, PaymentProviderError } from './errors.js'
import type { NativeOrderInput, PaymentHeaders, PaymentProvider, PaymentRequestOptions } from './types.js'

export const DEFAULT_PAYMENT_TIMEOUT_MS = 10_000
export const DEFAULT_WECHAT_CLOCK_SKEW_SECONDS = 300

export function headerValue(headers: PaymentHeaders | undefined, name: string): string {
  if (!headers) return ''
  const wanted = name.toLowerCase()
  if (typeof (headers as Headers).get === 'function') return String((headers as Headers).get(name) || '')
  if (typeof (headers as any)[Symbol.iterator] === 'function' && !Array.isArray(headers)) {
    for (const item of headers as Iterable<[string, string]>) {
      if (String(item[0]).toLowerCase() === wanted) return String(item[1] || '')
    }
  }
  const record = headers as Record<string, string | string[] | undefined>
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === wanted)
  const value = key ? record[key] : undefined
  return Array.isArray(value) ? String(value[0] || '') : String(value || '')
}

export function normalizePem(raw: string, kind: 'private' | 'public' = 'private'): string {
  const value = String(raw || '').trim()
  if (!value) return ''
  if (value.includes('-----BEGIN')) return value
  const compact = value.replace(/\s+/g, '')
  if (!compact) return ''
  const begin = kind === 'private' ? '-----BEGIN PRIVATE KEY-----' : '-----BEGIN PUBLIC KEY-----'
  const end = kind === 'private' ? '-----END PRIVATE KEY-----' : '-----END PUBLIC KEY-----'
  const lines = compact.match(/.{1,64}/g) || []
  return `${begin}\n${lines.join('\n')}\n${end}`
}

export function validatePrivateKey(raw: string, provider: PaymentProvider): KeyObject {
  try {
    return createPrivateKey(normalizePem(raw, 'private'))
  } catch (error) {
    throw new PaymentConfigurationError(provider, ['privateKeyPath'], '支付渠道私钥格式无效')
  }
}

export function validatePublicKey(raw: string, provider: PaymentProvider): KeyObject {
  try {
    return createPublicKey(normalizePem(raw, 'public'))
  } catch (error) {
    throw new PaymentConfigurationError(provider, ['publicKeyPath'], '支付渠道公钥格式无效')
  }
}

export async function readKeyMaterial(
  pathOrPem: string,
  provider: PaymentProvider,
  field: string,
  kind: 'private' | 'public' | 'certificate',
): Promise<string> {
  const configured = String(pathOrPem || '').trim()
  if (!configured) throw new PaymentConfigurationError(provider, [field])
  if (configured.includes('-----BEGIN')) return configured
  try {
    const value = await readFile(configured, 'utf8')
    if (!value.trim()) throw new Error('empty key')
    return value
  } catch (error) {
    throw new PaymentConfigurationError(provider, [field], '支付渠道密钥文件不可读')
  }
}

export function requireConfigured(provider: PaymentProvider, values: Record<string, unknown>): void {
  const missing = Object.entries(values)
    .filter(([, value]) => typeof value !== 'string' || !value.trim())
    .map(([name]) => name)
  if (missing.length) throw new PaymentConfigurationError(provider, missing)
}

export function asPositiveInteger(value: unknown, field: string): number {
  let parsed: bigint
  try {
    if (typeof value === 'bigint') parsed = value
    else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value)
    else if (typeof value === 'string' && /^\d+$/.test(value.trim())) parsed = BigInt(value.trim())
    else throw new Error('not integer')
  } catch {
    throw new PaymentInputError(`${field} 必须为正整数`)
  }
  if (parsed <= 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new PaymentInputError(`${field} 超出有效范围`)
  return Number(parsed)
}

export function yuanToFen(value: unknown): number {
  const text = String(value ?? '').trim()
  if (!/^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/.test(text)) throw new PaymentInputError('金额必须为非负、最多两位小数的人民币金额')
  const [yuan, fraction = ''] = text.split('.')
  const fen = BigInt(yuan) * 100n + BigInt((fraction + '00').slice(0, 2))
  if (fen <= 0n || fen > BigInt(Number.MAX_SAFE_INTEGER)) throw new PaymentInputError('金额超出有效范围')
  return Number(fen)
}

/** Resolve all supported amount aliases to integer fen without floating point arithmetic. */
export function amountToFen(input: NativeOrderInput): number {
  if (input.amountFen !== undefined) return asPositiveInteger(input.amountFen, 'amountFen')
  if (input.amountCents !== undefined) return asPositiveInteger(input.amountCents, 'amountCents')
  if (input.amountMicros !== undefined) {
    let micros: bigint
    try {
      micros = typeof input.amountMicros === 'bigint' ? input.amountMicros : BigInt(String(input.amountMicros))
    } catch { throw new PaymentInputError('amountMicros 必须为整数') }
    if (micros <= 0n || micros % 10_000n !== 0n) throw new PaymentInputError('amountMicros 必须按人民币分精确表示')
    const fen = micros / 10_000n
    if (fen > BigInt(Number.MAX_SAFE_INTEGER)) throw new PaymentInputError('金额超出有效范围')
    return Number(fen)
  }
  if (input.amountYuan !== undefined) return yuanToFen(input.amountYuan)
  if (input.amount !== undefined) {
    if (typeof input.amount === 'string' && input.amount.includes('.')) return yuanToFen(input.amount)
    if (typeof input.amount === 'number' && !Number.isInteger(input.amount)) return yuanToFen(input.amount)
    return asPositiveInteger(input.amount, 'amount')
  }
  throw new PaymentInputError('缺少支付金额')
}

export function fenToYuan(fen: number): string {
  const integer = Math.floor(fen / 100)
  const decimals = String(fen % 100).padStart(2, '0')
  return `${integer}.${decimals}`
}

export function cleanDescription(value: string): string {
  const description = String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, ' ')
  if (!description) throw new PaymentInputError('缺少订单描述')
  return description.slice(0, 127)
}

export function cleanOrderId(value: string): string {
  const orderId = String(value || '').trim()
  if (!/^[A-Za-z0-9_\-:.]{1,64}$/.test(orderId)) throw new PaymentInputError('订单号格式无效')
  return orderId
}

export function cleanNotifyUrl(value: string): string {
  const text = String(value || '').trim()
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('protocol')
    return url.toString()
  } catch {
    throw new PaymentInputError('支付回调地址无效')
  }
}

export function requestSignal(input: PaymentRequestOptions, external?: AbortSignal): AbortSignal | undefined {
  const timeoutMs = Number.isFinite(input.timeoutMs) && Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : DEFAULT_PAYMENT_TIMEOUT_MS
  const timeout = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
  if (!external) return timeout
  if (!timeout) return external
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([external, timeout])
  return external
}

export async function readJsonResponse(response: Response, provider: PaymentProvider): Promise<Record<string, any>> {
  const text = await response.text()
  let payload: unknown = null
  try { payload = text ? JSON.parse(text) : {} } catch {
    throw new PaymentProviderError(provider, '支付平台返回了无效响应', { httpStatus: response.status })
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PaymentProviderError(provider, '支付平台返回了无效响应', { httpStatus: response.status })
  }
  return payload as Record<string, any>
}

export function safeProviderMessage(payload: Record<string, any>, fallback: string): string {
  const value = payload.message || payload.sub_msg || payload.msg || payload.error_description
  const text = typeof value === 'string' ? value.trim() : ''
  return text ? text.slice(0, 200) : fallback
}

export function hashEventBody(rawBody: string | Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex')
}

export function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && ((error as any).name === 'AbortError' || (error as any).code === 'ABORT_ERR'))
}
