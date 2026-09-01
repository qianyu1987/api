import { Database, one } from '../db/index.js'

const micros = (value: unknown): bigint => BigInt(String(value ?? 0))

export class AffiliateService {
  constructor(private readonly db: Database) {}

  async overview(userId: string): Promise<any> {
    const user = await this.db.one<any>('SELECT id, username, invite_code FROM users WHERE id = $1', [userId])
    if (!user) throw new Error('用户不存在')
    const wallet = await this.db.one<any>('SELECT balance_micros, lifetime_micros, converted_micros FROM affiliate_wallets WHERE user_id = $1', [userId])
    const count = await this.db.one<any>('SELECT count(*)::int AS count FROM invitation_bindings WHERE inviter_user_id = $1', [userId])
    const commissions = await this.db.query<any>(`SELECT c.*, u.username AS invited_username FROM affiliate_commissions c JOIN users u ON u.id = COALESCE(c.invited_user_id, c.invitee_user_id) WHERE c.inviter_user_id = $1 ORDER BY c.created_at DESC LIMIT 50`, [userId])
    const ledger = await this.db.query<any>(`SELECT id, kind, amount_micros, balance_after_micros, created_at FROM affiliate_ledger WHERE user_id = $1 ORDER BY id DESC LIMIT 50`, [userId])
    return {
      inviteCode: user.invite_code,
      // The registration route resolves to the single-page entrypoint and
      // preserves the invite query for the registration form to prefill.
      inviteLink: `/register?invite=${encodeURIComponent(user.invite_code)}`,
      invitedCount: Number(count?.count || 0),
      balanceMicros: micros(wallet?.balance_micros).toString(),
      lifetimeMicros: micros(wallet?.lifetime_micros).toString(),
      convertedMicros: micros(wallet?.converted_micros).toString(),
      commissions: commissions.map((row) => ({ id: String(row.id), invitedUsername: row.invited_username, orderId: row.order_id, paidAmountMicros: micros(row.paid_amount_micros).toString(), rateBps: Number(row.rate_bps), commissionMicros: micros(row.commission_micros).toString(), createdAt: row.created_at })),
      ledger: ledger.map((row) => ({ id: String(row.id), kind: row.kind, amountMicros: micros(row.amount_micros).toString(), balanceAfterMicros: micros(row.balance_after_micros).toString(), createdAt: row.created_at })),
    }
  }

  async creditForTopup(client: any, orderId: string, invitedUserId: string, paidAmountMicros: bigint, defaultRateBps = 1000): Promise<void> {
    const setting = await one<any>(client, `SELECT value FROM app_settings WHERE key = 'affiliate_enabled'`)
    if (String(setting?.value ?? 'true') !== 'true') return
    const rateRow = await one<any>(client, `SELECT value FROM app_settings WHERE key = 'affiliate_rate_bps'`)
    const configuredRate = Number(rateRow?.value ?? defaultRateBps)
    const rateBps = Number.isInteger(configuredRate) ? Math.max(0, Math.min(10000, configuredRate)) : Math.max(0, Math.min(10000, defaultRateBps))
    if (rateBps <= 0) return
    const binding = await one<any>(client, `SELECT inviter_user_id FROM invitation_bindings WHERE invitee_user_id = $1`, [invitedUserId])
    if (!binding || String(binding.inviter_user_id) === String(invitedUserId)) return
    const commission = (paidAmountMicros * BigInt(rateBps)) / 10000n
    if (commission <= 0n) return
    const inserted = await one<any>(client, `INSERT INTO affiliate_commissions(order_id, inviter_user_id, invited_user_id, invitee_user_id, paid_amount_micros, payment_amount_micros, rate_bps, commission_micros, reward_micros) VALUES ($1,$2,$3,$3,$4,$4,$5,$6,$6) ON CONFLICT(order_id) DO NOTHING RETURNING id`, [orderId, binding.inviter_user_id, invitedUserId, paidAmountMicros.toString(), rateBps, commission.toString()])
    if (!inserted) return
    await client.query('INSERT INTO affiliate_wallets(user_id) VALUES ($1) ON CONFLICT(user_id) DO NOTHING', [binding.inviter_user_id])
    const wallet = await one<any>(client, `SELECT balance_micros FROM affiliate_wallets WHERE user_id = $1 FOR UPDATE`, [binding.inviter_user_id])
    const next = micros(wallet?.balance_micros) + commission
    await client.query(`INSERT INTO affiliate_wallets(user_id, balance_micros, lifetime_micros, version) VALUES ($1,$2,$2,1) ON CONFLICT(user_id) DO UPDATE SET balance_micros = $2, lifetime_micros = affiliate_wallets.lifetime_micros + $3, version = affiliate_wallets.version + 1, updated_at = now()`, [binding.inviter_user_id, next.toString(), commission.toString()])
    await client.query(`INSERT INTO affiliate_ledger(user_id, kind, amount_micros, balance_after_micros, commission_id, order_id, metadata) VALUES ($1,'commission_credit',$2,$3,$4,$5,$6)`, [binding.inviter_user_id, commission.toString(), next.toString(), inserted.id, orderId, JSON.stringify({ paidAmountMicros: paidAmountMicros.toString(), rateBps })])
  }

