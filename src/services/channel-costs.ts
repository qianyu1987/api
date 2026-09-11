import { Database, one } from '../db/index.js'
import { yuanToMicros } from '../lib/money.js'

const invalid = (message: string, statusCode = 400): never => { throw Object.assign(new Error(message), { statusCode }) }
const uuid = (value: unknown) => {
  const text = String(value || '')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) invalid('请选择有效渠道')
  return text
}

export class ChannelCostService {
  constructor(private readonly db: Database) {}

  async list() {
    const [items, channels, audits] = await Promise.all([
      this.db.query(`SELECT c.name AS channel_name,c.base_url,m.* FROM channel_model_costs m JOIN channels c ON c.id=m.channel_id ORDER BY c.priority,m.model_pattern`),
      this.db.query(`SELECT id,name,model_map,enabled FROM channels ORDER BY priority,name`),
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
    return this.db.tx(async client => {
      // Serialize both first writes and subsequent edits for the channel.
      const channel = await one<any>(client, 'SELECT id,name,model_map FROM channels WHERE id=$1 FOR UPDATE', [channelId])
      if (!channel) invalid('渠道不存在', 404)
      if (model !== '*' && !Object.hasOwn(channel.model_map || {}, model) && !Object.hasOwn(channel.model_map || {}, '*')) invalid('模型未配置在该渠道映射中，请选择公开模型名')
      const before = await one<any>(client, 'SELECT * FROM channel_model_costs WHERE channel_id=$1 AND model_pattern=$2 FOR UPDATE', [channelId, model])
      if (Object.hasOwn(body, 'expectedUpdatedAt')) {
        const expected = body.expectedUpdatedAt === null ? null : new Date(body.expectedUpdatedAt).getTime()
        const current = before ? new Date(before.updated_at).getTime() : null
        if (expected !== current) invalid('成本已被其他管理员修改，请重新加载后再保存', 409)
      }
      const after = await one<any>(client, `INSERT INTO channel_model_costs(channel_id,model_pattern,input_cost_micros_per_million,output_cost_micros_per_million,cache_cost_micros_per_million,price_source,price_effective_at,high_context_multiplier_bps)
        VALUES($1,$2,$3,$4,$5,$6,now(),$7)
        ON CONFLICT(channel_id,model_pattern) DO UPDATE SET input_cost_micros_per_million=excluded.input_cost_micros_per_million,output_cost_micros_per_million=excluded.output_cost_micros_per_million,cache_cost_micros_per_million=excluded.cache_cost_micros_per_million,price_source=excluded.price_source,price_effective_at=excluded.price_effective_at,high_context_multiplier_bps=excluded.high_context_multiplier_bps,updated_at=clock_timestamp()
        RETURNING *`, [channelId, model, ...rates, source, multiplier])
      await client.query(`INSERT INTO config_audit_logs(actor_user_id,resource_type,resource_id,before_value,after_value)
        VALUES($1,'channel_model_cost',$2,$3,$4)`, [actorId, `${channelId}:${model}`, before ? JSON.stringify(before) : null, JSON.stringify(after)])
      return after
    })
  }
}
