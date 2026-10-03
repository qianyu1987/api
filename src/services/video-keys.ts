import { decryptSecret, encryptSecret } from '../lib/crypto.js'
import { Database, one, query, type DbClient } from '../db/index.js'
import type { AppConfig } from '../config.js'
import { mediaPrice } from '../lib/media.js'
import { profitRules } from './profit.js'

export const AGNES_VIDEO_BASE_URL = 'https://apihub.agnes-ai.com/v1'
export const AGNES_VIDEO_MODEL = 'agnes-video-2.5-flash'
export const VIDEO_DAILY_LIMIT_SECONDS = 500
export const VIDEO_UNIT_PRICE_MICROS = 35_000

type VideoKeyRow = {
  id: string
  channel_id: string
  account_label: string
  daily_limit_seconds: number | string
  timezone: string
  max_concurrency: number | string
  priority: number | string
  enabled: boolean
  video_generation_enabled: boolean
  prompt_expansion_enabled: boolean
  probe_status: 'pending' | 'passed' | 'failed'
  last_probe_at: string | Date | null
  last_probe_error: string | null
  last_success_at: string | Date | null
  latency_p50_ms: number | string | null
  latency_p95_ms: number | string | null
  latency_ewma_ms: number | string | null
  success_count: number | string
  failure_count: number | string
  cooldown_until: string | Date | null
  subscription_cost_micros: number | string | null
  subscription_duration_days: number | string | null
  actual_cost_per_second_micros: number | string | null
  channel_enabled?: boolean
  channel_deleted_at?: string | Date | null
  encrypted_api_key?: string | null
  base_url?: string
  usage_day?: string
  reserved_seconds?: number | string | null
  used_seconds?: number | string | null
  released_seconds?: number | string | null
  limit_seconds?: number | string | null
  active_count?: number | string | null
  queued_count?: number | string | null
}

export type VideoKeyAdmin = {
  id: string
  channelId: string
  accountLabel: string
  keySuffix: string | null
  dailyLimitSeconds: number
  usageDay: string
  timezone: string
  reservedSeconds: number
  usedSeconds: number
  releasedSeconds: number
  remainingSeconds: number
  maxConcurrency: number
  activeCount: number
  queuedCount: number
  priority: number
  enabled: boolean
  videoGenerationEnabled: boolean
  promptExpansionEnabled: boolean
  probeStatus: VideoKeyRow['probe_status']
  lastProbeAt: string | Date | null
  lastProbeError: string | null
  lastSuccessAt: string | Date | null
  latencyP50Ms: number | null
  latencyP95Ms: number | null
  latencyEwmaMs: number | null
  successCount: number
  failureCount: number
  cooldownUntil: string | Date | null
  subscriptionCostMicros: string | null
  subscriptionDurationDays: number | null
  actualCostPerSecondMicros: string | null
  status: 'ready' | 'near_limit' | 'exhausted' | 'paused' | 'probe_failed' | 'cooldown' | 'pending_probe'
}

export type VideoKeySelection = {
  id: string
  channelId: string
  accountLabel: string
  baseUrl: string
  encryptedApiKey: string
  quotaDay: string
  reservedSeconds: number
  maxConcurrency: number
  activeCount: number
  priority: number
  latencyEwmaMs: number | null
  latencyP95Ms: number | null
  successRate: number
}

export type VideoKeyInput = {
  accountLabel: string
  apiKey?: string
  channelId?: string
  dailyLimitSeconds?: number
  timezone?: string
  maxConcurrency?: number
  priority?: number
  enabled?: boolean
  videoGenerationEnabled?: boolean
  promptExpansionEnabled?: boolean
  subscriptionCostMicros?: number | string | null
  subscriptionDurationDays?: number | null
  actualCostPerSecondMicros?: number | string | null
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value ?? fallback)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`数值必须在 ${min}-${max} 之间`)
  return n
}

function optionalMicros(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (!/^[0-9]+$/.test(String(value))) throw new Error('成本必须是非负整数微元')
  return String(value)
}

/** Local calendar date used by each subscription's configured timezone. */
export function usageDayForTimezone(timezone = 'Asia/Shanghai', now = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now)
    const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
    if (values.year && values.month && values.day) return `${values.year}-${values.month}-${values.day}`
  } catch { /* use UTC fallback for an invalid administrator timezone */ }
  return now.toISOString().slice(0, 10)
}

export function validTimezone(timezone: string): boolean {
  try { new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(); return true } catch { return false }
}

export function maskProviderKey(raw: string | null | undefined): string | null {
  if (!raw) return null
  const value = String(raw)
  return value.length <= 4 ? `***${value}` : `***${value.slice(-4)}`
}

export function fixedVideoPriceMicros(seconds: number): bigint {
  const units = integer(seconds, 0, 1, 86400)
  return BigInt(units) * BigInt(VIDEO_UNIT_PRICE_MICROS)
}

export type VideoKeyCost = {
  micros: bigint | null
  source: 'actual_cost_per_second_micros' | 'subscription_cost_per_second_micros' | 'mixed_key_costs' | null
}

