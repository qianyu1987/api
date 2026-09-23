import { createHash, randomUUID } from 'node:crypto'
import { Database, one } from '../db/index.js'
import type { AppConfig } from '../config.js'
import { decryptSecret } from '../lib/crypto.js'
import { mediaError, mediaPrice, validateMedia, mediaResultUrl, agnesVideoQueueFull } from '../lib/media.js'
import { profitRules } from './profit.js'

const canonical = (v: any): string => JSON.stringify(v, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value)
const sensitiveVisualTerms = ['前凸后翘','胸部挺拔','胸部丰满','丰满胸部','饱满胸部','臀部圆润','丰满臀部','极少服饰','衣着暴露','衣着清凉','挑逗姿势','挑逗性','露骨性感','性感身材','透视服装','裸露身体','裸体','内衣写真','色情']
const introducedSensitiveVisualTerms = (source: string, result: string): boolean => sensitiveVisualTerms.some(term => result.includes(term) && !source.includes(term))

export const VIDEO_QUEUE_WINDOW_MS = 30 * 60 * 1000
export const VIDEO_CONFIRMATION_WINDOW_MS = 45 * 60 * 1000
const IMAGE_CONFIRMATION_WINDOW_MS = 60 * 1000
const RETRY_DELAYS_MS = [10_000, 20_000, 40_000, 60_000, 120_000] as const
const MAX_STORED_IMAGE_BYTES = 15 * 1024 * 1024

function publicMediaUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return null
    if (/^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|\[|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname) || url.hostname.endsWith('.localhost')) return null
    return url
  } catch { return null }
}

function imageContentType(content: Buffer): string | null {
  if (content[0] === 0x89 && content[1] === 0x50 && content[2] === 0x4e && content[3] === 0x47) return 'image/png'
  if (content[0] === 0xff && content[1] === 0xd8) return 'image/jpeg'
  if (content[0] === 0x52 && content[1] === 0x49 && content[2] === 0x46 && content[3] === 0x46 && content.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

export async function downloadMediaImage(value: string): Promise<{ content: Buffer; contentType: string } | null> {
  const url = publicMediaUrl(value)
  if (!url) return null
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) })
    if (!response.ok || !response.body) return null
    const declared = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    const declaredLength = Number(response.headers.get('content-length') || 0)
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(declared) || (declaredLength > 0 && declaredLength > MAX_STORED_IMAGE_BYTES)) return null
    const reader = response.body.getReader(), chunks: Buffer[] = []
    let total = 0
    while (true) {
      const { done, value: chunk } = await reader.read()
      if (done) break
      total += chunk.byteLength
      if (total > MAX_STORED_IMAGE_BYTES) { await reader.cancel(); return null }
      chunks.push(Buffer.from(chunk))
    }
    const content = Buffer.concat(chunks, total)
    const detected = content.length >= 16 ? imageContentType(content) : null
    return detected === declared ? { content, contentType: detected } : null
  } catch { return null }
}

function timestampMs(value: unknown): number | null {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : null
}

/** Exponential backoff with a small jitter so multiple API replicas do not stampede a provider. */
export function mediaRetryDelayMs(attempt: number, random = Math.random): number {
  const index = Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, Math.floor(attempt) - 1))
  return RETRY_DELAYS_MS[index] + Math.floor(Math.max(0, Math.min(0.999, random())) * 5_000)
}

function hasUpstreamTaskId(payload: any): boolean {
  return [payload?.video_id, payload?.id, payload?.task_id, payload?.data?.video_id, payload?.data?.id, payload?.data?.task_id]
    .some((value) => typeof value === 'string' && value.length > 0)
}

function safeFailureMessage(task: any): string {
  const code = String(task?.last_retry_code || '')
  const detail = String(task?.error_message || '')
  if (code === 'canceled' || detail.includes('取消')) return '已取消排队，额度已全部退回'
  if (detail.includes('审核')) return '提示词未通过审核，额度已全部退回'
  if (task?.kind === 'video') return '暂时无法安排生成，额度已全部退回'
  return '生成失败，额度已自动退回'
}

function safeUserInput(body: any, input: ReturnType<typeof validateMedia>) {
  const payload = input.payload as any
  const result: any = {
    kind: input.kind,
    engine: input.engine,
    prompt: String(body?.prompt || payload.prompt || '').trim(),
    size: input.size,
    ratio: String(body?.ratio || body?.aspect_ratio || payload.ratio || payload.aspect_ratio || '16:9'),
  }
  if (input.kind === 'image') {
    const images = payload.extra_body?.image
    if (Array.isArray(images) && images.length) result.images = images
  } else {
    result.seconds = Number(payload.seconds)
    result.mode = payload.mode
    if (Array.isArray(payload.images) && payload.images.length) result.images = payload.images
    if (Array.isArray(payload.audios) && payload.audios.length) result.audios = payload.audios
    if (payload.first_frame) result.first_frame = payload.first_frame
    if (payload.last_frame) result.last_frame = payload.last_frame
  }
  return result
}

