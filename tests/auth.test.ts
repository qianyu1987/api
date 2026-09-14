import { describe, expect, test, vi } from 'vitest'
import { AuthService } from '../src/services/auth.js'

function fakeAuthDb() {
  return {
    tx: async (action: (client: any) => Promise<unknown>) => action({
      query: async (sql: string) => {
        if (sql.includes('INSERT INTO users')) {
          return { rows: [{ id: 'user-1', username: 'tester', email: null, email_verified_at: null, role: 'user', invite_code: 'INVITE1', created_at: new Date().toISOString() }] }
        }
        return { rows: [] }
      },
    }),
  }
}

const config: any = {
  adminUsername: 'admin', adminPassword: 'x', apiKeyPepper: 'test-pepper', channelEncryptionKey: Buffer.alloc(32),
}

describe('registration email policy', () => {
  test('allows registration without an email or verification code', async () => {
    const user = await new AuthService(fakeAuthDb() as any, config).register('tester', 'password123', { termsAccepted: true })
    expect(user).toMatchObject({ username: 'tester', email: null, emailVerified: false })
  })

  test('still validates an email when one is supplied', async () => {
    await expect(new AuthService(fakeAuthDb() as any, config).register('tester', 'password123', { email: 'invalid', termsAccepted: true }))
      .rejects.toThrow('邮箱格式无效')
  })
})

describe('registration wallet gift', () => {
  test('credits exactly three yuan and records a gift ledger in the registration transaction', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('INSERT INTO users') ? [{ id: 'new-user', username: 'new-user', role: 'user', invite_code: 'INVITE', created_at: new Date() }] : [] }))
    const tx = vi.fn(async (action: any) => action({ query }))
    await new AuthService({ tx } as any, config).register('new-user', 'password123', { termsAccepted: true })
    expect(tx).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith('INSERT INTO wallets(user_id,balance_micros) VALUES ($1,$2)', ['new-user', '3000000'])
    const credits = query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO wallet_ledger'))
    expect(credits).toHaveLength(1)
    expect((credits[0] as any)[1]).toEqual(['new-user', '3000000', '新用户注册赠送 3 元', JSON.stringify({ source: 'registration_gift', amountMicros: '3000000' })])
  })
  test('duplicate registration cannot insert a wallet or gift ledger', async () => {
    const query = vi.fn(async () => { throw Object.assign(new Error('duplicate'), { code: '23505', constraint: 'users_username_unique' }) })
    await expect(new AuthService({ tx: async (fn: any) => fn({ query }) } as any, config).register('tester', 'password123', { termsAccepted: true })).rejects.toThrow('账号已存在')
    expect(query).toHaveBeenCalledTimes(1)
  })
})