function nonNegativeMicros(value: unknown): bigint | null {
  if (value === null || value === undefined || value === '') return null
  const text = String(value)
  return /^\d+$/.test(text) ? BigInt(text) : null
}

/**
 * Resolve the conservative per-second cost of the configured Agnes pool.
 * An explicitly verified actual cost wins per key; otherwise the subscription
 * cost is amortized across its valid days and the contracted 500 seconds/day.
 * The highest key cost is used so adding a more expensive account cannot make
 * the fixed public price pass the margin guardrail by accident.
 */
export function deriveVideoKeyCost(rows: Array<Pick<VideoKeyRow, 'actual_cost_per_second_micros' | 'subscription_cost_micros' | 'subscription_duration_days'>>): VideoKeyCost {
  let maximum: bigint | null = null
  let actualCount = 0
  let subscriptionCount = 0
  for (const row of rows) {
    const actual = nonNegativeMicros(row.actual_cost_per_second_micros)
    let cost = actual
    if (actual !== null) actualCount += 1
    else {
      const subscription = nonNegativeMicros(row.subscription_cost_micros)
      const days = Number(row.subscription_duration_days)
      if (subscription !== null && Number.isInteger(days) && days > 0) {
        const divisor = BigInt(days) * BigInt(VIDEO_DAILY_LIMIT_SECONDS)
        cost = (subscription + divisor - 1n) / divisor
        subscriptionCount += 1
      }
    }
    if (cost !== null && (maximum === null || cost > maximum)) maximum = cost
  }
  const source = maximum === null ? null : actualCount > 0 && subscriptionCount > 0
    ? 'mixed_key_costs'
    : actualCount > 0 ? 'actual_cost_per_second_micros' : 'subscription_cost_per_second_micros'
  return { micros: maximum, source }
}

function statusFor(row: VideoKeyRow, remaining: number): VideoKeyAdmin['status'] {
  if (!row.enabled || !row.video_generation_enabled || row.channel_enabled === false || row.channel_deleted_at) return 'paused'
  if (row.probe_status === 'failed') return 'probe_failed'
  if (row.probe_status !== 'passed') return 'pending_probe'
  if (row.cooldown_until && new Date(row.cooldown_until).getTime() > Date.now()) return 'cooldown'
  if (remaining <= 0) return 'exhausted'
  if (remaining <= Math.max(1, Math.floor(Number(row.daily_limit_seconds) * 0.1))) return 'near_limit'
  return 'ready'
}

function publicRow(row: VideoKeyRow, config: AppConfig): VideoKeyAdmin {
  const limit = Number(row.limit_seconds ?? row.daily_limit_seconds)
  const reserved = Number(row.reserved_seconds || 0)
  const used = Number(row.used_seconds || 0)
  const released = Number(row.released_seconds || 0)
  let keySuffix: string | null = null
  if (row.encrypted_api_key) {
    try { keySuffix = maskProviderKey(decryptSecret(row.encrypted_api_key, config.channelEncryptionKey)) } catch { keySuffix = null }
  }
  return {
    id: String(row.id), channelId: String(row.channel_id), accountLabel: row.account_label,
    keySuffix, dailyLimitSeconds: limit, usageDay: String(row.usage_day || usageDayForTimezone(row.timezone)), timezone: row.timezone,
    reservedSeconds: reserved, usedSeconds: used, releasedSeconds: released,
    remainingSeconds: Math.max(0, limit - used - reserved), maxConcurrency: Number(row.max_concurrency),
    activeCount: Number(row.active_count || 0), queuedCount: Number(row.queued_count || 0), priority: Number(row.priority),
    enabled: Boolean(row.enabled), videoGenerationEnabled: Boolean(row.video_generation_enabled),
    promptExpansionEnabled: Boolean(row.prompt_expansion_enabled), probeStatus: row.probe_status,
    lastProbeAt: row.last_probe_at, lastProbeError: row.last_probe_error, lastSuccessAt: row.last_success_at,
    latencyP50Ms: row.latency_p50_ms === null || row.latency_p50_ms === undefined ? null : Number(row.latency_p50_ms),
    latencyP95Ms: row.latency_p95_ms === null || row.latency_p95_ms === undefined ? null : Number(row.latency_p95_ms),
    latencyEwmaMs: row.latency_ewma_ms === null || row.latency_ewma_ms === undefined ? null : Number(row.latency_ewma_ms),
    successCount: Number(row.success_count || 0), failureCount: Number(row.failure_count || 0), cooldownUntil: row.cooldown_until,
    subscriptionCostMicros: row.subscription_cost_micros === null || row.subscription_cost_micros === undefined ? null : String(row.subscription_cost_micros),
    subscriptionDurationDays: row.subscription_duration_days === null || row.subscription_duration_days === undefined ? null : Number(row.subscription_duration_days),
    actualCostPerSecondMicros: row.actual_cost_per_second_micros === null || row.actual_cost_per_second_micros === undefined ? null : String(row.actual_cost_per_second_micros),
    status: statusFor(row, Math.max(0, limit - used - reserved)),
  }
}

