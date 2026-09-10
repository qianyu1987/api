import type { PriceSnapshot } from '../services/billing.js'

export type ChannelCostSnapshot = {
  channelId: string
  model: string
  inputMicros: string
  outputMicros: string
  cacheMicros: string
  highContextMultiplierBps: number
  source: string | null
  effectiveAt: string | null
}

export function snapshotChannelCost(row: any): ChannelCostSnapshot {
  return {
    channelId: String(row.channel_id), model: String(row.model_pattern),
    inputMicros: String(row.input_cost_micros_per_million),
    outputMicros: String(row.output_cost_micros_per_million),
    cacheMicros: String(row.cache_cost_micros_per_million),
    highContextMultiplierBps: Number(row.high_context_multiplier_bps ?? 12000),
    source: row.price_source || null,
    effectiveAt: row.price_effective_at ? new Date(row.price_effective_at).toISOString() : null,
  }
}

/** Use only the frozen cost for the final channel; never change selling rates. */
export function applyChannelCost(price: PriceSnapshot, snapshots: ChannelCostSnapshot[], channelId?: string | null): PriceSnapshot {
  if (price.billingMode === 'fixed' || !channelId) return price
  const cost = snapshots.find((item) => item.channelId === channelId && item.model !== '*')
    || snapshots.find((item) => item.channelId === channelId && item.model === '*')
  if (!cost) return price
  const rates = (high: boolean) => {
    const scaled = (value: string) => high ? (BigInt(value) * BigInt(cost.highContextMultiplierBps) + 9999n) / 10000n : BigInt(value)
    return { inputCostMicrosPerMillion: scaled(cost.inputMicros), outputCostMicrosPerMillion: scaled(cost.outputMicros), cacheCostMicrosPerMillion: scaled(cost.cacheMicros) }
  }
  // Cost tiers are independent of the sales tiers. Preserve all sales boundaries
  // and add the provider's 272K boundary if the model has no sales tier there.
  const thresholds = [...new Set([0n, 272001n, ...(price.pricingTiers || []).map((tier) => tier.thresholdTokens)])].sort((a, b) => a < b ? -1 : 1)
  return { ...price, ...rates(false), appliedChannelCost: cost, pricingTiers: thresholds.map((thresholdTokens) => {
    const sale = (price.pricingTiers || []).filter((tier) => tier.thresholdTokens <= thresholdTokens).sort((a, b) => a.thresholdTokens > b.thresholdTokens ? -1 : 1)[0] || price
    return { ...sale, ...rates(thresholdTokens > 272000n), thresholdTokens }
  }) }
}