function legacyUserInput(task: any): any {
  const payload = task.request_payload || {}
  const kind = task.kind === 'video' ? 'video' : 'image'
  const engine = task.model === 'gpt-image-2' ? 'pro' : task.model === 'gpt-image-2.5' ? 'enhanced' : 'standard'
  const ratio = payload.ratio || payload.aspect_ratio || (payload.size === '1024x1024' ? '1:1' : payload.size === '1024x1536' ? '9:16' : '16:9')
  const input: any = { kind, engine, prompt: String(payload.prompt || ''), size: engine === 'standard' ? String(payload.size || (kind === 'video' ? '720P' : '1K')) : '1K', ratio }
  const images = kind === 'image' ? payload.extra_body?.image : payload.images
  if (Array.isArray(images) && images.length) input.images = images
  if (kind === 'video') {
    input.seconds = Number(payload.seconds || 5)
    input.mode = payload.mode || 'text'
    if (Array.isArray(payload.audios) && payload.audios.length) input.audios = payload.audios
    if (payload.first_frame) input.first_frame = payload.first_frame
    if (payload.last_frame) input.last_frame = payload.last_frame
  }
  return input
}

export function welcomeGift(input: {model:string;size:string;units:number}, balance: any) {
  if(input.model==='agnes-image-2.5-flash'&&input.size==='1K'&&Number(balance?.images_remaining)>=input.units)return {kind:'image',units:input.units}
  if(input.model==='agnes-video-2.5-flash'&&input.size==='720P'&&Number(balance?.video_seconds_remaining)>=input.units)return {kind:'video',units:input.units}
  return null
}
export class MediaService {
  constructor(private db: Database, private config: AppConfig) {}
  async catalog() {
    const rows = await this.db.query<any>('SELECT p.model,p.size,p.enabled,p.normal_cost_micros,p.channel_id,c.enabled AS channel_enabled,c.deleted_at FROM media_prices p LEFT JOIN channels c ON c.id=p.channel_id ORDER BY p.model,p.size')
    return { items: rows.map(p => { const kind = p.model === 'agnes-video-2.5-flash' ? 'video' : 'image'; const freeStandard = p.model === 'agnes-image-2.5-flash'; const item: any = { kind, size: p.size, available: Boolean(p.enabled && (freeStandard || p.normal_cost_micros > 0) && p.channel_enabled && !p.deleted_at) }; if (kind === 'image') { item.engine = p.model === 'gpt-image-2' ? 'pro' : p.model === 'gpt-image-2.5' ? 'enhanced' : 'standard'; item.label = p.model === 'gpt-image-2' ? '专业图片 · gpt-image-2.0' : p.model === 'gpt-image-2.5' ? '增强图片 · gpt-image-2.5（顶级画质）' : '标准图片 · 免费' } return item }), walletOnly: true }
  }
  async quote(userId: string, body: any, db: Pick<Database, 'query' | 'one'> = this.db) {
    const input = validateMedia(body)
    const price = await db.one<any>('SELECT p.*,c.enabled AS channel_enabled,c.deleted_at FROM media_prices p LEFT JOIN channels c ON c.id=p.channel_id WHERE p.model=$1 AND p.size=$2', [input.model,input.size])
    if (!price?.enabled || !price.channel_enabled || price.deleted_at || !price.cost_source) mediaError('此规格暂未开放，尚未扣费，请选择其他规格或稍后再试',503)
    const settings = Object.fromEntries((await db.query<any>('SELECT key,value FROM app_settings')).map(r=>[r.key,r.value]))
    const rules = profitRules(settings)
    // Use the largest historical recharge ratio, not just today's promotion.
    const ratio = await db.one<any>(`SELECT COALESCE(max(topup_multiplier_bps),10000)::int AS bps FROM orders WHERE user_id=$1 AND kind='wallet_topup' AND status='paid'`,[userId])
    const multiplier = Math.max(this.config.walletTopupMultiplierBps,Number(ratio?.bps || 10000))
    const normal = BigInt(price.normal_cost_micros)*BigInt(input.units), actual = BigInt(price.actual_cost_micros)*BigInt(input.units)
    const freeStandard = input.model === 'agnes-image-2.5-flash'
    let charge = freeStandard ? 0n : mediaPrice(normal > actual ? normal : actual,multiplier,rules.paymentFeeRateBps,rules.affiliateRateBps)
    const snapshot = { normalCostMicros:normal.toString(),actualCostMicros:actual.toString(),multiplierBps:multiplier,feeBps:rules.paymentFeeRateBps,rebateBps:rules.affiliateRateBps,marginBps:3000,costSource:price.cost_source,priceUpdatedAt:price.updated_at,chargeMicros:charge.toString() }
    const cash = charge * 10000n / BigInt(multiplier)
    Object.assign(snapshot,{estimatedRevenueMicros:cash.toString(),estimatedFeesMicros:(cash*BigInt(rules.paymentFeeRateBps)/10000n).toString(),estimatedRebateMicros:(cash*BigInt(rules.affiliateRateBps)/10000n).toString(),estimatedProfitMicros:(cash-cash*BigInt(rules.paymentFeeRateBps+rules.affiliateRateBps)/10000n-actual).toString()})
    const giftRow = await db.one<any>('SELECT images_remaining,video_seconds_remaining FROM media_welcome_gifts WHERE user_id=$1',[userId])
    const gift = welcomeGift(input,giftRow)
    if(freeStandard || gift){charge=0n;Object.assign(snapshot,{chargeMicros:'0',...(freeStandard ? {freeStandard:true} : {}),...(gift ? {welcomeGift:gift} : {}),estimatedRevenueMicros:'0',estimatedFeesMicros:'0',estimatedRebateMicros:'0',estimatedProfitMicros:(-actual).toString()})}
    const token = createHash('sha256').update(JSON.stringify({input,snapshot})).digest('hex')
    return {input,price,snapshot,chargeMicros:charge.toString(),quoteToken:token,walletOnly:!gift,gift}
  }
  publicTask(r: any) {
    const input = r.user_input && typeof r.user_input === 'object' ? r.user_input : legacyUserInput(r)
    const assets = [input.first_frame,input.last_frame,...(Array.isArray(input.images)?input.images:[]),...(Array.isArray(input.audios)?input.audios:[])].filter(Boolean)
    const terminal = ['completed','failed'].includes(r.status)
    const gift = r.price_snapshot?.welcomeGift || null
    const charge = BigInt(r.charge_micros || 0)
    const videoActive = r.kind === 'video' && !terminal
    const accepted = Boolean(r.upstream_id || r.accepted_at)
    const queueStatus = !videoActive ? 'not_queued' : accepted ? 'accepted' : (Number(r.submit_attempts || 0) > 0 || r.last_retry_code ? 'switching' : 'waiting')
    const publicError = terminal && r.status === 'failed' ? safeFailureMessage(r) : null
    return {
      id:r.id,kind:r.kind,status:r.status,progress:r.progress,chargeMicros:r.charge_micros,gift,
      charged:r.status==='completed'&&charge>0n,reserved:!terminal,
      refundStatus:r.status==='failed'?'returned':terminal?'settled':charge===0n&&!gift?'not_applicable':'reserved',
      resultUrl:r.result_url ? '/api/me/media/tasks/'+encodeURIComponent(r.id)+'/result' : null,
      error:publicError,input,canRetry:terminal,queueStatus,
      queuedAt:r.queue_started_at || r.created_at || null,
      nextRetryAt:videoActive && !accepted ? (r.next_attempt_at || r.next_poll_at || null) : null,
      canCancel:videoActive && !accepted,
      submitAttempts:Number(r.submit_attempts || 0),
      acceptedAt:r.accepted_at || null,
      assetsMayHaveExpired:assets.length>0&&Date.now()-new Date(r.created_at||0).getTime()>7*24*60*60*1000,
      createdAt:r.created_at,finishedAt:r.finished_at,
    }
  }
  async list(userId:string) { return {items:(await this.db.query<any>('SELECT * FROM media_tasks WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50',[userId])).map(r=>this.publicTask(r))} }
  async get(userId:string,id:string) { const r=await this.db.one<any>('SELECT * FROM media_tasks WHERE user_id=$1 AND id=$2',[userId,id]);if(!r)mediaError('任务不存在',404);return this.publicTask(r) }
  async create(userId:string,body:any,keyId:string|null=null,autoQuote=false) {
    const nonce=String(body.idempotencyKey||'');if(!/^[a-zA-Z0-9_-]{16,100}$/.test(nonce))mediaError('缺少有效的幂等请求编号')
    const input=validateMedia(body)
    const old=await this.db.one<any>('SELECT * FROM media_tasks WHERE user_id=$1 AND idempotency_key=$2',[userId,nonce])
    if(old){if(canonical(old.request_payload)!==canonical(input.payload))mediaError('请求编号已用于另一项任务',409);return this.publicTask(old)}
    const row=await this.db.tx(async client=>{
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[userId])
      const existing=await one<any>(client,'SELECT * FROM media_tasks WHERE user_id=$1 AND idempotency_key=$2',[userId,nonce]);if(existing){if(canonical(existing.request_payload)!==canonical(input.payload))mediaError('请求编号已占用，请刷新任务列表',409);return existing}
      // Hold all mutable quote inputs through reservation so a price/channel
      // change cannot silently charge an obsolete quote.
      await client.query('SELECT model FROM media_prices WHERE model=$1 AND size=$2 FOR SHARE',[input.model,input.size])
      await client.query('SELECT c.id FROM channels c JOIN media_prices p ON p.channel_id=c.id WHERE p.model=$1 AND p.size=$2 FOR SHARE OF c',[input.model,input.size])
      await client.query('SELECT key FROM app_settings FOR SHARE')
      const q=await this.quote(userId,body,{query:async(text:string,values:unknown[]=[]) => (await client.query(text,values)).rows,one:async(text:string,values:unknown[]=[]) => one<any>(client,text,values)})
      if(!autoQuote&&body.quoteToken!==q.quoteToken)mediaError('报价已变化，请重新查看价格并确认生成',409)
      const count=await one<any>(client,"SELECT count(*)::int AS n FROM media_tasks WHERE user_id=$1 AND status NOT IN ('completed','failed')",[userId]);if(count.n>=2)mediaError('已有两项生成任务，请等待完成后再试',429)
      const wallet=await one<any>(client,'SELECT balance_micros,reserved_micros FROM wallets WHERE user_id=$1 FOR UPDATE',[userId]);
      if(!wallet||BigInt(wallet.balance_micros)-BigInt(wallet.reserved_micros)<BigInt(q.chargeMicros))mediaError('钱包可用余额不足，尚未扣费；媒体生成不使用月套餐，请先充值')
      const id=randomUUID()
      if(q.gift){
        const column=q.gift.kind==='image'?'images_remaining':'video_seconds_remaining'
        const redeemed=await client.query(`UPDATE media_welcome_gifts SET ${column}=${column}-$2 WHERE user_id=$1 AND ${column}>=$2 RETURNING user_id`,[userId,q.gift.units])
        if(!redeemed.rows.length)mediaError('免费额度已变化，请刷新价格后重试',409)
      }
      await client.query('UPDATE wallets SET reserved_micros=reserved_micros+$1,version=version+1,updated_at=now() WHERE user_id=$2',[q.chargeMicros,userId])
      if(BigInt(q.chargeMicros)>0n)await client.query("INSERT INTO wallet_ledger(user_id,kind,amount_micros,balance_after_micros,reserved_delta_micros,request_id,metadata) VALUES($1,'usage_reserve',0,$2,$3,$4,$5)",[userId,wallet.balance_micros,q.chargeMicros,id,JSON.stringify({media:true})])
      return one<any>(client,'INSERT INTO media_tasks(id,user_id,api_key_id,idempotency_key,kind,model,channel_id,request_payload,user_input,price_snapshot,charge_micros,actual_cost_micros) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',[id,userId,keyId,nonce,input.kind,input.model,q.price.channel_id,JSON.stringify(input.payload),JSON.stringify(safeUserInput(body,input)),JSON.stringify(q.snapshot),q.chargeMicros,q.snapshot.actualCostMicros])
    });return this.publicTask(row)
  }
  async expandPrompt(body: any) {
    const prompt = String(body?.prompt || '').trim()
    if (!prompt || prompt.length > 12000 || !['image','video'].includes(body?.kind)) mediaError('请先输入提示词并选择图片或视频')
    const channel = await this.db.one<any>("SELECT c.encrypted_api_key FROM media_prices p JOIN channels c ON c.id=p.channel_id WHERE p.model=$1 AND p.enabled AND c.enabled AND c.deleted_at IS NULL AND c.base_url='https://apihub.agnes-ai.com/v1' LIMIT 1", [body.kind==='image'?'agnes-image-2.5-flash':'agnes-video-2.5-flash'])
    if (!channel?.encrypted_api_key) mediaError('提示词扩展暂不可用，请保留原文稍后重试',503)
    try {
      const apiKey=decryptSecret(channel.encrypted_api_key,this.config.channelEncryptionKey)
      const complete=async(system:string,user:string)=>{
        const response=await fetch('https://apihub.agnes-ai.com/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+apiKey,'content-type':'application/json'},body:JSON.stringify({model:'agnes-3.0-flash',stream:false,max_tokens:1600,messages:[{role:'system',content:system},{role:'user',content:user}]}),signal:AbortSignal.timeout(60000),redirect:'error'})
        if(!response.ok)throw new Error('provider error')
        const data:any=await response.json(), result=data?.choices?.[0]?.message?.content
        if(typeof result!=='string'||!result.trim()||result.length>12000)throw new Error('invalid expansion')
        return result.trim()
      }
      const direction='你是专业的AI视觉提示词编辑。将用户简述扩展为可直接用于'+(body.kind==='video'?'视频生成的提示词，补充镜头运动、动作及时间连贯性':'图片生成的提示词，补充构图、光影、材质')+'。保留原意和明确要求，使用用户原文语言，不添加无关主体，不声称改变分辨率。人物必须明确为成年人并保持完整、得体的日常或场景服装。不得主动添加裸露、色情、挑逗、胸臀曲线、少量衣着、内衣或性暗示描写；原文没有的身体特征不得扩写。只输出扩展后的提示词，不输出解释，最多1500字。'
      let expanded=await complete(direction,prompt)
      let notice:string|undefined
      if(introducedSensitiveVisualTerms(prompt,expanded)){
        expanded=await complete('你是AI视觉提示词安全编辑。把草稿改写为健康、非露骨、可通过主流图片与视频平台审核的视觉提示词。保留构图、环境、光影、镜头和艺术风格；人物明确为成年人并穿着完整得体。删除胸臀曲线、裸露、色情、挑逗、少量衣着、内衣及性暗示描写。只输出改写结果。',JSON.stringify({原始描述:prompt,待改写草稿:expanded}))
        notice='已自动移除扩展稿中新增的不合适人物描写。'
      }
      if(introducedSensitiveVisualTerms(prompt,expanded))return {prompt,notice:'扩展稿可能触发内容审核，已保留你的原文。'}
      if(typeof expanded!=='string'||!expanded.trim()||expanded.length>12000) throw new Error('invalid expansion')
      return {prompt:expanded.trim(),notice}
    } catch { return mediaError('提示词扩展失败，原文已保留，请稍后重试',502) }
  }
  private async finishInTransaction(client: any, id:string, success:boolean, url:string|null, message:string|null, content?:Buffer, contentType?:string, retryCode?:string) {
    const task=await one<any>(client,'SELECT * FROM media_tasks WHERE id=$1 FOR UPDATE',[id]);if(!task||['completed','failed'].includes(task.status))return
    // Timeout refunds re-check the state after taking the row lock. A worker
    // may have claimed the task between the expiry scan and this transaction.
    if (retryCode === 'queue_timeout') {
      const started = timestampMs(task.queue_started_at || task.created_at)
      const lease = timestampMs(task.lease_until)
      if (task.kind !== 'video' || task.status !== 'queued' || (lease !== null && lease > Date.now()) || started === null || Date.now() - started < VIDEO_QUEUE_WINDOW_MS) return
    }
    if (retryCode === 'confirmation_timeout') {
      const uncertain = timestampMs(task.uncertain_since)
      const lease = timestampMs(task.lease_until)
      const window = task.kind === 'video' ? VIDEO_CONFIRMATION_WINDOW_MS : IMAGE_CONFIRMATION_WINDOW_MS
      if (task.status !== 'unknown' || (lease !== null && lease > Date.now()) || uncertain === null || Date.now() - uncertain < window) return
    }
    const wallet=await one<any>(client,'SELECT balance_micros,reserved_micros FROM wallets WHERE user_id=$1 FOR UPDATE',[task.user_id]);const charge=BigInt(task.charge_micros)
    if(BigInt(wallet.reserved_micros)<charge)throw new Error('媒体冻结金额不一致')
    const balance=BigInt(wallet.balance_micros)-(success?charge:0n)
    await client.query('UPDATE wallets SET balance_micros=$1,reserved_micros=reserved_micros-$2,version=version+1,updated_at=now() WHERE user_id=$3',[balance.toString(),charge.toString(),task.user_id])
    if(charge>0n)await client.query('INSERT INTO wallet_ledger(user_id,kind,amount_micros,balance_after_micros,reserved_delta_micros,request_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)',[task.user_id,success?'usage_settle':'usage_release',success?(-charge).toString():'0',balance.toString(),(-charge).toString(),id,JSON.stringify({media:true,priceSnapshot:task.price_snapshot})])
    const gift=task.price_snapshot?.welcomeGift
    if(!success&&gift){
      const column=gift.kind==='image'?'images_remaining':'video_seconds_remaining'
      await client.query(`UPDATE media_welcome_gifts SET ${column}=${column}+$2 WHERE user_id=$1`,[task.user_id,gift.units])
    }
    if(success&&content&&contentType)await client.query('INSERT INTO media_task_assets(task_id,content_type,content) VALUES($1,$2,$3) ON CONFLICT(task_id) DO NOTHING',[id,contentType,content])
    await client.query('UPDATE media_tasks SET status=$2,result_url=$3,error_message=$4,last_retry_code=COALESCE($5,last_retry_code),progress=100,finished_at=now(),lease_until=NULL,uncertain_since=NULL,next_attempt_at=NULL WHERE id=$1 AND status NOT IN (\'completed\',\'failed\')',[id,success?'completed':'failed',success&&content?'stored://media/'+id:url,message,retryCode || null])
  }

  async finish(id:string,success:boolean,url:string|null,message:string|null,content?:Buffer,contentType?:string,retryCode?:string) {
    await this.db.tx(async client=>this.finishInTransaction(client,id,success,url,message,content,contentType,retryCode))
  }

  async cancel(userId:string,id:string) {
    return this.db.tx(async client=>{
      const task=await one<any>(client,'SELECT * FROM media_tasks WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,userId])
      if(!task) mediaError('任务不存在',404)
      if(['completed','failed'].includes(task.status)) return this.publicTask(task)
      if(task.upstream_id || task.status==='processing') mediaError('任务已经接单，无法取消；系统会继续查询生成结果',409)
      await this.finishInTransaction(client,id,false,null,'用户取消排队，额度已自动退回',undefined,undefined,'canceled')
      const updated=await one<any>(client,'SELECT * FROM media_tasks WHERE id=$1',[id])
      return this.publicTask(updated)
    })
  }

  private expectedVideoBase(model:string): string | null {
    return model === 'agnes-video-2.5-flash' ? 'https://apihub.agnes-ai.com/v1' : null
  }

  private async videoCandidates(task:any) {
    const base=this.expectedVideoBase(String(task.model || ''))
    if(!base) return []
    return this.db.query<any>(`SELECT * FROM channels
      WHERE enabled AND deleted_at IS NULL AND encrypted_api_key IS NOT NULL AND base_url=$1
        AND (media_circuit_open_until IS NULL OR media_circuit_open_until<=now())
      ORDER BY priority,created_at,id`,[base])
  }

  private async resolveVideoChannel(task:any) {
    const candidates=await this.videoCandidates(task)
    const current=candidates.find((row:any)=>String(row.id)===String(task.channel_id))
    if(current) return current
    if(candidates.length) return candidates[0]
    // Keep legacy fixtures and an explicitly configured primary channel
    // usable when the candidate query has no alternate rows. The circuit
    // predicate still prevents probing a channel while its media breaker is open.
    return this.db.one<any>('SELECT * FROM channels WHERE id=$1 AND enabled AND deleted_at IS NULL AND (media_circuit_open_until IS NULL OR media_circuit_open_until<=now())',[task.channel_id])
  }

  private async markMediaBusy(channelId:string) {
    await this.db.query(`UPDATE channels SET media_failure_count=media_failure_count+1,
      media_last_failure_at=now(),
      media_circuit_open_until=CASE WHEN media_failure_count+1>=3 THEN now()+interval '5 minutes' ELSE media_circuit_open_until END,
      updated_at=now() WHERE id=$1`,[channelId])
  }

  private async markMediaSuccess(channelId:string) {
    await this.db.query(`UPDATE channels SET media_failure_count=0,media_circuit_open_until=NULL,
      media_last_success_at=now(),updated_at=now() WHERE id=$1`,[channelId])
  }

  private async requeueVideo(task:any, channel:any, code:string, message='正在等待生成资源，系统将自动重试') {
    const started=new Date(task.queue_started_at || task.created_at || Date.now()).getTime()
    if(Number.isFinite(started) && Date.now()-started>=VIDEO_QUEUE_WINDOW_MS){
      await this.finish(task.id,false,null,'暂时无法安排生成，额度已全部退回',undefined,undefined,'queue_timeout')
      return
    }
    await this.markMediaBusy(String(channel?.id || task.channel_id))
    const candidates=await this.videoCandidates(task)
    const alternative=candidates.find((row:any)=>String(row.id)!==String(task.channel_id)) || null
    const attempt=Math.max(1,Number(task.submit_attempts || 1))
    const delay=alternative ? 1000 : mediaRetryDelayMs(attempt)
    const next=new Date(Date.now()+delay)
    await this.db.query(`UPDATE media_tasks SET status='queued',channel_id=COALESCE($2,channel_id),last_retry_code=$3,
      error_message=$4,lease_until=NULL,uncertain_since=NULL,next_attempt_at=$5,next_poll_at=$5
      WHERE id=$1 AND status='submitting' AND finished_at IS NULL`,[task.id,alternative?.id || null,alternative?'channel_switch':code,message,next])
  }
  async tick() {
    await this.db.query("UPDATE media_tasks SET uncertain_since=now(),next_poll_at=LEAST(next_poll_at,now()) WHERE status='unknown' AND uncertain_since IS NULL")
    const expiredQueued = await this.db.query<any>("SELECT id FROM media_tasks WHERE kind='video' AND status='queued' AND queue_started_at<=now()-interval '30 minutes' AND (lease_until IS NULL OR lease_until<now()) ORDER BY queue_started_at LIMIT 20")
    for (const row of expiredQueued) await this.finish(String(row.id),false,null,'暂时无法安排生成，额度已全部退回',undefined,undefined,'queue_timeout')
    const expired = await this.db.query<any>("SELECT id,kind FROM media_tasks WHERE status='unknown' AND uncertain_since<=now()-(CASE WHEN kind='video' THEN interval '45 minutes' ELSE interval '1 minute' END) AND (lease_until IS NULL OR lease_until<now()) ORDER BY uncertain_since LIMIT 20")
    for (const row of expired) await this.finish(String(row.id),false,null,row.kind==='video'?'暂时无法安排生成，额度已全部退回':'生成结果未确认，额度已自动退回，可重新生成',undefined,undefined,'confirmation_timeout')
    // A crashed submission may have reached upstream. Never automatically resend.
    await this.db.query("UPDATE media_tasks SET status='unknown',uncertain_since=COALESCE(uncertain_since,now()),error_message='正在自动确认上游接单结果',lease_until=NULL,next_poll_at=now()+interval '10 seconds' WHERE status='submitting' AND lease_until<now()")
    const task=await this.db.tx(async client=>{
      const r=await one<any>(client,"SELECT * FROM media_tasks WHERE ((status='queued' AND COALESCE(next_attempt_at,next_poll_at,created_at)<=now()) OR (status IN ('processing','unknown') AND next_poll_at<=now())) AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED");if(!r)return null
      const wasQueued=r.status==='queued'
      await client.query("UPDATE media_tasks SET lease_until=now()+interval '7 minutes',status=CASE WHEN status='queued' THEN 'submitting' ELSE status END,submit_attempts=CASE WHEN status='queued' THEN submit_attempts+1 ELSE submit_attempts END WHERE id=$1 AND finished_at IS NULL",[r.id])
      return {...r,_wasQueued:wasQueued,submit_attempts:Number(r.submit_attempts||0)+(wasQueued?1:0)}
    });if(!task)return
    const submitting=Boolean(task._wasQueued)
    try {
      if(task.status==='unknown'&&!task.upstream_id){
        if(task.kind==='image'&&typeof task.result_url==='string'&&task.result_url.startsWith('https://')){
          const asset=await downloadMediaImage(task.result_url)
          if(asset){await this.finish(task.id,true,null,null,asset.content,asset.contentType);return}
        }
        await this.db.query("UPDATE media_tasks SET lease_until=NULL,next_poll_at=now()+interval '10 seconds' WHERE id=$1 AND status='unknown' AND finished_at IS NULL",[task.id]);return
      }
      let channel:any
      if(submitting&&task.kind==='video') channel=await this.resolveVideoChannel(task)
      else channel=await this.db.one<any>(submitting
        ? 'SELECT * FROM channels WHERE id=$1 AND enabled AND deleted_at IS NULL AND encrypted_api_key IS NOT NULL'
        : 'SELECT * FROM channels WHERE id=$1',[task.channel_id])
      if(!channel?.encrypted_api_key){
        if(submitting){
          if(task.kind !== 'video'){
            await this.finish(task.id,false,null,'生成失败，额度已自动退回',undefined,undefined,'no_compatible_channel')
            return
          }
          const next=new Date(Date.now()+mediaRetryDelayMs(Number(task.submit_attempts||1)))
          await this.db.query("UPDATE media_tasks SET status='queued',last_retry_code='no_compatible_channel',error_message='正在等待可用生成服务',lease_until=NULL,next_attempt_at=$2,next_poll_at=$2 WHERE id=$1 AND status='submitting' AND finished_at IS NULL",[task.id,next])
          return
        }
        throw new Error('channel missing')
      }
      if(submitting&&String(channel.id)!==String(task.channel_id)){
        const switched=await this.db.query<any>("UPDATE media_tasks SET channel_id=$2 WHERE id=$1 AND status='submitting' AND finished_at IS NULL RETURNING id",[task.id,channel.id])
        if(!switched.length)return
        task.channel_id=channel.id
      }
      const origin=new URL(channel.base_url);if(!['https://apihub.agnes-ai.com','https://cdn.yyapi.cloud','https://ripp.best'].includes(origin.origin))throw new Error('unsupported provider')
      const expectedProvider = task.model === 'gpt-image-2' ? 'https://cdn.yyapi.cloud' : task.model === 'gpt-image-2.5' ? 'https://ripp.best' : task.model === 'agnes-video-2.5-flash' ? 'https://apihub.agnes-ai.com' : null
      if (expectedProvider && origin.origin !== expectedProvider) { await this.finish(task.id,false,null,'媒体渠道与模型不匹配，冻结额度已释放',undefined,undefined,'channel_mismatch'); return }
      const url=submitting?origin.origin+'/v1/'+(task.kind==='image'?'images/generations':'videos'):origin.origin+'/agnesapi?video_id='+encodeURIComponent(task.upstream_id)+'&model_name='+encodeURIComponent(task.model)
      const response=await fetch(url,{method:submitting?'POST':'GET',headers:{authorization:'Bearer '+decryptSecret(channel.encrypted_api_key,this.config.channelEncryptionKey),'content-type':'application/json'},...(submitting?{body:JSON.stringify(task.request_payload)}:{}),signal:AbortSignal.timeout(submitting?360000:30000),redirect:'error'})
      const responseText=await response.text()
      let data:any=null;try{data=JSON.parse(responseText)}catch{ /* handled below without persisting body */ }
      const queueRejected=task.kind==='video'&&submitting&&!hasUpstreamTaskId(data)&&(response.status===429||agnesVideoQueueFull(response.status,data))
      if(queueRejected){await this.requeueVideo(task,channel,response.status===429?'rate_limited':'queue_full');return}
      if(!response.ok){if(submitting&&task.kind==='video'&&response.status===503)throw new Error('uncertain response');if(submitting&&[400,401,403,404,422].includes(response.status)){await this.finish(task.id,false,null,response.status===400||response.status===422?'提示词未通过上游审核，额度已全部退回':'暂时无法安排生成，额度已全部退回',undefined,undefined,'upstream_rejected');return}throw new Error('uncertain response')}
      if(data===null)throw new Error('invalid upstream response')
      if(task.kind==='image'){
        const result=mediaResultUrl(data)
        if(result){
          const asset=await downloadMediaImage(result)
          if(asset){await this.markMediaSuccess(String(channel.id));await this.finish(task.id,true,null,null,asset.content,asset.contentType);return}
          await this.db.query("UPDATE media_tasks SET status='unknown',result_url=$2,uncertain_since=COALESCE(uncertain_since,now()),error_message='图片已生成，正在保存结果',lease_until=NULL,next_poll_at=now()+interval '10 seconds' WHERE id=$1 AND status='submitting' AND finished_at IS NULL",[task.id,result]);return
        }
        const encoded=data?.data?.[0]?.b64_json
        if(['gpt-image-2','gpt-image-2.5'].includes(task.model)&&typeof encoded==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)&&encoded.length<=20*1024*1024){
          const content=Buffer.from(encoded,'base64'); if(content.length<16||content.length>15*1024*1024)throw new Error('invalid image data')
          const type=imageContentType(content)
          if(!type)throw new Error('invalid image type')
          await this.markMediaSuccess(String(channel.id));await this.finish(task.id,true,null,null,content,type);return
        }
        throw new Error('missing image')
      }
      if(submitting) {
        const videoId=[data.video_id,data.id,data.task_id,data.data?.video_id,data.data?.id,data.data?.task_id].find((value:any)=>typeof value==='string'&&value.length>0)
        if(typeof videoId!=='string'||videoId.length>256)throw new Error('missing video id')
        await this.markMediaSuccess(String(channel.id))
        const accepted=await this.db.query<any>("UPDATE media_tasks SET upstream_id=$2,status='processing',accepted_at=COALESCE(accepted_at,now()),uncertain_since=NULL,error_message=NULL,lease_until=NULL,next_attempt_at=NULL,next_poll_at=now()+interval '5 seconds' WHERE id=$1 AND status='submitting' AND finished_at IS NULL AND (lease_until IS NULL OR lease_until>now()) RETURNING id",[task.id,videoId])
        if(!accepted.length)return
        return
      }
      if(data.status==='failed'){await this.finish(task.id,false,null,'视频生成失败，额度已全部退回',undefined,undefined,'upstream_failed');return}
      if(data.status==='completed'){const result=mediaResultUrl(data);if(!result)throw new Error('missing result');await this.finish(task.id,true,result,null);return}
      const progress=Math.max(0,Math.min(99,Math.floor(Number(data.progress))||0))
      await this.db.query("UPDATE media_tasks SET status='processing',progress=$2,uncertain_since=NULL,error_message=NULL,lease_until=NULL,next_poll_at=now()+interval '5 seconds' WHERE id=$1 AND status IN ('processing','unknown') AND finished_at IS NULL AND (lease_until IS NULL OR lease_until>now())",[task.id,progress])
    }catch(error){
      const reason=error instanceof Error ? error.message : ''
      const detail=error instanceof Error && ['TimeoutError','AbortError'].includes(error.name)?'等待上游结果超时':reason==='missing video id'?'上游接单结果暂未确认':reason==='invalid upstream response'?'上游响应格式暂未确认':reason==='uncertain response'?'上游服务暂时繁忙':'上游连接暂时异常'
      const windowMessage=task.kind==='video'?'，系统会继续确认；超过等待时间才会自动退回额度':'，正在自动确认结果；超过 1 分钟将自动退回额度'
      await this.db.query("UPDATE media_tasks SET status='unknown',uncertain_since=COALESCE(uncertain_since,now()),error_message=$2,lease_until=NULL,next_poll_at=now()+interval '10 seconds' WHERE id=$1 AND status IN ('submitting','processing','unknown') AND finished_at IS NULL",[task.id,detail+windowMessage])
    }
  }
}
