import { randomBytes } from 'node:crypto'

export type PaymentConfig = {
  wechat: {
    appId: string
    mchId: string
    merchantSerial: string
    privateKeyPath: string
    apiV3Key: string
    platformCertificatePath: string
    notifyUrl: string
  }
  alipay: {
    appId: string
    privateKeyPath: string
    publicKeyPath: string
    gateway: string
    notifyUrl: string
  }
}

export type AppConfig = {
  env: 'development' | 'test' | 'production'
  host: string
  port: number
  publicBaseUrl: string
  databaseUrl: string
  redisUrl: string
  corsOrigins: string[]
  jwtSecret: string
  cookieSecret: string
  apiKeyPepper: string
  channelEncryptionKey: Buffer
  adminUsername: string
  adminPassword: string
  usageRetentionDays: number
  defaultAffiliateRateBps: number
  chatgptDownloadUrl: string
  ccswitchDownloadUrl: string
  payments: PaymentConfig
}

function text(name: string, fallback = ''): string {
  const value = process.env[name]?.trim()
  return value || fallback
}

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function nonNegativeInt(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback)
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

function list(name: string): string[] {
  return text(name)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

function secret(name: string, env: string, fallback = ''): string {
  const value = text(name, fallback)
  if (env === 'production' && value.length < 32) {
    throw new Error(`${name} must contain at least 32 characters in production`)
  }
  return value || randomBytes(32).toString('hex')
}

function encryptionKey(env: string): Buffer {
  const raw = text('CHANNEL_ENCRYPTION_KEY')
  if (!raw) {
    if (env === 'production') throw new Error('CHANNEL_ENCRYPTION_KEY is required in production')
    return randomBytes(32)
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) throw new Error('CHANNEL_ENCRYPTION_KEY must be a base64-encoded 32-byte key')
  return key
}

export function loadConfig(): AppConfig {
  const rawEnv = text('NODE_ENV', 'development')
  const env = rawEnv === 'production' || rawEnv === 'test' ? rawEnv : 'development'
  const databaseUrl = text('DATABASE_URL', env === 'test' ? 'postgres://unused/test' : '')
  const redisUrl = text('REDIS_URL', env === 'test' ? 'redis://unused' : '')
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  if (!redisUrl) throw new Error('REDIS_URL is required')

  const adminPassword = text('ADMIN_PASSWORD', env === 'production' ? '' : 'change-me-before-production')
  if (env === 'production' && adminPassword.length < 16) {
    throw new Error('ADMIN_PASSWORD must contain at least 16 characters in production')
  }

  const publicBaseUrl = text('PUBLIC_BASE_URL', 'https://api.hhtc.top').replace(/\/$/, '')

  return {
    env,
    host: text('HOST', '0.0.0.0'),
    port: positiveInt('PORT', 3000),
    publicBaseUrl,
    databaseUrl,
    redisUrl,
    corsOrigins: list('CORS_ORIGINS'),
    jwtSecret: secret('JWT_SECRET', env),
    cookieSecret: secret('COOKIE_SECRET', env),
    apiKeyPepper: secret('API_KEY_PEPPER', env),
    channelEncryptionKey: encryptionKey(env),
    adminUsername: text('ADMIN_USERNAME', 'admin'),
    adminPassword,
    usageRetentionDays: positiveInt('USAGE_RETENTION_DAYS', 90),
    defaultAffiliateRateBps: nonNegativeInt('DEFAULT_AFFILIATE_RATE_BPS', 1000),
    chatgptDownloadUrl: text('CHATGPT_DOWNLOAD_URL', 'https://chatgpt.com/download/'),
    ccswitchDownloadUrl: text('CCSWITCH_DOWNLOAD_URL', 'https://github.com/farion1231/cc-switch/releases/latest'),
    payments: {
      wechat: {
        appId: text('WECHAT_APP_ID'),
        mchId: text('WECHAT_MCH_ID'),
        merchantSerial: text('WECHAT_MCH_SERIAL'),
        privateKeyPath: text('WECHAT_PRIVATE_KEY_PATH'),
        apiV3Key: text('WECHAT_API_V3_KEY'),
        platformCertificatePath: text('WECHAT_PLATFORM_CERT_PATH'),
        notifyUrl: text('WECHAT_NOTIFY_URL', `${publicBaseUrl}/api/payments/wechat/notify`),
      },
      alipay: {
        appId: text('ALIPAY_APP_ID'),
        privateKeyPath: text('ALIPAY_PRIVATE_KEY_PATH'),
        publicKeyPath: text('ALIPAY_PUBLIC_KEY_PATH'),
        gateway: text('ALIPAY_GATEWAY', 'https://openapi.alipay.com/gateway.do'),
        notifyUrl: text('ALIPAY_NOTIFY_URL', `${publicBaseUrl}/api/payments/alipay/notify`),
      },
    },
  }
}
