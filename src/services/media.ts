import { createHash, randomUUID } from 'node:crypto'
import { Database, one } from '../db/index.js'
import type { AppConfig } from '../config.js'
import { decryptSecret } from '../lib/crypto.js'
import { mediaError, mediaPrice, validateMedia, mediaResultUrl } from '../lib/media.js'
import { profitRules } from './profit.js'

const canonical = (v: any): string => JSON.stringify(v, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value)
const sensitiveVisualTerms = ['前凸后翘','胸部挺拔','胸部丰满','丰满胸部','饱满胸部','臀部圆润','丰满臀部','极少服饰','衣着暴露','衣着清凉','挑逗姿势','挑逗性','露骨性感','性感身材','透视服装','裸露身体','裸体','内衣写真','色情']
const introducedSensitiveVisualTerms = (source: string, result: string): boolean => sensitiveVisualTerms.some(term => result.includes(term) && !source.includes(term))

export function welcomeGift(input: {model:string;size:string;units:number}, balance: any) {
  if(input.model==='agnes-image-2.5-flash'&&input.size==='1K'&&Number(balance?.images_remaining)>=input.units)return {kind:'image',units:input.units}
  if(input.model==='agnes-video-2.5-flash'&&input.size==='720P'&&Number(balance?.video_seconds_remaining)>=input.units)return {kind:'video',units:input.units}
  return null
}
export class MediaService {
  constructor(private db: Database, private config: AppConfig) {}
  async catalog() {
    const rows = await this.db.query<any>('SELECT p.model,p.size,p.enabled,p.normal_cost_micros,p.channel_id,c.enabled AS channel_enabled,c.deleted_at FROM media_prices p LEFT JOIN channels c ON c.id=p.channel_id ORDER BY p.model,p.size')
    return { items: rows.map(p => { const kind = p.model === 'agnes-video-2.5-flash' ? 'video' : 'image'; const item: any = { kind, size: p.size, available: Boolean(p.enabled && p.normal_cost_micros > 0 && p.channel_enabled && !p.deleted_at) }; if (kind === 'image') { item.engine = p.model === 'gpt-image-2' ? 'pro' : p.model === 'gpt-image-2.5' ? 'enhanced' : 'standard'; item.label = p.model === 'gpt-image-2' ? '专业图片' : p.model === 'gpt-image-2.5' ? '增强图片' : '标准图片' } return item }), walletOnly: true }
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
    let charge = mediaPrice(normal > actual ? normal : actual,multiplier,rules.paymentFeeRateBps,rules.affiliateRateBps)
    const snapshot = { normalCostMicros:normal.toString(),actualCostMicros:actual.toString(),multiplierBps:multiplier,feeBps:rules.paymentFeeRateBps,rebateBps:rules.affiliateRateBps,marginBps:3000,costSource:price.cost_source,priceUpdatedAt:price.updated_at,chargeMicros:charge.toString() }
    const cash = charge * 10000n / BigInt(multiplier)
    Object.assign(snapshot,{estimatedRevenueMicros:cash.toString(),estimatedFeesMicros:(cash*BigInt(rules.paymentFeeRateBps)/10000n).toString(),estimatedRebateMicros:(cash*BigInt(rules.affiliateRateBps)/10000n).toString(),estimatedProfitMicros:(cash-cash*BigInt(rules.paymentFeeRateBps+rules.affiliateRateBps)/10000n-actual).toString()})
    const giftRow = await db.one<any>('SELECT images_remaining,video_seconds_remaining FROM media_welcome_gifts WHERE user_id=$1',[userId])
    const gift = welcomeGift(input,giftRow)
    if(gift){charge=0n;Object.assign(snapshot,{chargeMicros:'0',welcomeGift:gift,estimatedRevenueMicros:'0',estimatedFeesMicros:'0',estimatedRebateMicros:'0',estimatedProfitMicros:(-actual).toString()})}
    const token = createHash('sha256').update(JSON.stringify({input,snapshot})).digest('hex')
    return {input,price,snapshot,chargeMicros:charge.toString(),quoteToken:token,walletOnly:!gift,gift}
  }
  publicTask(r: any) { return { id:r.id,kind:r.kind,status:r.status,progress:r.progress,chargeMicros:r.charge_micros,gift:r.price_snapshot?.welcomeGift||null,charged:r.status==='completed'&&BigInt(r.charge_micros||0)>0n,reserved:!['completed','failed'].includes(r.status),resultUrl:r.result_url ? '/api/me/media/tasks/'+encodeURIComponent(r.id)+'/result' : null,error:r.error_message,createdAt:r.created_at,finishedAt:r.finished_at } }
  async list(userId:string) { return {items:(await this.db.query<any>('SELECT * FROM media_tasks WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50',[userId])).map(r=>this.publicTask(r))} }
  async get(userId:string,id:string) { const r=await this.db.one<any>('SELECT * FROM media_tasks WHERE user_id=$1 AND id=$2',[userId,id]);if(!r)mediaError('任务不存在',404);return this.publicTask(r) }
  async create(userId:string,body:any,keyId:string|null=null) {
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
      if(body.quoteToken!==q.quoteToken)mediaError('报价已变化，请重新查看价格并确认生成',409)
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
      return one<any>(client,'INSERT INTO media_tasks(id,user_id,api_key_id,idempotency_key,kind,model,channel_id,request_payload,price_snapshot,charge_micros,actual_cost_micros) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',[id,userId,keyId,nonce,input.kind,input.model,q.price.channel_id,JSON.stringify(input.payload),JSON.stringify(q.snapshot),q.chargeMicros,q.snapshot.actualCostMicros])
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
  async finish(id:string,success:boolean,url:string|null,message:string|null,content?:Buffer,contentType?:string) {
    await this.db.tx(async client=>{
      const task=await one<any>(client,'SELECT * FROM media_tasks WHERE id=$1 FOR UPDATE',[id]);if(!task||['completed','failed'].includes(task.status))return
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
      await client.query('UPDATE media_tasks SET status=$2,result_url=$3,error_message=$4,progress=100,finished_at=now(),lease_until=NULL WHERE id=$1',[id,success?'completed':'failed',success&&content?'stored://media/'+id:url,message])
    })
  }
  async tick() {
    await this.db.query("UPDATE media_tasks SET status='unknown',error_message='超过 24 小时未获得最终结果，额度仍冻结，请管理员核实' WHERE status='processing' AND created_at<now()-interval '24 hours' AND (lease_until IS NULL OR lease_until<now())")
    // A crashed submission may have reached upstream. Never automatically resend.
    await this.db.query("UPDATE media_tasks SET status='unknown',error_message='上游提交结果待确认，额度仍冻结，请联系管理员核查' WHERE status='submitting' AND lease_until<now()")
    const task=await this.db.tx(async client=>{
      const r=await one<any>(client,"SELECT * FROM media_tasks WHERE status IN ('queued','processing') AND next_poll_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED");if(!r)return null
      await client.query("UPDATE media_tasks SET lease_until=now()+interval '7 minutes',status=CASE WHEN status='queued' THEN 'submitting' ELSE status END WHERE id=$1",[r.id]);return r
    });if(!task)return
    try {
      const channel=await this.db.one<any>('SELECT * FROM channels WHERE id=$1',[task.channel_id]);if(!channel?.encrypted_api_key)throw new Error('channel missing')
      if(task.status==='queued'&&(!channel.enabled||channel.deleted_at)){await this.finish(task.id,false,null,'渠道已停用，冻结额度已释放');return}
      const origin=new URL(channel.base_url);if(!['https://apihub.agnes-ai.com','https://cdn.yyapi.cloud','https://ripp.best'].includes(origin.origin))throw new Error('unsupported provider')
      if ((origin.origin === 'https://cdn.yyapi.cloud' && task.model !== 'gpt-image-2') || (origin.origin === 'https://ripp.best' && task.model !== 'gpt-image-2.5')) throw new Error('provider/model mismatch')
      const url=task.status==='queued'?origin.origin+'/v1/'+(task.kind==='image'?'images/generations':'videos'):origin.origin+'/agnesapi?video_id='+encodeURIComponent(task.upstream_id)+'&model_name='+encodeURIComponent(task.model)
      const response=await fetch(url,{method:task.status==='queued'?'POST':'GET',headers:{authorization:'Bearer '+decryptSecret(channel.encrypted_api_key,this.config.channelEncryptionKey),'content-type':'application/json'},...(task.status==='queued'?{body:JSON.stringify(task.request_payload)}:{}),signal:AbortSignal.timeout(task.status==='queued'?360000:30000),redirect:'error'})
      const responseText=await response.text()
      if(!response.ok){if(task.status==='queued'&&[400,401,403,404,422,429].includes(response.status)){await this.finish(task.id,false,null,response.status===400||response.status===422?'提示词未通过上游审核，尚未扣费，冻结额度已释放；请减少敏感或容易误解的人物描写后重试':`上游拒绝生成（${response.status}），尚未扣费，冻结额度已释放`);return}throw new Error('uncertain response')}
      let data:any;try{data=JSON.parse(responseText)}catch{throw new Error('invalid upstream response')}
      if(task.kind==='image'){
        const result=mediaResultUrl(data)
        if(result){await this.finish(task.id,true,result,null);return}
        const encoded=data?.data?.[0]?.b64_json
        if(['gpt-image-2','gpt-image-2.5'].includes(task.model)&&typeof encoded==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)&&encoded.length<=20*1024*1024){
          const content=Buffer.from(encoded,'base64'); if(content.length<16||content.length>15*1024*1024)throw new Error('invalid image data')
          const type=content[0]===0x89&&content[1]===0x50?'image/png':content[0]===0xff&&content[1]===0xd8?'image/jpeg':content[0]===0x52&&content[1]===0x49?'image/webp':null
          if(!type)throw new Error('invalid image type')
          await this.finish(task.id,true,null,null,content,type);return
        }
        throw new Error('missing image')
      }
      if(task.status==='queued') {if(typeof data.video_id!=='string'||data.video_id.length>256)throw new Error('missing video id');await this.db.query("UPDATE media_tasks SET upstream_id=$2,status='processing',lease_until=NULL,next_poll_at=now()+interval '5 seconds' WHERE id=$1",[task.id,data.video_id]);return}
      if(data.status==='failed'){await this.finish(task.id,false,null,'视频生成失败，冻结额度已释放');return}
      if(data.status==='completed'){const result=mediaResultUrl(data);if(!result)throw new Error('missing result');await this.finish(task.id,true,result,null);return}
      await this.db.query("UPDATE media_tasks SET progress=$2,lease_until=NULL,next_poll_at=now()+interval '5 seconds' WHERE id=$1",[task.id,Math.max(0,Math.min(99,Math.floor(Number(data.progress))||0))])
    }catch(error){
      const reason=error instanceof Error ? error.message : ''
      const detail=error instanceof Error && ['TimeoutError','AbortError'].includes(error.name)?'等待上游接单超时':reason==='missing video id'?'上游响应缺少视频任务编号':reason==='invalid upstream response'?'上游返回格式异常':reason==='uncertain response'?'上游服务异常':'上游连接或处理异常'
      await this.db.query("UPDATE media_tasks SET status=$2,error_message=$3,lease_until=NULL,next_poll_at=now()+interval '30 seconds' WHERE id=$1 AND status IN ('submitting','processing')",[task.id,task.status==='queued'?'unknown':'processing',task.status==='queued'?detail+'，接单结果待确认；未最终扣费，额度仍冻结，请管理员核查':'正在重新查询上游结果，额度仍冻结'])
    }
  }
}
