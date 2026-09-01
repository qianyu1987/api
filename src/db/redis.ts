import { Redis as RedisClient } from 'ioredis'
import type { AppConfig } from '../config.js'

export class RedisStore {
  readonly client: RedisClient

  constructor(config: AppConfig) {
    this.client = new RedisClient(config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2_000,
      retryStrategy: (times: number) => Math.min(times * 200, 2_000),
    })
    this.client.on('error', () => undefined)
  }

  async connect(): Promise<void> {
    if (this.client.status === 'wait') await this.client.connect()
  }

  async get(key: string): Promise<string | null> {
    try { await this.connect(); return await this.client.get(key) } catch { return null }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    try {
      await this.connect()
      if (ttlSeconds) await this.client.set(key, value, 'EX', ttlSeconds)
      else await this.client.set(key, value)
      return true
    } catch { return false }
  }

  async setNx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    try {
      await this.connect()
      return (await this.client.set(key, value, 'EX', ttlSeconds, 'NX')) === 'OK'
    } catch { return false }
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    try {
      await this.connect()
      const value = await this.client.incr(key)
      if (value === 1 && ttlSeconds) await this.client.expire(key, ttlSeconds)
      return value
    } catch { return 0 }
  }

  async del(key: string): Promise<void> {
    try { await this.connect(); await this.client.del(key) } catch { /* Redis is optional for local boot */ }
  }

  async close(): Promise<void> {
    try { await this.client.quit() } catch { this.client.disconnect() }
  }
}