/** Stable speed/priority ordering used both by the worker and unit tests. */
export function rankVideoCandidates<T extends {
  activeCount?: number | string | null
  latencyP95Ms?: number | string | null
  latencyEwmaMs?: number | string | null
  successCount?: number | string
  failureCount?: number | string
  priority?: number | string
  id: string
}>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const active = Number(a.activeCount || 0) - Number(b.activeCount || 0)
    if (active) return active
    const ae = a.latencyEwmaMs == null ? null : Number(a.latencyEwmaMs)
    const be = b.latencyEwmaMs == null ? null : Number(b.latencyEwmaMs)
    if (ae !== null || be !== null) {
      const av = ae === null || !Number.isFinite(ae) ? Number.POSITIVE_INFINITY : ae
      const bv = be === null || !Number.isFinite(be) ? Number.POSITIVE_INFINITY : be
      if (av !== bv) return av - bv
    }
    const ap = a.latencyP95Ms == null ? Number.POSITIVE_INFINITY : Number(a.latencyP95Ms)
    const bp = b.latencyP95Ms == null ? Number.POSITIVE_INFINITY : Number(b.latencyP95Ms)
    if (ap !== bp) return ap - bp
    const aSuccess = Number(a.successCount || 0)
    const bSuccess = Number(b.successCount || 0)
    const aFailure = Number(a.failureCount || 0)
    const bFailure = Number(b.failureCount || 0)
    const aRate = aSuccess + aFailure > 0 ? aSuccess / (aSuccess + aFailure) : 0
    const bRate = bSuccess + bFailure > 0 ? bSuccess / (bSuccess + bFailure) : 0
    if (aRate !== bRate) return bRate - aRate
    const priority = Number(a.priority || 0) - Number(b.priority || 0)
    return priority || String(a.id).localeCompare(String(b.id))
  })
}

export class VideoKeyService {
  constructor(private readonly db: Database, private readonly config: AppConfig) {}

  private async adminRows(): Promise<VideoKeyRow[]> {
    return this.db.query<VideoKeyRow>(`SELECT vk.*, c.base_url, c.encrypted_api_key, c.enabled AS channel_enabled, c.deleted_at AS channel_deleted_at,
      u.usage_day, u.reserved_seconds, u.used_seconds, u.released_seconds, u.limit_seconds,
      (SELECT count(*)::int FROM media_tasks mt WHERE mt.video_provider_key_id=vk.id
        AND mt.status IN ('queued','submitting','processing','unknown')) AS active_count,
      (SELECT count(*)::int FROM media_tasks mt WHERE mt.video_provider_key_id=vk.id
        AND mt.status='queued') AS queued_count
      FROM video_provider_keys vk
      JOIN channels c ON c.id=vk.channel_id
      LEFT JOIN video_key_usage_daily u ON u.key_id=vk.id
        AND u.usage_day=((now() AT TIME ZONE vk.timezone)::date)
      ORDER BY vk.priority, vk.created_at, vk.id`)
  }

  async list(): Promise<VideoKeyAdmin[]> {
    return (await this.adminRows()).map((row) => publicRow(row, this.config))
  }

  async overview(): Promise<{ keys: VideoKeyAdmin[]; availableKeys: number; remainingSeconds: number; queueCount: number; fastestKey: VideoKeyAdmin | null; pricing: Record<string, unknown> }> {
    const keys = await this.list()
    const available = keys.filter((key) => key.status === 'ready' || key.status === 'near_limit')
    const queueRows = await this.db.query<{ count: string }>(`SELECT count(*)::text AS count FROM media_tasks WHERE kind='video' AND status IN ('queued','submitting')`)
    const fastest = [...available].sort((a, b) => (a.latencyP95Ms ?? Number.POSITIVE_INFINITY) - (b.latencyP95Ms ?? Number.POSITIVE_INFINITY) || a.priority - b.priority || a.id.localeCompare(b.id))[0] || null
    const price = await this.db.one<any>(`SELECT enabled,price_mode,fixed_unit_price_micros,normal_cost_micros,actual_cost_micros,cost_source
      FROM media_prices WHERE model=$1 AND size='720P'`, [AGNES_VIDEO_MODEL])
    const keyCostRows = await this.db.query<any>(`SELECT vk.actual_cost_per_second_micros,vk.subscription_cost_micros,vk.subscription_duration_days
      FROM video_provider_keys vk JOIN channels c ON c.id=vk.channel_id AND c.enabled AND c.deleted_at IS NULL
      WHERE vk.enabled AND vk.video_generation_enabled AND vk.probe_status='passed'
        AND (vk.actual_cost_per_second_micros IS NOT NULL
          OR (vk.subscription_cost_micros IS NOT NULL AND vk.subscription_duration_days IS NOT NULL))`)
    const keyCost = deriveVideoKeyCost(keyCostRows)
    const fallbackActual = Math.max(Number(price?.actual_cost_micros || 0), Number(price?.normal_cost_micros || 0))
    const actual = keyCost.micros ?? BigInt(fallbackActual)
    const unit = Number(price?.fixed_unit_price_micros || VIDEO_UNIT_PRICE_MICROS)
    const settings = Object.fromEntries((await this.db.query<any>('SELECT key,value FROM app_settings')).map((row) => [row.key, row.value]))
    const rules = profitRules(settings)
    const multiplier = Math.max(rules.walletTopupMultiplierBps, this.config.walletTopupMultiplierBps)
    const minimumUnit = actual > 0n ? Number(mediaPrice(actual, multiplier, rules.paymentFeeRateBps, rules.affiliateRateBps, rules.minimumMarginBps)) : 0
    const marginOk = actual > 0n && unit >= minimumUnit
    return {
      keys, availableKeys: available.length,
      remainingSeconds: available.reduce((sum, key) => sum + key.remainingSeconds, 0),
      queueCount: Number(queueRows[0]?.count || 0), fastestKey: fastest,
      pricing: {
        pricePerSecondMicros: unit,
        specs: [4, 10, 12].map((seconds) => ({ seconds, priceMicros: unit * seconds })),
        actualCostPerSecondMicros: Number(actual),
        costSource: keyCost.source || price?.cost_source || null,
        enabled: Boolean(price?.enabled),
        available: Boolean(price?.enabled && price?.price_mode === 'fixed' && unit > 0 && marginOk),
        marginOk,
        marginPercent: unit > 0 ? ((unit - Number(actual)) / unit) * 100 : 0,
      },
    }
  }

