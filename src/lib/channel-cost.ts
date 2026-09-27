import type { PriceSnapshot } from '../services/billing.js'

export type ChannelCostSnapshot = {
  channelId: string
  model: string
  inputMicros: string
  outputMicros: string
  cacheMicros: string
  highContextMultiplierBps: number
  cacheWriteMicros?: string | null
  highContextInputMultiplierBps?: number
  highContextOutputMultiplierBps?: number
  highContextCacheMultiplierBps?: number
  highContextCacheWriteMultiplierBps?: number
  providerTierCosts?: Record<string, {
    inputMicros: string
    outputMicros: string
    cacheReadMicros: string
    cacheWriteMicros: string
    highContextMultipliers: { input: number; output: number; cacheRead: number; cacheWrite: number }
    source: string
  }>
  source: string | null
  effectiveAt: string | null
}

export function snapshotChannelCost(row: any): ChannelCostSnapshot {
  const providerTierCosts = row.provider_tier_costs && typeof row.provider_tier_costs === 'object' && !Array.isArray(row.provider_tier_costs)
    ? row.provider_tier_costs
    : {}
  const standard = providerTierCosts.standard
  return {
    channelId: String(row.channel_id), model: String(row.model_pattern),
    inputMicros: String(standard?.inputCostMicrosPerMillion ?? row.input_cost_micros_per_million),
    outputMicros: String(standard?.outputCostMicrosPerMillion ?? row.output_cost_micros_per_million),
    cacheMicros: String(standard?.cacheReadCostMicrosPerMillion ?? row.cache_cost_micros_per_million),
    highContextMultiplierBps: Number(row.high_context_multiplier_bps ?? 12000),
    cacheWriteMicros: standard?.cacheWriteCostMicrosPerMillion == null ? (row.cache_write_cost_micros_per_million == null ? null : String(row.cache_write_cost_micros_per_million)) : String(standard.cacheWriteCostMicrosPerMillion),
    highContextInputMultiplierBps: Number(standard?.highContextMultipliers?.input ?? row.high_context_input_multiplier_bps ?? row.high_context_multiplier_bps ?? 12000),
    highContextOutputMultiplierBps: Number(standard?.highContextMultipliers?.output ?? row.high_context_output_multiplier_bps ?? row.high_context_multiplier_bps ?? 12000),
    highContextCacheMultiplierBps: Number(standard?.highContextMultipliers?.cacheRead ?? row.high_context_cache_multiplier_bps ?? row.high_context_multiplier_bps ?? 12000),
    highContextCacheWriteMultiplierBps: Number(standard?.highContextMultipliers?.cacheWrite ?? row.high_context_cache_write_multiplier_bps ?? row.high_context_input_multiplier_bps ?? row.high_context_multiplier_bps ?? 12000),
    providerTierCosts: Object.fromEntries(Object.entries(providerTierCosts).map(([name, value]: [string, any]) => [name, {
      inputMicros: String(value.inputCostMicrosPerMillion), outputMicros: String(value.outputCostMicrosPerMillion),
      cacheReadMicros: String(value.cacheReadCostMicrosPerMillion), cacheWriteMicros: String(value.cacheWriteCostMicrosPerMillion),
      highContextMultipliers: value.highContextMultipliers, source: String(value.source || ''),
    }])),
    source: standard?.source || row.price_source || null,
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
    const scaled = (value: string, factor: number) => high ? (BigInt(value) * BigInt(factor) + 9999n) / 10000n : BigInt(value)
    const base = {
      inputCostMicrosPerMillion: scaled(cost.inputMicros, cost.highContextInputMultiplierBps || cost.highContextMultiplierBps),
      outputCostMicrosPerMillion: scaled(cost.outputMicros, cost.highContextOutputMultiplierBps || cost.highContextMultiplierBps),
      cacheCostMicrosPerMillion: scaled(cost.cacheMicros, cost.highContextCacheMultiplierBps || cost.highContextMultiplierBps),
    }
    return cost.cacheWriteMicros == null ? base : {
      ...base,
      cacheWriteCostMicrosPerMillion: scaled(cost.cacheWriteMicros, cost.highContextCacheWriteMultiplierBps || cost.highContextInputMultiplierBps || cost.highContextMultiplierBps),
    }
  }
  // Cost tiers are independent of the sales tiers. Preserve all sales boundaries
  // and add the provider's 272K boundary if the model has no sales tier there.
  const thresholds = [...new Set([0n, 272001n, ...(price.pricingTiers || []).map((tier) => tier.thresholdTokens)])].sort((a, b) => a < b ? -1 : 1)
  return { ...price, ...rates(false), appliedChannelCost: cost, pricingTiers: thresholds.map((thresholdTokens) => {
    const sale = (price.pricingTiers || []).filter((tier) => tier.thresholdTokens <= thresholdTokens).sort((a, b) => a.thresholdTokens > b.thresholdTokens ? -1 : 1)[0] || price
    return { ...sale, ...rates(thresholdTokens > 272000n), thresholdTokens }
  }) }
}
