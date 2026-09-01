import argon2 from 'argon2'
import { randomInt } from 'node:crypto'
import { createApiKey, createInviteCode, hashApiKey, keyPrefix, encryptSecret, decryptSecret, secureEquals } from '../lib/crypto.js'
import { Database, one } from '../db/index.js'
import type { AppConfig } from '../config.js'

export type PublicUser = {
  id: string
  username: string
  role: 'user' | 'admin'
  inviteCode: string
  email: string | null
  emailVerified: boolean
  createdAt: string
}

function publicUser(row: any): PublicUser {
  return {
    id: String(row.id),
    username: String(row.username),
    role: row.role === 'admin' ? 'admin' : 'user',
    inviteCode: String(row.invite_code),
    email: row.email ? String(row.email) : null,
    emailVerified: Boolean(row.email_verified_at),
    createdAt: new Date(row.created_at).toISOString(),
  }
}

function normalizedEmail(value: string): string {
  const email = value.trim().toLowerCase()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('邮箱格式无效')
  return email
}

function verificationCode(value?: string): string {
  if (value && /^\d{6}$/.test(value)) return value
  return String(randomInt(100_000, 1_000_000))
}

export class AuthService {
  constructor(private readonly db: Database, private readonly config: AppConfig) {}

  async ensureAdmin(): Promise<void> {
    const cleanUsername = this.config.adminUsername.trim().toLowerCase()
    const existing = await this.db.one<any>('SELECT id FROM users WHERE lower(username) = $1', [cleanUsername])
    if (existing) {
      await this.db.tx(async (client) => {
        await client.query('INSERT INTO wallets(user_id) VALUES ($1) ON CONFLICT(user_id) DO NOTHING', [existing.id])
        await client.query('INSERT INTO affiliate_wallets(user_id) VALUES ($1) ON CONFLICT(user_id) DO NOTHING', [existing.id])
      })
      return
    }
    if (!this.config.adminPassword) throw new Error('ADMIN_PASSWORD is required to bootstrap the admin account')
    const passwordHash = await argon2.hash(this.config.adminPassword, { type: argon2.argon2id })
    let inviteCode = createInviteCode()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await this.db.tx(async (client) => {
          const user = await one<any>(client,
            `INSERT INTO users(username, password_hash, role, invite_code)
             VALUES ($1, $2, 'admin', $3) RETURNING id`,
            [cleanUsername, passwordHash, inviteCode],
          )
          if (!user) throw new Error('failed to create admin account')
          await client.query('INSERT INTO wallets(user_id) VALUES ($1)', [user.id])
          await client.query('INSERT INTO affiliate_wallets(user_id) VALUES ($1)', [user.id])
        })
        return
      } catch (error: any) {
        if (error?.code !== '23505') throw error
        inviteCode = createInviteCode()
      }
    }
    throw new Error('failed to create admin account')
  }

  async issueRegistrationCode(rawEmail: string): Promise<{ email: string; code: string; expiresAt: string }> {
    const email = normalizedEmail(rawEmail)
    const code = verificationCode()
    const expiresAt = new Date(Date.now() + 10 * 60_000)
    await this.db.tx(async (client) => {
      await client.query(
        `UPDATE email_verification_challenges
         SET consumed_at = now()
         WHERE email = $1 AND purpose = 'registration' AND consumed_at IS NULL`,
        [email],
      )
      await client.query(
        `INSERT INTO email_verification_challenges(email,purpose,code_hash,expires_at)
         VALUES($1,'registration',$2,$3)`,
        [email, hashApiKey(code, this.config.apiKeyPepper), expiresAt],
      )
    })
    return { email, code, expiresAt: expiresAt.toISOString() }
  }

  async register(username: string, password: string, input: { email?: string; verificationCode?: string; inviteCode?: string; termsAccepted?: boolean } = {}): Promise<PublicUser> {
    const cleanUsername = username.trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(cleanUsername)) throw new Error('账号需为 3-32 位字母、数字或 _.-')
    if (password.length < 8 || password.length > 128) throw new Error('密码长度需为 8-128 位')
    const email = normalizedEmail(String(input.email || ''))
    const verificationCodeValue = String(input.verificationCode || '').trim()
    if (!/^\d{6}$/.test(verificationCodeValue)) throw new Error('请输入 6 位邮箱验证码')
    if (input.termsAccepted !== true) throw new Error('请阅读并同意登录条款、服务条款和隐私说明')
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id })
    return this.db.tx(async (client) => {
      const challenge = await one<any>(client,
        `SELECT * FROM email_verification_challenges
         WHERE email = $1 AND purpose = 'registration' AND consumed_at IS NULL
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [email],
      )
      if (!challenge || new Date(challenge.expires_at).getTime() <= Date.now()) throw new Error('验证码已过期，请重新获取')
      if (Number(challenge.attempts) >= Number(challenge.max_attempts)) throw new Error('验证码尝试次数过多，请重新获取')
      if (!secureEquals(String(challenge.code_hash), hashApiKey(verificationCodeValue, this.config.apiKeyPepper))) {
        await client.query('UPDATE email_verification_challenges SET attempts = attempts + 1 WHERE id = $1', [challenge.id])
        throw new Error('邮箱验证码错误')
      }
      await client.query('UPDATE email_verification_challenges SET consumed_at = now() WHERE id = $1', [challenge.id])
      let inviter: any = null
      if (input.inviteCode?.trim()) {
        inviter = await one<any>(client, `SELECT id, invite_code FROM users WHERE invite_code = $1 AND disabled_at IS NULL AND status = 'active'`, [input.inviteCode.trim().toUpperCase()])
        if (!inviter) throw new Error('邀请码无效或已停用')
      }
      let code = createInviteCode()
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          const user = await one<any>(client,
            `INSERT INTO users(username,email,email_verified_at,password_hash,invite_code,invited_by)
             VALUES ($1, $2, now(), $3, $4, $5)
             RETURNING id, username, email, email_verified_at, role, invite_code, created_at`,
            [cleanUsername, email, passwordHash, code, inviter?.id ?? null],
          )
          if (!user) throw new Error('注册失败')
          await client.query('INSERT INTO wallets(user_id) VALUES ($1)', [user.id])
          await client.query('INSERT INTO affiliate_wallets(user_id) VALUES ($1)', [user.id])
          if (inviter) await client.query('INSERT INTO invitation_bindings(invitee_user_id, inviter_user_id, invite_code) VALUES ($1, $2, $3)', [user.id, inviter.id, inviter.invite_code])
          await client.query(
            `INSERT INTO user_consents(user_id,document_key,document_version) VALUES
             ($1,'login_terms','2026-09-01'),($1,'service_terms','2026-09-01'),($1,'privacy_policy','2026-09-01')`,
            [user.id],
          )
          return publicUser(user)
        } catch (error: any) {
          if (error?.code === '23505' && String(error.constraint || '').includes('users_username')) throw new Error('账号已存在')
          if (error?.code === '23505' && String(error.constraint || '').includes('users_email')) throw new Error('邮箱已注册')
          if (error?.code === '23505') { code = createInviteCode(); continue }
          throw error
        }
      }
      throw new Error('注册失败，请稍后重试')
    })
  }

  async login(username: string, password: string): Promise<PublicUser> {
    const row = await this.db.one<any>('SELECT id, username, email, email_verified_at, password_hash, role, invite_code, created_at, disabled_at, status FROM users WHERE lower(username) = $1', [username.trim().toLowerCase()])
    if (!row || row.disabled_at || row.status !== 'active') throw new Error('账号或密码错误')
    const valid = await argon2.verify(row.password_hash, password)
    if (!valid) throw new Error('账号或密码错误')
    await this.db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [row.id])
    return publicUser(row)
  }

  async createApiKey(userId: string, name: string): Promise<{ id: string; name: string; key: string; prefix: string; createdAt: string }> {
    const cleanName = name.trim().slice(0, 80) || '默认 Key'
    const rawKey = createApiKey()
    const row = await this.db.one<any>(
      `INSERT INTO api_keys(user_id, name, key_prefix, key_hash, encrypted_key) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, key_prefix, created_at`,
      [userId, cleanName, keyPrefix(rawKey), hashApiKey(rawKey, this.config.apiKeyPepper), encryptSecret(rawKey, this.config.channelEncryptionKey)],
    )
    if (!row) throw new Error('创建 API Key 失败')
    return { id: String(row.id), name: row.name, key: rawKey, prefix: row.key_prefix, createdAt: new Date(row.created_at).toISOString() }
  }

  async listApiKeys(userId: string): Promise<any[]> {
    const rows = await this.db.query<any>(`SELECT id, name, key_prefix, encrypted_key, created_at, last_used_at, revoked_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`, [userId])
    return rows.map((row) => ({ id: String(row.id), name: row.name, prefix: row.key_prefix, recoveryAvailable: Boolean(row.encrypted_key), createdAt: new Date(row.created_at).toISOString(), lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null, revoked: Boolean(row.revoked_at) }))
  }

  async revokeApiKey(userId: string, id: string): Promise<void> {
    await this.db.query(`UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()), status = 'revoked', updated_at = now() WHERE id = $1 AND user_id = $2`, [id, userId])
  }

  async authenticateApiKey(rawKey: string): Promise<{ user: PublicUser; key: { id: string; name: string }; }> {
    const row = await this.db.one<any>(
      `SELECT k.id AS key_id, k.name AS key_name, u.id, u.username, u.email, u.email_verified_at, u.role, u.invite_code, u.created_at
       FROM api_keys k JOIN users u ON u.id = k.user_id
       WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND k.status = 'active'
         AND (k.expires_at IS NULL OR k.expires_at > now())
         AND u.disabled_at IS NULL AND u.status = 'active'`,
      [hashApiKey(rawKey, this.config.apiKeyPepper)],
    )
    if (!row) throw new Error('无效或已撤销的 API Key')
    void this.db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.key_id])
    return { user: publicUser(row), key: { id: String(row.key_id), name: row.key_name } }
  }

  async getApiKeyForImport(userId: string, keyId: string): Promise<{ id: string; name: string; rawKey: string }> {
    const row = await this.db.one<any>('SELECT id, name, encrypted_key, revoked_at, status FROM api_keys WHERE id = $1 AND user_id = $2', [keyId, userId])
    if (!row || row.revoked_at || row.status !== 'active') {
      throw Object.assign(new Error('API Key 不存在'), { statusCode: 404 })
    }
    if (!row.encrypted_key) {
      throw Object.assign(new Error('旧 Key 无法导入，请创建新的 API Key'), { statusCode: 409 })
    }
    return { id: String(row.id), name: row.name, rawKey: decryptSecret(row.encrypted_key, this.config.channelEncryptionKey) }
  }

  async revealApiKey(userId: string, keyId: string, password: string): Promise<{ id: string; name: string; rawKey: string }> {
    const user = await this.db.one<any>('SELECT password_hash FROM users WHERE id = $1 AND status = \'active\' AND disabled_at IS NULL', [userId])
    if (!user || !await argon2.verify(user.password_hash, password)) {
      throw Object.assign(new Error('当前密码错误'), { statusCode: 401 })
    }
    return this.getApiKeyForImport(userId, keyId)
  }
}