  async add(input: VideoKeyInput, actorId?: string): Promise<VideoKeyAdmin> {
    const accountLabel = String(input.accountLabel || '').trim()
    if (accountLabel.length < 1 || accountLabel.length > 128) throw new Error('请填写 1-128 个字符的账号标签')
    const dailyLimit = integer(input.dailyLimitSeconds, VIDEO_DAILY_LIMIT_SECONDS, 1, 86400)
    const maxConcurrency = integer(input.maxConcurrency, 1, 1, 64)
    const priority = integer(input.priority, 100, 0, 1_000_000)
    const timezone = String(input.timezone || 'Asia/Shanghai').trim()
    // Validate before creating a channel so a bad timezone cannot leave a
    // half-created provider credential behind.
    if (!validTimezone(timezone)) throw new Error('时区无效')
    usageDayForTimezone(timezone)
    const encrypted = input.apiKey?.trim() ? encryptSecret(input.apiKey.trim(), this.config.channelEncryptionKey) : null
    if (!input.channelId && !encrypted) throw new Error('新增 Agnes Key 必须填写 Key')
    const row = await this.db.tx(async (client) => {
      let channel: any
      if (input.channelId) {
        channel = await one<any>(client, 'SELECT id,base_url,encrypted_api_key FROM channels WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [input.channelId])
        if (!channel) throw Object.assign(new Error('渠道不存在或已删除'), { statusCode: 404 })
        if (channel.base_url !== AGNES_VIDEO_BASE_URL) throw new Error('视频 Key 只能使用 Agnes 视频接口')
        if (encrypted) await client.query('UPDATE channels SET encrypted_api_key=$2,enabled=false,updated_at=now() WHERE id=$1', [channel.id, encrypted])
      } else {
        channel = await one<any>(client, `INSERT INTO channels(name,base_url,encrypted_api_key,model_map,priority,enabled)
          VALUES($1,$2,$3,$4,$5,false) RETURNING id,base_url,encrypted_api_key`, [`Agnes 视频 · ${accountLabel}`, AGNES_VIDEO_BASE_URL, encrypted, JSON.stringify({ [AGNES_VIDEO_MODEL]: AGNES_VIDEO_MODEL }), priority])
      }
      const provider = await one<any>(client, `INSERT INTO video_provider_keys(channel_id,account_label,daily_limit_seconds,timezone,max_concurrency,priority,enabled,video_generation_enabled,prompt_expansion_enabled,subscription_cost_micros,subscription_duration_days,actual_cost_per_second_micros)
        VALUES($1,$2,$3,$4,$5,$6,false,false,$7,$8,$9,$10) RETURNING id`, [channel.id, accountLabel, dailyLimit, timezone, maxConcurrency, priority, Boolean(input.promptExpansionEnabled), optionalMicros(input.subscriptionCostMicros), input.subscriptionDurationDays === null || input.subscriptionDurationDays === undefined ? null : integer(input.subscriptionDurationDays, 30, 1, 3660), optionalMicros(input.actualCostPerSecondMicros)])
      if (!provider) throw new Error('视频 Key 保存失败')
      await client.query(`INSERT INTO config_audit_logs(actor_user_id,resource_type,resource_id,before_value,after_value)
        VALUES($1,'video_provider_key',$2,NULL,$3)`, [actorId || null, provider.id, JSON.stringify({ accountLabel, channelId: channel.id, dailyLimitSeconds: dailyLimit, timezone, maxConcurrency, priority, enabled: false, probeStatus: 'pending' })])
      return provider
    })
    const result = (await this.db.query<VideoKeyRow>(`SELECT vk.*, c.base_url,c.encrypted_api_key FROM video_provider_keys vk JOIN channels c ON c.id=vk.channel_id WHERE vk.id=$1`, [row.id]))[0]
    if (!result) throw new Error('视频 Key 保存后读取失败')
    return publicRow(result, this.config)
  }

  async update(id: string, input: Partial<VideoKeyInput>, actorId?: string): Promise<VideoKeyAdmin> {
    if (Object.prototype.hasOwnProperty.call(input, 'apiKey')) {
      throw new Error('请使用“轮换”操作修改 Agnes Key')
    }
    const row = await this.db.tx(async (client) => {
      const current = await one<any>(client, 'SELECT * FROM video_provider_keys WHERE id=$1 FOR UPDATE', [id])
      if (!current) throw Object.assign(new Error('视频 Key 不存在'), { statusCode: 404 })
      const accountLabel = String(input.accountLabel ?? current.account_label).trim()
      if (accountLabel.length < 1 || accountLabel.length > 128) throw new Error('请填写 1-128 个字符的账号标签')
      const dailyLimit = input.dailyLimitSeconds === undefined ? Number(current.daily_limit_seconds) : integer(input.dailyLimitSeconds, 500, 1, 86400)
      const maxConcurrency = input.maxConcurrency === undefined ? Number(current.max_concurrency) : integer(input.maxConcurrency, 1, 1, 64)
      const priority = input.priority === undefined ? Number(current.priority) : integer(input.priority, 100, 0, 1_000_000)
      const timezone = input.timezone === undefined ? current.timezone : String(input.timezone || '').trim()
      if (!validTimezone(timezone)) throw new Error('时区无效')
      usageDayForTimezone(timezone)
      const enabled = input.enabled === undefined ? Boolean(current.enabled) : Boolean(input.enabled)
      const videoEnabled = input.videoGenerationEnabled === undefined ? Boolean(current.video_generation_enabled) : Boolean(input.videoGenerationEnabled)
      if ((enabled || videoEnabled) && current.probe_status !== 'passed') throw new Error('Key 必须先通过无计费连接测试')
      // Keep an existing local-day ledger aligned with a changed limit. Never
      // lower it below seconds already used or reserved in that bucket.
      const day = usageDayForTimezone(timezone)
      const usage = await one<any>(client, 'SELECT * FROM video_key_usage_daily WHERE key_id=$1 AND usage_day=$2 FOR UPDATE', [id, day])
      if (usage && Number(usage.used_seconds || 0) + Number(usage.reserved_seconds || 0) > dailyLimit) {
        throw new Error('每日上限不能低于今日已用或已预留秒数')
      }
      if (usage) {
        await client.query('UPDATE video_key_usage_daily SET limit_seconds=$3,updated_at=now() WHERE key_id=$1 AND usage_day=$2', [id, day, dailyLimit])
      }
      const after = await one<any>(client, `UPDATE video_provider_keys SET account_label=$2,daily_limit_seconds=$3,timezone=$4,max_concurrency=$5,priority=$6,enabled=$7,video_generation_enabled=$8,prompt_expansion_enabled=$9,subscription_cost_micros=$10,subscription_duration_days=$11,actual_cost_per_second_micros=$12,updated_at=now() WHERE id=$1 RETURNING *`, [id, String(input.accountLabel ?? current.account_label).trim(), dailyLimit, timezone, maxConcurrency, priority, enabled, videoEnabled, input.promptExpansionEnabled === undefined ? current.prompt_expansion_enabled : Boolean(input.promptExpansionEnabled), input.subscriptionCostMicros === undefined ? current.subscription_cost_micros : optionalMicros(input.subscriptionCostMicros), input.subscriptionDurationDays === undefined ? current.subscription_duration_days : (input.subscriptionDurationDays === null ? null : integer(input.subscriptionDurationDays, 30, 1, 3660)), input.actualCostPerSecondMicros === undefined ? current.actual_cost_per_second_micros : optionalMicros(input.actualCostPerSecondMicros)])
      // The general channel is an implementation detail of the video key. It
      // must follow the pool switch or the scheduler would filter every key.
      await client.query('UPDATE channels SET enabled=$2,updated_at=now() WHERE id=(SELECT channel_id FROM video_provider_keys WHERE id=$1)', [id, enabled && videoEnabled])
      await client.query(`INSERT INTO config_audit_logs(actor_user_id,resource_type,resource_id,before_value,after_value) VALUES($1,'video_provider_key',$2,$3,$4)`, [actorId || null, id, JSON.stringify({ accountLabel: current.account_label, dailyLimitSeconds: current.daily_limit_seconds, timezone: current.timezone, maxConcurrency: current.max_concurrency, priority: current.priority, enabled: current.enabled, videoGenerationEnabled: current.video_generation_enabled, promptExpansionEnabled: current.prompt_expansion_enabled }), JSON.stringify({ accountLabel: after.account_label, dailyLimitSeconds: after.daily_limit_seconds, timezone: after.timezone, maxConcurrency: after.max_concurrency, priority: after.priority, enabled: after.enabled, videoGenerationEnabled: after.video_generation_enabled, promptExpansionEnabled: after.prompt_expansion_enabled })])
      return after
    })
    const joined = await this.db.one<VideoKeyRow>('SELECT vk.*, c.base_url,c.encrypted_api_key FROM video_provider_keys vk JOIN channels c ON c.id=vk.channel_id WHERE vk.id=$1', [row.id])
    return publicRow(joined || row, this.config)
  }

  async rotate(id: string, apiKey: string, actorId?: string): Promise<VideoKeyAdmin> {
    if (!String(apiKey || '').trim()) throw new Error('请填写新的 Agnes Key')
    const encrypted = encryptSecret(String(apiKey).trim(), this.config.channelEncryptionKey)
    await this.db.tx(async (client) => {
      const current = await one<any>(client, 'SELECT vk.id,c.id AS channel_id FROM video_provider_keys vk JOIN channels c ON c.id=vk.channel_id WHERE vk.id=$1 FOR UPDATE', [id])
      if (!current) throw Object.assign(new Error('视频 Key 不存在'), { statusCode: 404 })
      await client.query('UPDATE channels SET encrypted_api_key=$2,enabled=false,updated_at=now() WHERE id=$1', [current.channel_id, encrypted])
      await client.query(`UPDATE video_provider_keys SET enabled=false,video_generation_enabled=false,probe_status='pending',last_probe_error=NULL,last_probe_at=NULL,updated_at=now() WHERE id=$1`, [id])
      await client.query(`INSERT INTO config_audit_logs(actor_user_id,resource_type,resource_id,before_value,after_value) VALUES($1,'video_provider_key',$2,NULL,$3)`, [actorId || null, id, JSON.stringify({ action: 'rotate', enabled: false, probeStatus: 'pending' })])
    })
    const row = await this.db.one<VideoKeyRow>('SELECT vk.*,c.base_url,c.encrypted_api_key FROM video_provider_keys vk JOIN channels c ON c.id=vk.channel_id WHERE vk.id=$1', [id])
    return publicRow(row!, this.config)
  }

  async probe(id: string, actorId?: string): Promise<{ ok: boolean; status: VideoKeyAdmin['probeStatus']; message: string }> {
    const row = await this.db.one<VideoKeyRow>('SELECT vk.*,c.base_url,c.encrypted_api_key FROM video_provider_keys vk JOIN channels c ON c.id=vk.channel_id WHERE vk.id=$1', [id])
    if (!row) throw Object.assign(new Error('视频 Key 不存在'), { statusCode: 404 })
    let ok = false
    let message = '连接测试失败，请检查 Key'
    try {
      if (row.base_url !== AGNES_VIDEO_BASE_URL || !row.encrypted_api_key) throw new Error('unsupported provider')
      const response = await fetch(`${AGNES_VIDEO_BASE_URL}/models`, { headers: { authorization: `Bearer ${decryptSecret(row.encrypted_api_key, this.config.channelEncryptionKey)}` }, signal: AbortSignal.timeout(15_000), redirect: 'error' })
      const data: any = response.headers.get('content-type')?.includes('json') ? await response.json() : null
      ok = response.ok && Array.isArray(data?.data)
      if (!ok) message = `上游连接测试返回 HTTP ${response.status}`
      else message = '连接测试通过（未发起视频生成）'
    } catch { /* never persist provider response bodies or credentials */ }
    await this.db.tx(async (client) => {
      // A rotation can happen while the network probe is in flight. Match the
      // encrypted credential captured above so a stale probe cannot re-enable
      // or mark the replacement credential as passed.
      const updated = await client.query(`UPDATE video_provider_keys vk SET probe_status=$2,last_probe_at=now(),last_probe_error=$3,updated_at=now()
        FROM channels c WHERE vk.id=$1 AND c.id=vk.channel_id AND c.base_url=$4 AND c.encrypted_api_key=$5`, [id, ok ? 'passed' : 'failed', ok ? null : message, AGNES_VIDEO_BASE_URL, row.encrypted_api_key])
      if (!updated.rowCount) throw Object.assign(new Error('Key 在测试期间已轮换，请重新测试'), { statusCode: 409 })
      await client.query(`INSERT INTO config_audit_logs(actor_user_id,resource_type,resource_id,before_value,after_value) VALUES($1,'video_provider_key_probe',$2,NULL,$3)`, [actorId || null, id, JSON.stringify({ ok, status: ok ? 'passed' : 'failed' })])
    })
    return { ok, status: ok ? 'passed' : 'failed', message }
  }

  async resetUsage(id: string, reason: string, actorId?: string): Promise<void> {
    if (String(reason || '').trim().length < 4) throw new Error('请填写至少 4 个字符的重置原因')
    await this.db.tx(async (client) => {
      const row = await one<VideoKeyRow>(client, 'SELECT * FROM video_provider_keys WHERE id=$1 FOR UPDATE', [id])
      if (!row) throw Object.assign(new Error('视频 Key 不存在'), { statusCode: 404 })
      const day = usageDayForTimezone(row.timezone)
      const usage = await one<any>(client, 'SELECT * FROM video_key_usage_daily WHERE key_id=$1 AND usage_day=$2 FOR UPDATE', [id, day])
      if (usage && (Number(usage.reserved_seconds || 0) > 0 || Number(usage.used_seconds || 0) > 0)) {
        throw new Error('今日已有生成任务或已用额度，不能重置；请等待任务结束并保留已用账本')
      }
      await client.query(`INSERT INTO video_key_usage_daily(key_id,usage_day,limit_seconds) VALUES($1,$2,$3)
        ON CONFLICT(key_id,usage_day) DO UPDATE SET reserved_seconds=0,released_seconds=0,limit_seconds=EXCLUDED.limit_seconds,updated_at=now()`, [id, day, row.daily_limit_seconds])
      await client.query(`INSERT INTO config_audit_logs(actor_user_id,resource_type,resource_id,before_value,after_value) VALUES($1,'video_provider_key_usage_reset',$2,NULL,$3)`, [actorId || null, id, JSON.stringify({ usageDay: day, reason: String(reason).trim().slice(0, 500) })])
    })
  }

  /** Reserve seconds for a queued task. Call from a transaction-aware worker. */
  async reserveForTask(taskId: string, seconds: number): Promise<VideoKeySelection | null> {
    const amount = integer(seconds, 0, 1, 86400)
    return this.db.tx(async (client) => this.reserveInTransaction(client, taskId, amount))
  }

  private async reserveInTransaction(client: DbClient, taskId: string, amount: number): Promise<VideoKeySelection | null> {
    const rows = await query<VideoKeyRow>(client, `SELECT vk.*,c.base_url,c.encrypted_api_key,
      (SELECT count(*)::int FROM media_tasks mt WHERE mt.video_provider_key_id=vk.id AND mt.status IN ('queued','submitting','processing','unknown')) AS active_count
      FROM video_provider_keys vk JOIN channels c ON c.id=vk.channel_id
      WHERE c.base_url=$1 AND c.enabled AND c.deleted_at IS NULL AND c.encrypted_api_key IS NOT NULL
        AND vk.enabled AND vk.video_generation_enabled AND vk.probe_status='passed'
        AND (vk.cooldown_until IS NULL OR vk.cooldown_until<=now())
      ORDER BY COALESCE((SELECT count(*) FROM media_tasks mt WHERE mt.video_provider_key_id=vk.id AND mt.status IN ('queued','submitting','processing','unknown')),0), vk.latency_ewma_ms NULLS LAST, vk.latency_p95_ms NULLS LAST, vk.priority, vk.id
      FOR UPDATE OF vk SKIP LOCKED`, [AGNES_VIDEO_BASE_URL])
    type RankedVideoRow = VideoKeyRow & {
      activeCount?: number | string | null
      latencyP95Ms?: number | string | null
      latencyEwmaMs?: number | string | null
      successCount?: number | string
      failureCount?: number | string
    }
    const ranked = rankVideoCandidates<RankedVideoRow>(rows.map((row) => ({
      ...row,
      id: String(row.id),
      activeCount: row.active_count,
      latencyP95Ms: row.latency_p95_ms,
      latencyEwmaMs: row.latency_ewma_ms,
      successCount: row.success_count,
      failureCount: row.failure_count,
      priority: row.priority,
    })))
    for (const row of ranked) {
      const day = usageDayForTimezone(row.timezone)
      await client.query(`INSERT INTO video_key_usage_daily(key_id,usage_day,limit_seconds) VALUES($1,$2,$3) ON CONFLICT(key_id,usage_day) DO NOTHING`, [row.id, day, row.daily_limit_seconds])
      const usage = await one<any>(client, 'SELECT * FROM video_key_usage_daily WHERE key_id=$1 AND usage_day=$2 FOR UPDATE', [row.id, day])
      if (!usage) continue
      const active = Number(row.active_count || 0)
      if (active >= Number(row.max_concurrency) || Number(usage.used_seconds) + Number(usage.reserved_seconds) + amount > Number(usage.limit_seconds)) continue
      const updated = await one<any>(client, `UPDATE video_key_usage_daily SET reserved_seconds=reserved_seconds+$3,updated_at=now() WHERE key_id=$1 AND usage_day=$2 AND used_seconds+reserved_seconds+$3<=limit_seconds RETURNING reserved_seconds`, [row.id, day, amount])
      if (!updated) continue
      const successCount = Number(row.success_count || 0)
      const failureCount = Number(row.failure_count || 0)
      const successRate = successCount + failureCount > 0 ? successCount / (successCount + failureCount) : 0
      const latencyEwmaMs = row.latency_ewma_ms == null ? null : Number(row.latency_ewma_ms)
      const latencyP95Ms = row.latency_p95_ms == null ? null : Number(row.latency_p95_ms)
      await client.query(`UPDATE media_tasks SET video_provider_key_id=$2,quota_day=$3,quota_seconds_reserved=$4,selection_snapshot=$5 WHERE id=$1 AND status IN ('queued','submitting')`, [taskId, row.id, day, amount, JSON.stringify({ accountLabel: row.account_label, priority: row.priority, latencyEwmaMs, latencyP95Ms, successRate, selectedAt: new Date().toISOString() })])
      return { id: String(row.id), channelId: String(row.channel_id), accountLabel: row.account_label, baseUrl: String(row.base_url), encryptedApiKey: String(row.encrypted_api_key), quotaDay: day, reservedSeconds: amount, maxConcurrency: Number(row.max_concurrency), activeCount: active, priority: Number(row.priority), latencyEwmaMs, latencyP95Ms, successRate }
    }
    return null
  }

  async acceptTask(taskId: string, upstreamTaskId: string): Promise<boolean> {
    if (!String(upstreamTaskId || '').trim() || String(upstreamTaskId).length > 256) return false
    return this.db.tx(async (client) => {
      const task = await one<any>(client, 'SELECT * FROM media_tasks WHERE id=$1 FOR UPDATE', [taskId])
      if (!task || !task.video_provider_key_id || !task.quota_day || Number(task.quota_seconds_reserved || 0) <= 0) return false
      const amount = Number(task.quota_seconds_reserved)
      await client.query(`UPDATE video_key_usage_daily SET reserved_seconds=GREATEST(0,reserved_seconds-$3),used_seconds=used_seconds+$3,updated_at=now() WHERE key_id=$1 AND usage_day=$2`, [task.video_provider_key_id, task.quota_day, amount])
      await client.query(`UPDATE media_tasks SET quota_seconds_used=quota_seconds_used+$2,quota_seconds_reserved=0,upstream_id=COALESCE(upstream_id,$3) WHERE id=$1 AND upstream_id IS NULL`, [taskId, amount, upstreamTaskId])
      await client.query(`UPDATE video_provider_keys SET success_count=success_count+1,last_success_at=now(),failure_count=0,cooldown_until=NULL,updated_at=now() WHERE id=$1`, [task.video_provider_key_id])
      await client.query(`UPDATE video_attempts SET outcome='accepted',accepted=true,upstream_task_id=$2
        WHERE task_id=$1 AND attempt_no=(SELECT max(attempt_no) FROM video_attempts WHERE task_id=$1)`, [taskId, upstreamTaskId])
      return true
    })
  }

  async releaseTaskReservation(taskId: string): Promise<boolean> {
    return this.db.tx(async (client) => {
      const task = await one<any>(client, 'SELECT * FROM media_tasks WHERE id=$1 FOR UPDATE', [taskId])
      if (!task || !task.video_provider_key_id || !task.quota_day || Number(task.quota_seconds_reserved || 0) <= 0) return false
      const amount = Number(task.quota_seconds_reserved)
      await client.query(`UPDATE video_key_usage_daily SET reserved_seconds=GREATEST(0,reserved_seconds-$3),released_seconds=released_seconds+$3,updated_at=now() WHERE key_id=$1 AND usage_day=$2`, [task.video_provider_key_id, task.quota_day, amount])
      await client.query('UPDATE media_tasks SET quota_seconds_reserved=0 WHERE id=$1', [taskId])
      return true
    })
  }

  async recordAttempt(input: { taskId: string; keyId?: string | null; attemptNo: number; statusCode?: number | null; outcome: string; durationMs?: number | null; errorCode?: string | null; errorMessage?: string | null; upstreamTaskId?: string | null; accepted?: boolean }): Promise<void> {
    await this.db.query(`INSERT INTO video_attempts(task_id,key_id,attempt_no,status_code,outcome,duration_ms,error_code,error_message,upstream_task_id,accepted) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(task_id,attempt_no) DO UPDATE SET status_code=EXCLUDED.status_code,outcome=EXCLUDED.outcome,duration_ms=EXCLUDED.duration_ms,error_code=EXCLUDED.error_code,error_message=EXCLUDED.error_message,upstream_task_id=EXCLUDED.upstream_task_id,accepted=EXCLUDED.accepted`, [input.taskId, input.keyId || null, integer(input.attemptNo, 1, 1, 1_000_000), input.statusCode ?? null, input.outcome, input.durationMs ?? null, input.errorCode || null, input.errorMessage ? String(input.errorMessage).slice(0, 500) : null, input.upstreamTaskId || null, Boolean(input.accepted)])
    if (!input.keyId) return
    if (input.durationMs != null && Number.isFinite(Number(input.durationMs))) {
      await this.db.query(`UPDATE video_provider_keys SET
        latency_p50_ms=(SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::int FROM video_attempts WHERE key_id=$1 AND duration_ms IS NOT NULL),
        latency_p95_ms=(SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::int FROM video_attempts WHERE key_id=$1 AND duration_ms IS NOT NULL),
        latency_ewma_ms=CASE WHEN latency_ewma_ms IS NULL THEN $2 ELSE latency_ewma_ms * 0.7 + $2 * 0.3 END,
        updated_at=now() WHERE id=$1`, [input.keyId, Number(input.durationMs)])
    }
    if (input.accepted || input.outcome === 'accepted' || input.outcome === 'submitted') return
    await this.db.query(`UPDATE video_provider_keys SET failure_count=failure_count+1,
      cooldown_until=CASE WHEN failure_count+1 >= 3 THEN now()+interval '30 seconds' ELSE cooldown_until END,
      updated_at=now() WHERE id=$1`, [input.keyId])
  }
}
