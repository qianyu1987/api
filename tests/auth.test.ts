import { describe, expect, test } from 'vitest'
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
