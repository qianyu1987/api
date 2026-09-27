import { ceilDiv } from '../lib/money.js'
import { ENTERPRISE_TOPUP_MULTIPLIER_BPS } from '../config.js'

export type PricingRules = {
  minimumMarginBps: number
  paymentFeeRateBps: number
  affiliateRateBps: number
  walletTopupMultiplierBps: number
}

export type PricingPreviewModel = {
  model: string
  channels: Array<{ channelId: string; channelName: string; source: string | null }>
  standardInputCostMicrosPerMillion: string
  standardOutputCostMicrosPerMillion: string
  standardCacheCostMicrosPerMillion: string
  highContextInputCostMicrosPerMillion: string
  highContextOutputCostMicrosPerMillion: string
  highContextCacheCostMicrosPerMillion: string
  inputCostMicrosPerMillion: string
  outputCostMicrosPerMillion: string
  cacheCostMicrosPerMillion: string
  inputSellMicrosPerMillion: string
  outputSellMicrosPerMillion: string
  cacheSellMicrosPerMillion: string
  sources: string[]
  existingPrice: any | null
}

export type PricingPreview = {
  ready: boolean
  rules: PricingRules
  models: PricingPreviewModel[]
  blockers: Array<{ kind: string; model: string; channelId?: string; channelName?: string; message: string }>
}

function nonNegativeRate(value: unknown, fallback = 0): bigint {
  const text = String(value ?? fallback)
  return /^\d+$/.test(text) ? BigInt(text) : BigInt(fallback)
}

export function worstWalletTopupMultiplier(...values: unknown[]): number {
  const valid = values
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 10_000 && value <= 100_000)
  return Math.max(ENTERPRISE_TOPUP_MULTIPLIER_BPS, ...valid)
}

export function retainedCashBps(rules: PricingRules): bigint {
  const retained = 10_000 - rules.minimumMarginBps - rules.paymentFeeRateBps - rules.affiliateRateBps
  if (!Number.isInteger(retained) || retained <= 0) throw new Error('利润、支付费和返利比例合计必须低于 100%')
  return BigInt(retained)
}

/** Wallet credit price needed to retain the target cash margin after the worst available top-up ratio and deductions. */
export function requiredWalletSell(costMicros: bigint, rules: PricingRules): bigint {
  if (costMicros < 0n) throw new Error('成本不能为负数')
  const multiplier = worstWalletTopupMultiplier(rules.walletTopupMultiplierBps)
  return ceilDiv(costMicros * BigInt(multiplier), retainedCashBps(rules))
}

export function normalizePricingRules(input: Partial<PricingRules> & { walletTopupMultiplierBps?: number }): PricingRules {
  const rules: PricingRules = {
    minimumMarginBps: Number(input.minimumMarginBps ?? 5000),
    paymentFeeRateBps: Number(input.paymentFeeRateBps ?? 0),
    affiliateRateBps: Number(input.affiliateRateBps ?? 1000),
    walletTopupMultiplierBps: worstWalletTopupMultiplier(input.walletTopupMultiplierBps),
  }
  for (const [name, value] of Object.entries(rules)) {
    if (!Number.isInteger(value) || value < 0 || value > (name === 'walletTopupMultiplierBps' ? 100000 : 9999)) throw new Error(`${name} 配置无效`)
  }
  return rules
}

function routeModels(row: any): string[] {
  const map = row?.model_map && typeof row.model_map === 'object' && !Array.isArray(row.model_map) ? Object.keys(row.model_map) : []
  const tableModel = row?.requested_model ? [String(row.requested_model)] : []
  return [...new Set([...map, ...tableModel].map((value) => String(value).trim()).filter(Boolean))]
}

function isMapped(row: any, model: string): boolean {
  return routeModels(row).includes(model) || routeModels(row).includes('*')
}

function costFor(costRows: any[], channelId: string, model: string): any | null {
  return costRows
    .filter((row) => String(row.channel_id) === channelId && (String(row.model_pattern) === model || String(row.model_pattern) === '*'))
    .filter((row) => row.price_effective_at == null || new Date(row.price_effective_at).getTime() <= Date.now())
    .sort((a, b) => Number(b.model_pattern === model) - Number(a.model_pattern === model))[0] || null
}

function scaledCost(value: bigint, multiplierBps: unknown): bigint {
  const multiplier = Number(multiplierBps ?? 10_000)
  if (!Number.isInteger(multiplier) || multiplier < 10_000 || multiplier > 110_000) return value
  return ceilDiv(value * BigInt(multiplier), 10_000n)
}

function priceRate(row: any, part: string, kind: 'cost' | 'sell'): bigint {
  return nonNegativeRate(row?.[`${part}_${kind}_micros_per_million`] ?? row?.[`${part}_${kind}_micros`])
}

type RoutedCosts = {
  routes: any[]
  usable: Array<{ route: any; cost: any; source: string }>
  standard: Record<'input' | 'output' | 'cache', bigint>
  high: Record<'input' | 'output' | 'cache', bigint>
  blockers: PricingPreview['blockers']
}

