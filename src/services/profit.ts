import { Database, type DbClient } from '../db/index.js'

export function effectiveDiscountBps(personal: number, global: number): number {
  return Math.max(personal, global)
}

export type ProfitRules = { minimumMarginBps: number; paymentFeeRateBps: number; affiliateRateBps: number; globalDiscountBps: number }

function bps(value: unknown, fallback: number, max = 10000): number {
  const number = Number(value ?? fallback)
  if (!Number.isInteger(number) || number < 0 || number > max) throw Object.assign(new Error('比例必须为有效的整数基点'), { statusCode: 400 })
  return number
}

export function profitRules(settings: Record<string, string>): ProfitRules {
  return {
    minimumMarginBps: bps(settings.profit_min_margin_bps, 3000, 9999),
    paymentFeeRateBps: bps(settings.payment_fee_rate_bps, 0),
    affiliateRateBps: settings.affiliate_enabled === 'false' ? 0 : bps(settings.affiliate_rate_bps, 1000),
    globalDiscountBps: bps(settings.global_token_discount_bps, 0, 9900),
  }
}

export function discountLimit(rows: any[], rules: ProfitRules) {
  const retainedBps = BigInt(10000 - rules.minimumMarginBps - rules.paymentFeeRateBps - rules.affiliateRateBps)
  const constraints: Array<{ model: string; tier: string; part: string; maxDiscountBps: number; costMicros: string; sellMicros: string; requiredSellMicros: string | null; reason: string | null }> = []
  for (const row of rows.filter((row) => row.active !== false)) {
    const tiers = [{ label: '标准', ...Object.fromEntries(['input', 'output', 'cache'].flatMap((part) => ['Cost', 'Sell'].map((kind) => [part + kind + 'MicrosPerMillion', row[part + '_' + kind.toLowerCase() + '_micros_per_million'] ?? row[part + '_' + kind.toLowerCase() + '_micros']])) ) }, ...(Array.isArray(row.pricing_tiers) ? row.pricing_tiers : [])]
    for (const tier of tiers) for (const part of ['input', 'output', 'cache']) {
      const rawCost = tier[part + 'CostMicrosPerMillion']; const rawSell = tier[part + 'SellMicrosPerMillion']
      const valid = /^\d+$/.test(String(rawCost)) && /^\d+$/.test(String(rawSell))
      const cost = valid ? BigInt(rawCost) : 0n; const sell = valid ? BigInt(rawSell) : 0n
      const required = retainedBps > 0n ? (cost * 10000n + retainedBps - 1n) / retainedBps : null
      let reason: string | null = !valid ? '成本或售价缺失' : retainedBps <= 0n ? '利润与费用比例合计达到 100%' : sell === 0n ? '售价为零' : required! > sell ? '原价已低于利润线' : null
      // Round the required sale UP, matching billing's discounted-rate floor.
      const maxDiscountBps = reason ? 0 : Math.min(9900, Number((sell - required!) * 10000n / sell))
      constraints.push({ model: String(row.model_pattern), tier: String(tier.label || tier.thresholdTokens || '价格层'), part, maxDiscountBps, costMicros: cost.toString(), sellMicros: sell.toString(), requiredSellMicros: required?.toString() ?? null, reason })
    }
  }
  const maxDiscountBps = constraints.length ? Math.min(...constraints.map((item) => item.maxDiscountBps)) : 0
  return { maxDiscountBps, constraints, blockers: constraints.filter((item) => item.reason), hasPrices: constraints.length > 0 }
}

export function assertDiscount(rows: any[], rules: ProfitRules, discount = rules.globalDiscountBps) {
  const limit = discountLimit(rows, rules)
  if (discount > limit.maxDiscountBps) throw Object.assign(new Error(`减免比例超过利润护栏，最多允许 ${limit.maxDiscountBps / 100}%；限制模型：${[...new Set(limit.constraints.filter((item) => item.maxDiscountBps === limit.maxDiscountBps).map((item) => item.model))].join('、') || '尚无有效模型价格'}`), { statusCode: 400 })
  return limit
}

export class ProfitService {
  constructor(private readonly db: Database) {}

  async overview(client?: DbClient) {
    const read = async (sql: string) => client ? (await client.query(sql)).rows : this.db.query<any>(sql)
    const settings = Object.fromEntries((await read('SELECT key,value FROM app_settings')).map((row) => [row.key, row.value]))
    const rules = profitRules(settings)
    const limit = discountLimit(await read('SELECT * FROM model_prices WHERE active'), rules)
    const users = await read('SELECT token_discount_bps FROM users')
    return { ...rules, ...limit, personalDiscountRiskCount: users.filter((user) => Number(user.token_discount_bps) > limit.maxDiscountBps).length }
  }

  async update(body: any, actorId: string) {
    return this.db.tx(async (client) => {
      // Serialize setting writes and keep the price set stable during validation.
      await client.query('LOCK TABLE app_settings, model_prices IN SHARE ROW EXCLUSIVE MODE')
      const before = await this.overview(client)
      const rules = { ...before,
        minimumMarginBps: bps(body.minimumMarginBps ?? body.minMarginBps, before.minimumMarginBps, 9999),
        paymentFeeRateBps: bps(body.paymentFeeRateBps, before.paymentFeeRateBps),
        globalDiscountBps: bps(body.globalDiscountBps, before.globalDiscountBps, 9900),
      }
      const rows = (await client.query('SELECT * FROM model_prices WHERE active')).rows
      if (body.applySafeDiscount === true) rules.globalDiscountBps = discountLimit(rows, rules).maxDiscountBps
      assertDiscount(rows, rules)
      for (const [key, settingKey, value] of [
        ['profit_min_margin_bps', 'profit.min_margin_bps', rules.minimumMarginBps],
        ['payment_fee_rate_bps', 'profit.payment_fee_rate_bps', rules.paymentFeeRateBps],
        ['global_token_discount_bps', 'profit.global_token_discount_bps', rules.globalDiscountBps],
      ]) await client.query(`INSERT INTO app_settings(key,setting_key,value,value_json,updated_by_user_id) VALUES($1,$2,$3,to_jsonb($3::text),$4)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,value_json=excluded.value_json,updated_by_user_id=excluded.updated_by_user_id,updated_at=now()`, [key, settingKey, String(value), actorId])
      const after = await this.overview(client)
      await client.query(`INSERT INTO config_audit_logs(actor_user_id,resource_type,resource_id,before_value,after_value) VALUES($1,'profit_settings','global',$2,$3)`, [actorId, JSON.stringify(before), JSON.stringify(after)])
      return after
    })
  }
}
