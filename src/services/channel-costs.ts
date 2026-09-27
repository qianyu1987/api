import { Database, one, query } from '../db/index.js'
import { yuanToMicros } from '../lib/money.js'
import { buildPricingPreview, type PricingPreview, type PricingRules } from './pricing.js'

const invalid = (message: string, statusCode = 400): never => { throw Object.assign(new Error(message), { statusCode }) }
const uuid = (value: unknown) => {
  const text = String(value || '')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) invalid('请选择有效渠道')
  return text
}

function parseProviderTierCosts(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('分档上游成本必须是 Standard/Fast 对象')
  const input = value as Record<string, any>
  const allowed = new Set(['standard', 'fast'])
  if (Object.keys(input).some((key) => !allowed.has(key))) invalid('仅支持 Standard 或 Fast 上游成本档')
  const result: Record<string, any> = {}
  for (const [tier, rates] of Object.entries(input)) {
    if (!rates || typeof rates !== 'object' || Array.isArray(rates)) invalid(`${tier} 成本档格式无效`)
    const values: Record<string, string> = {}
    for (const [field, label] of [
      ['inputCostYuanPerMillion', '普通输入'], ['outputCostYuanPerMillion', '输出'],
      ['cacheReadCostYuanPerMillion', 'cache-read'], ['cacheWriteCostYuanPerMillion', 'cache-write'],
    ] as const) {
      try { values[field.replace('YuanPerMillion', 'MicrosPerMillion')] = yuanToMicros((rates as any)[field]).toString() }
      catch { invalid(`${tier} ${label}成本必须是非负人民币金额，最多 6 位小数`) }
    }
    const multipliers = rates.highContextMultipliers
    if (!multipliers || typeof multipliers !== 'object' || Array.isArray(multipliers)) invalid(`${tier} 必须明确填写 272K+ 各项成本倍率`)
    const normalized = {
      input: Number(multipliers.input), output: Number(multipliers.output),
      cacheRead: Number(multipliers.cacheRead), cacheWrite: Number(multipliers.cacheWrite),
    }
    if (Object.values(normalized).some((item) => !Number.isInteger(item) || item < 10000 || item > 110000)) invalid(`${tier} 272K+ 倍率必须在 1–11 倍之间`)
    const source = String(rates.priceSource || '').trim()
    if (!source || source.length > 512) invalid(`${tier} 必须填写可审计成本来源，最多 512 字`)
    result[tier] = { ...values, highContextMultipliers: normalized, source }
  }
  return result
}

export class ChannelCostService {
  constructor(private readonly db: Database) {}

  private async previewWith(client: Database | any, rules: PricingRules): Promise<PricingPreview> {
    const [channels, prices, costs] = await Promise.all([
      query<any>(client, `SELECT c.id,c.name,c.priority,c.enabled,c.deleted_at,c.model_map
        FROM channels c WHERE c.deleted_at IS NULL AND c.enabled=true ORDER BY c.priority,c.name,c.id`),
      query<any>(client, `SELECT * FROM model_prices WHERE active=true ORDER BY model_pattern`),
      query<any>(client, `SELECT * FROM channel_model_costs WHERE price_effective_at IS NULL OR price_effective_at <= now()`),
    ])
    return buildPricingPreview({ channels, prices, costs, rules })
  }

  async list() {
    const [items, channels, audits] = await Promise.all([
      this.db.query(`SELECT c.name AS channel_name,c.base_url,m.* FROM channel_model_costs m JOIN channels c ON c.id=m.channel_id WHERE c.deleted_at IS NULL ORDER BY c.priority,m.model_pattern`),
      this.db.query(`SELECT id,name,model_map,enabled FROM channels WHERE deleted_at IS NULL ORDER BY priority,name`),
      this.db.query(`SELECT a.id,a.resource_id,a.before_value,a.after_value,a.created_at,u.username AS actor_name
        FROM config_audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id
        WHERE a.resource_type='channel_model_cost' ORDER BY a.created_at DESC,a.id DESC LIMIT 50`),
    ])
    return { items, channels, audits }
  }