function routedCosts(channels: any[], costRows: any[], model: string, modelPrice?: any): RoutedCosts {
  const routes = channels.filter((row) => row.enabled !== false && row.deleted_at == null && isMapped(row, model))
  const blockers: PricingPreview['blockers'] = []
  if (!routes.length) blockers.push({ kind: 'no_route', model, message: `${model} 没有启用的上游渠道映射` })
  const usable: RoutedCosts['usable'] = []
  for (const route of routes) {
    const cost = costFor(costRows, String(route.id), model)
    const source = cost?.price_source == null ? '' : String(cost.price_source).trim()
    if (!cost || !source) {
      blockers.push({ kind: 'cost_missing', model, channelId: String(route.id), channelName: String(route.name), message: `${route.name} / ${model} 缺少有来源的输入、输出、缓存成本` })
      if (!cost) continue
    }
    usable.push({ route, cost, source })
  }
  const parts = ['input', 'output', 'cache'] as const
  const standard = Object.fromEntries(parts.map((part) => [part, priceRate(modelPrice, part, 'cost')])) as RoutedCosts['standard']
  const high = { ...standard }
  for (const item of usable) for (const part of parts) {
    const value = nonNegativeRate(item.cost[`${part}_cost_micros_per_million`])
    if (value > standard[part]) standard[part] = value
    const scaled = scaledCost(value, item.cost.high_context_multiplier_bps)
    if (scaled > high[part]) high[part] = scaled
  }
  for (const part of parts) if (standard[part] > high[part]) high[part] = standard[part]
  return { routes, usable, standard, high, blockers }
}

/**
 * Replace each active model's accounting cost with the highest applicable
 * standard/272K+ cost across every enabled route. Selling rates are preserved.
 */
export function buildMarginPriceRows(input: { channels: any[]; prices: any[]; costs: any[] }): { rows: any[]; blockers: PricingPreview['blockers'] } {
  const blockers: PricingPreview['blockers'] = []
  const rows = input.prices.filter((row) => row.active !== false).map((price) => {
    const model = String(price.model_pattern)
    const coverage = routedCosts(input.channels, input.costs, model, price)
    blockers.push(...coverage.blockers)
    const patched: any = { ...price }
    for (const part of ['input', 'output', 'cache'] as const) {
      patched[`${part}_cost_micros`] = coverage.high[part].toString()
      patched[`${part}_cost_micros_per_million`] = coverage.high[part].toString()
    }
    if (Array.isArray(price.pricing_tiers)) patched.pricing_tiers = price.pricing_tiers.map((tier: any) => ({
      ...tier,
      inputCostMicrosPerMillion: coverage.high.input.toString(),
      outputCostMicrosPerMillion: coverage.high.output.toString(),
      cacheCostMicrosPerMillion: coverage.high.cache.toString(),
    }))
    return patched
  })
  return { rows, blockers }
}

/** Build a conservative price preview from every enabled channel that can serve each model. */
export function buildPricingPreview(input: { channels: any[]; prices: any[]; costs: any[]; rules: PricingRules }): PricingPreview {
  const models = [...new Set([
    ...input.prices.filter((row) => row.active !== false).map((row) => String(row.model_pattern)),
    ...input.channels.flatMap(routeModels),
  ])].filter((model) => model && model !== '*').sort()
  const blockers: PricingPreview['blockers'] = []
  const previewModels: PricingPreviewModel[] = []

  for (const model of models) {
    const modelPrice = input.prices.find((row) => String(row.model_pattern) === model) || null
    const coverage = routedCosts(input.channels, input.costs, model, modelPrice)
    blockers.push(...coverage.blockers)
    if (!coverage.routes.length || coverage.usable.length !== coverage.routes.length) continue
    const inputCost = coverage.high.input; const outputCost = coverage.high.output; const cacheCost = coverage.high.cache
    previewModels.push({
      model,
      channels: coverage.usable.map((item) => ({ channelId: String(item.route.id), channelName: String(item.route.name), source: item.source })),
      standardInputCostMicrosPerMillion: coverage.standard.input.toString(), standardOutputCostMicrosPerMillion: coverage.standard.output.toString(), standardCacheCostMicrosPerMillion: coverage.standard.cache.toString(),
      highContextInputCostMicrosPerMillion: coverage.high.input.toString(), highContextOutputCostMicrosPerMillion: coverage.high.output.toString(), highContextCacheCostMicrosPerMillion: coverage.high.cache.toString(),
      inputCostMicrosPerMillion: inputCost.toString(), outputCostMicrosPerMillion: outputCost.toString(), cacheCostMicrosPerMillion: cacheCost.toString(),
      inputSellMicrosPerMillion: requiredWalletSell(inputCost, input.rules).toString(),
      outputSellMicrosPerMillion: requiredWalletSell(outputCost, input.rules).toString(),
      cacheSellMicrosPerMillion: requiredWalletSell(cacheCost, input.rules).toString(),
      sources: [...new Set(coverage.usable.map((item) => item.source))], existingPrice: modelPrice,
    })
  }
  return { ready: blockers.length === 0 && previewModels.length > 0, rules: input.rules, models: previewModels, blockers }
}