  async convert(userId: string, amountMicros?: bigint): Promise<{ convertedMicros: string; walletMicros: string }> {
    return this.db.tx(async (client) => {
      // Keep the lock order aligned with payment settlement: user -> API
      // wallet -> affiliate wallet. This prevents a top-up and a conversion
      // for the same account from forming a cross-wallet deadlock.
      const user = await one<any>(client, 'SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId])
      if (!user) throw new Error('用户不存在')
      await client.query('INSERT INTO wallets(user_id) VALUES ($1) ON CONFLICT(user_id) DO NOTHING', [userId])
      const wallet = await one<any>(client, 'SELECT balance_micros FROM wallets WHERE user_id = $1 FOR UPDATE', [userId])
      await client.query('INSERT INTO affiliate_wallets(user_id) VALUES ($1) ON CONFLICT(user_id) DO NOTHING', [userId])
      const affiliate = await one<any>(client, 'SELECT balance_micros FROM affiliate_wallets WHERE user_id = $1 FOR UPDATE', [userId])
      const available = micros(affiliate?.balance_micros)
      const amount = amountMicros === undefined ? available : amountMicros
      if (amount <= 0n || amount > available) throw new Error('可兑换返利余额不足')
      const nextWallet = micros(wallet?.balance_micros) + amount
      const nextAffiliate = available - amount
      const conversion = await one<any>(client, `INSERT INTO affiliate_conversions(user_id, amount_micros) VALUES ($1,$2) RETURNING id`, [userId, amount.toString()])
      const affiliateUpdate = await client.query('UPDATE affiliate_wallets SET balance_micros = $1, converted_micros = converted_micros + $2, version = version + 1, updated_at = now() WHERE user_id = $3', [nextAffiliate.toString(), amount.toString(), userId])
      if (affiliateUpdate.rowCount !== 1) throw new Error('返利余额更新失败')
      const walletUpdate = await client.query('UPDATE wallets SET balance_micros = $1, version = version + 1, updated_at = now() WHERE user_id = $2', [nextWallet.toString(), userId])
      if (walletUpdate.rowCount !== 1) throw new Error('钱包余额更新失败')
      await client.query(`INSERT INTO affiliate_ledger(user_id, kind, amount_micros, balance_after_micros, conversion_id, metadata) VALUES ($1,'conversion_debit',$2,$3,$4,$5)`, [userId, (-amount).toString(), nextAffiliate.toString(), conversion?.id, JSON.stringify({ target: 'wallet' })])
      await client.query(`INSERT INTO wallet_ledger(user_id, kind, amount_micros, balance_after_micros, affiliate_conversion_id, metadata) VALUES ($1,'affiliate_conversion',$2,$3,$4,$5)`, [userId, amount.toString(), nextWallet.toString(), conversion?.id, JSON.stringify({ source: 'affiliate' })])
      return { convertedMicros: amount.toString(), walletMicros: nextWallet.toString() }
    })
  }
}