  async save(body: any, actorId: string) {
    const channelId = uuid(body.channelId)
    const model = String(body.modelPattern || '').trim()
    if (!model || model.length > 256) invalid('请填写用户调用的公开模型名')
    const rates = ['input', 'output', 'cache'].map((part, i) => {
      const value = body[part + 'CostYuanPerMillion']
      if (value === undefined || value === null || String(value).trim() === '') invalid(['输入', '输出', '缓存'][i] + '成本必填；确认免费时请明确填写 0')
      let amount: bigint
      try { amount = yuanToMicros(value) } catch { return invalid('成本必须为非负人民币金额，最多 6 位小数') }
      if (amount > 9223372036854775807n) invalid('成本超出允许范围')
      return amount.toString()
    })
    const source = String(body.priceSource || '').trim()
    if (!source || source.length > 512) invalid('请填写成本来源，例如上游账单日期；最多 512 字')
    const multiplier = Number(body.highContextMultiplierBps ?? 12000)
    if (!Number.isInteger(multiplier) || multiplier < 10000 || multiplier > 110000) invalid('272K+ 成本倍率必须在 1–11 倍之间')
    // Upserting a future price would remove the currently effective cost. Keep
    // this editor immediate until the schema supports multiple dated versions.
    if (body.priceEffectiveAt && new Date(body.priceEffectiveAt).getTime() > Date.now()) invalid('当前成本编辑立即生效，暂不支持预约改价')
    if (body.priceEffectiveAt && Number.isNaN(new Date(body.priceEffectiveAt).getTime())) invalid('成本生效时间无效')
    const providerTierCosts = body.providerTierCosts === undefined ? null : JSON.stringify(parseProviderTierCosts(body.providerTierCosts))
    return this.db.tx(async client => {
      // Serialize both first writes and subsequent edits for the channel.
      const channel = await one<any>(client, 'SELECT id,name,model_map FROM channels WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [channelId])
      if (!channel) invalid('渠道不存在', 404)
      if (model !== '*' && !Object.hasOwn(channel.model_map || {}, model) && !Object.hasOwn(channel.model_map || {}, '*')) invalid('模型未配置在该渠道映射中，请选择公开模型名')
      const before = await one<any>(client, 'SELECT * FROM channel_model_costs WHERE channel_id=$1 AND model_pattern=$2 FOR UPDATE', [channelId, model])
      if (Object.hasOwn(body, 'expectedUpdatedAt')) {
        const expected = body.expectedUpdatedAt === null ? null : new Date(body.expectedUpdatedAt).getTime()
        const current = before ? new Date(before.updated_at).getTime() : null
        if (expected !== current) invalid('成本已被其他管理员修改，请重新加载后再保存', 409)
      }
      const after = await one<any>(client, `INSERT INTO channel_model_costs(channel_id,model_pattern,input_cost_micros_per_million,output_cost_micros_per_million,cache_cost_micros_per_million,price_source,price_effective_at,high_context_multiplier_bps,provider_tier_costs)
        VALUES($1,$2,$3,$4,$5,$6,now(),$7,COALESCE($8::jsonb,'{}'::jsonb))
        ON CONFLICT(channel_id,model_pattern) DO UPDATE SET input_cost_micros_per_million=excluded.input_cost_micros_per_million,output_cost_micros_per_million=excluded.output_cost_micros_per_million,cache_cost_micros_per_million=excluded.cache_cost_micros_per_million,price_source=excluded.price_source,price_effective_at=excluded.price_effective_at,high_context_multiplier_bps=excluded.high_context_multiplier_bps,provider_tier_costs=CASE WHEN $8::jsonb IS NULL THEN channel_model_costs.provider_tier_costs ELSE excluded.provider_tier_costs END,updated_at=clock_timestamp()
        RETURNING *`, [channelId, model, ...rates, source, multiplier, providerTierCosts])
      await client.query(`INSERT INTO config_audit_logs(actor_user_id,resource_type,resource_id,before_value,after_value)
        VALUES($1,'channel_model_cost',$2,$3,$4)`, [actorId, `${channelId}:${model}`, before ? JSON.stringify(before) : null, JSON.stringify(after)])
      return after
    })
  }

  async pricingPreview(rules: PricingRules): Promise<PricingPreview> {
    return this.previewWith(this.db, rules)
  }

  async publishPricing(rules: PricingRules, actorId: string): Promise<PricingPreview & { publishedAt: string }> {
    return this.db.tx(async (client) => {
      await client.query('LOCK TABLE channels, channel_model_mappings, channel_model_costs, model_prices, app_settings IN SHARE ROW EXCLUSIVE MODE')
      const preview = await this.previewWith(client, rules)
      if (!preview.ready) {
        throw Object.assign(new Error('渠道成本不完整，未发布任何价格；请先补齐预览中的缺失项'), { statusCode: 409, pricingPreview: preview })
      }
      const publishedAt = new Date()
      for (const item of preview.models) {
        const source = `channel-cost-preview ${publishedAt.toISOString()} · ${item.sources.join('；')}`.slice(0, 512)
        const before = await one<any>(client, 'SELECT * FROM model_prices WHERE model_pattern=$1 FOR UPDATE', [item.model])
        const tiered = item.model === 'gpt-6-sol'
        const inputCost = tiered ? item.standardInputCostMicrosPerMillion : item.inputCostMicrosPerMillion
        const outputCost = tiered ? item.standardOutputCostMicrosPerMillion : item.outputCostMicrosPerMillion
        const cacheCost = tiered ? item.standardCacheCostMicrosPerMillion : item.cacheCostMicrosPerMillion
        const inputSell = tiered ? item.standardInputSellMicrosPerMillion : item.inputSellMicrosPerMillion
        const outputSell = tiered ? item.standardOutputSellMicrosPerMillion : item.outputSellMicrosPerMillion
        const cacheSell = tiered ? item.standardCacheSellMicrosPerMillion : item.cacheSellMicrosPerMillion
        const writeCost = tiered ? item.standardCacheWriteCostMicrosPerMillion : null
        const writeSell = tiered ? item.standardCacheWriteSellMicrosPerMillion : null
        const pricingTiers = tiered ? [{
          thresholdTokens: '272001', label: '272K+',
          inputCostMicrosPerMillion: item.highContextInputCostMicrosPerMillion,
          outputCostMicrosPerMillion: item.highContextOutputCostMicrosPerMillion,
          cacheCostMicrosPerMillion: item.highContextCacheCostMicrosPerMillion,
          cacheWriteCostMicrosPerMillion: item.highContextCacheWriteCostMicrosPerMillion,
          inputSellMicrosPerMillion: item.highContextInputSellMicrosPerMillion,
          outputSellMicrosPerMillion: item.highContextOutputSellMicrosPerMillion,
          cacheSellMicrosPerMillion: item.highContextCacheSellMicrosPerMillion,
          cacheWriteSellMicrosPerMillion: item.highContextCacheWriteSellMicrosPerMillion,
        }] : before?.pricing_tiers ?? null
        const after = await one<any>(client, `INSERT INTO model_prices(
          model_pattern,input_cost_micros,output_cost_micros,cache_cost_micros,
          input_sell_micros,output_sell_micros,cache_sell_micros,fixed_cost_micros,fixed_sell_micros,active,
          input_cost_micros_per_million,output_cost_micros_per_million,cache_cost_micros_per_million,
          input_sell_micros_per_million,output_sell_micros_per_million,cache_sell_micros_per_million,
          cache_write_cost_micros,cache_write_sell_micros,cache_write_cost_micros_per_million,cache_write_sell_micros_per_million,
          price_source,price_effective_at,pricing_tiers)
          VALUES($1,$2,$3,$4,$5,$6,$7,0,0,true,$2,$3,$4,$5,$6,$7,$8,$9,$8,$9,$10,$11,$12)
          ON CONFLICT(model_pattern) DO UPDATE SET
            input_cost_micros=excluded.input_cost_micros,output_cost_micros=excluded.output_cost_micros,cache_cost_micros=excluded.cache_cost_micros,
            input_sell_micros=excluded.input_sell_micros,output_sell_micros=excluded.output_sell_micros,cache_sell_micros=excluded.cache_sell_micros,
            input_cost_micros_per_million=excluded.input_cost_micros_per_million,output_cost_micros_per_million=excluded.output_cost_micros_per_million,cache_cost_micros_per_million=excluded.cache_cost_micros_per_million,
            input_sell_micros_per_million=excluded.input_sell_micros_per_million,output_sell_micros_per_million=excluded.output_sell_micros_per_million,cache_sell_micros_per_million=excluded.cache_sell_micros_per_million,
            cache_write_cost_micros=excluded.cache_write_cost_micros,cache_write_sell_micros=excluded.cache_write_sell_micros,
            cache_write_cost_micros_per_million=excluded.cache_write_cost_micros_per_million,cache_write_sell_micros_per_million=excluded.cache_write_sell_micros_per_million,
            price_source=excluded.price_source,price_effective_at=excluded.price_effective_at,pricing_tiers=excluded.pricing_tiers,active=true,updated_at=now()
          RETURNING *`, [item.model, inputCost, outputCost, cacheCost, inputSell, outputSell, cacheSell, writeCost, writeSell, source, publishedAt, JSON.stringify(pricingTiers)])
        await client.query(`INSERT INTO config_audit_logs(actor_user_id,resource_type,resource_id,before_value,after_value)
          VALUES($1,'model_price',$2,$3,$4)`, [actorId, item.model, before ? JSON.stringify(before) : null, JSON.stringify(after)])
      }
      const beforeRules = await one<any>(client, `SELECT key,value FROM app_settings WHERE key IN ('profit_min_margin_bps','payment_fee_rate_bps','affiliate_rate_bps') ORDER BY key`)
      await client.query(`INSERT INTO app_settings(key,setting_key,value,value_json,updated_by_user_id)
        VALUES('profit_min_margin_bps','profit.min_margin_bps',$1,to_jsonb($1::text),$2)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,value_json=excluded.value_json,updated_by_user_id=excluded.updated_by_user_id,updated_at=now()`, [String(rules.minimumMarginBps), actorId])
      await client.query(`INSERT INTO config_audit_logs(actor_user_id,resource_type,resource_id,before_value,after_value)
        VALUES($1,'profit_settings','global',$2,$3)`, [actorId, JSON.stringify(beforeRules || {}), JSON.stringify({ ...rules, publishedAt: publishedAt.toISOString() })])
      return { ...preview, publishedAt: publishedAt.toISOString() }
    })
  }
}
