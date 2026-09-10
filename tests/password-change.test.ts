import argon2 from 'argon2'
import { describe, expect, test } from 'vitest'
import { AuthService } from '../src/services/auth.js'

const config: any = { adminUsername: 'admin', adminPassword: 'unused', apiKeyPepper: 'test-pepper', channelEncryptionKey: Buffer.alloc(32) }

function passwordDb(currentHash: string) {
  const audit: any[] = []
  return {
    audit,
    one: async () => ({ password_hash: currentHash }),
    tx: async (action: (client: any) => Promise<unknown>) => action({
      query: async (sql: string, values: unknown[]) => {
        if (sql.includes('UPDATE users')) return { rows: [{ id: String(values[1]) }] }
        if (sql.includes('INSERT INTO admin_audit_events')) { audit.push(values); return { rows: [] } }
        return { rows: [] }
      },
    }),
  }
}

describe('self-service password change', () => {
  test('verifies the current password, hashes the replacement, and audits the change', async () => {
    const db = passwordDb(await argon2.hash('current-pass-123', { type: argon2.argon2id }))
    await new AuthService(db as any, config).changePassword('user-1', 'current-pass-123', 'new-pass-456')
    expect(db.audit).toHaveLength(1)
    expect(db.audit[0][0]).toBe('user-1')
    expect(db.audit[0][1]).toBe('user-1')
    expect(db.audit[0][2]).toContain('selfService')
  })

  test('rejects an incorrect current password before changing anything', async () => {
    const db = passwordDb(await argon2.hash('current-pass-123', { type: argon2.argon2id }))
    await expect(new AuthService(db as any, config).changePassword('user-1', 'wrong-pass-123', 'new-pass-456')).rejects.toThrow('当前密码错误')
    expect(db.audit).toHaveLength(0)
  })
})
