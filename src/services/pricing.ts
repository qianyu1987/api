import { ceilDiv } from '../lib/money.js'

export type PricingRules = {
  minimumMarginBps: number
  paymentFeeRateBps: number
  affiliateRateBps: number
  walletTopupMultiplierBps: number
}

export type PricingPreviewModel = {
  model: string
  channels: Array<{ channelId: string; channelName: string; source: string | null }>
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

export function retainedCashBps(rules: PricingRules): bigint {
  const retained = 10_000 - rules.minimumMarginBps - rules.paymentFeeRateBps - rules.affiliateRateBps
  if (!Number.isInteger(retained) || retained <= 0) throw new Error('利润、支付费和返利比例合计必须低于 100%')
  return BigInt(retained)
}

/** Wallet credit price needed to retain the target cash margin after 3x credit and deductions. */
export function requiredWalletSell(costMicros: bigint, rules: PricingRules): bigint {
  if (costMicros < 0n) throw new Error('成本不能为负数')
  if (!Number.isInteger(rules.walletTopupMultiplierBps) || rules.walletTopupMultiplierBps < 10_000) throw new Error('充值倍率配置无效')
  return ceilDiv(costMicros * BigInt(rules.walletTopupMultiplierBps), retainedCashBps(rules))
}

export function normalizePricingRules(input: Partial<PricingRules> & { walletTopupMultiplierBps?: number }): PricingRules {
  const rules: PricingRules = {
    minimumMarginBps: Number(input.minimumMarginBps ?? 5000),
    paymentFeeRateBps: Number(input.paymentFeeRateBps ?? 0),
    affiliateRateBps: Number(input.affiliateRateBps ?? 1000),
    walletTopupMultiplierBps: Number(input.walletTopupMultiplierBps ?? 30000),
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
    .sort((a, b) => Number(String(b.model_pattern === model)) - Number(String(a.model_pattern === model)))[0] || null
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
    const routes = input.channels.filter((row) => row.enabled !== false && row.deleted_at == null && isMapped(row, model))
    if (!routes.length) {
      blockers.push({ kind: 'no_route', model, message: `${model} 没有启用的上游渠道映射` })
      continue
    }
    const usable: any[] = []
    for (const route of routes) {
      const cost = costFor(input.costs, String(route.id), model)
      const source = cost?.price_source == null ? '' : String(cost.price_source).trim()
      if (!cost || !source) {
        blockers.push({ kind: 'cost_missing', model, channelId: String(route.id), channelName: String(route.name), message: `${route.name} / ${model} 缺少有来源的输入、输出、缓存成本` })
        continue
      }
      usable.push({ route, cost, source })
    }
    if (usable.length !== routes.length) continue
    const max = (part: string) => usable.reduce((current, item) => {
      const value = nonNegativeRate(item.cost[`${part}_cost_micros_per_million`])
      return value > current ? value : current
    }, 0n)
    const inputCost = max('input'); const outputCost = max('output'); const cacheCost = max('cache')
    const modelPrice = input.prices.find((row) => String(row.model_pattern) === model) || null
    previewModels.push({
      model,
      channels: usable.map((item) => ({ channelId: String(item.route.id), channelName: String(item.route.name), source: item.source })),
      inputCostMicrosPerMillion: inputCost.toString(), outputCostMicrosPerMillion: outputCost.toString(), cacheCostMicrosPerMillion: cacheCost.toString(),
      inputSellMicrosPerMillion: requiredWalletSell(inputCost, input.rules).toString(),
      outputSellMicrosPerMillion: requiredWalletSell(outputCost, input.rules).toString(),
      cacheSellMicrosPerMillion: requiredWalletSell(cacheCost, input.rules).toString(),
      sources: [...new Set(usable.map((item) => item.source))], existingPrice: modelPrice,
    })
  }
  return { ready: blockers.length === 0 && previewModels.length > 0, rules: input.rules, models: previewModels, blockers }
}
