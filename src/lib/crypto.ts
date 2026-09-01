import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export function hashApiKey(rawKey: string, pepper: string): string {
  return createHash('sha256').update(`${pepper}:${rawKey}`).digest('hex')
}

export function createApiKey(): string {
  return `sk-relay-${randomBytes(24).toString('base64url')}`
}

export function keyPrefix(rawKey: string): string {
  return rawKey.slice(0, 16)
}

export function createInviteCode(): string {
  return randomBytes(6).toString('base64url').toUpperCase()
}

export function encryptSecret(value: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`
}

export function decryptSecret(value: string, key: Buffer): string {
  const [version, ivText, tagText, dataText] = value.split('.')
  if (version !== 'v1' || !ivText || !tagText || !dataText) throw new Error('invalid encrypted secret')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]).toString('utf8')
}

export function secureEquals(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
