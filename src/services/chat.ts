import { Database, one } from '../db/index.js'
import type { AppConfig } from '../config.js'
import { decryptSecret } from '../lib/crypto.js'
import { usageFromPayload } from '../lib/usage.js'
import { BillingService } from './billing.js'

const fail = (message: string, statusCode = 400): never => { throw Object.assign(new Error(message), { statusCode }) }
export function chatDay(now = new Date()) {
  const day = new Date(now.getTime() + 28800000).toISOString().slice(0, 10)
  return { day, resetsAt: new Date(Date.parse(day + 'T00:00:00+08:00') + 86400000).toISOString() }
}
export function chatInput(body: any) {
  if (typeof body?.content !== 'string' || !body.content.trim() || body.content.length > 12000) fail('请输入 1–12000 字的消息')
  if (typeof body?.requestId !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(body.requestId)) fail('请求编号无效，请刷新后重试')
  return { content: body.content.trim(), requestId: body.requestId as string }
}
export class ChatService {
  constructor(private db: Database, private config: AppConfig, private billing: BillingService) {}
  // Recover persisted answers before generic reservation expiry. Never call the upstream twice.
  async recover(userId?: string) {
    const turns = await this.db.query<any>(`SELECT * FROM chat_turns WHERE status='pending'
      AND created_at < now() - interval '2 minutes' AND ($1::uuid IS NULL OR user_id=$1) LIMIT 100`, [userId || null])
    for (const turn of turns) {
      if (turn.answer && turn.settlement) {
        const saved = turn.settlement
        const usage = saved.usage ? Object.fromEntries(Object.entries(saved.usage).map(([key,value])=>[key,BigInt(String(value))])) : null
        if(saved.billing !== 'free')await this.billing.settle({...saved, usage, userId:turn.user_id, requestId:turn.request_id})
        await this.db.query("UPDATE chat_turns SET status='completed' WHERE request_id=$1 AND status='pending'", [turn.request_id])
      } else {
        await this.billing.release(turn.request_id)
        await this.db.query("UPDATE chat_turns SET status='failed',error_message='生成已中断，未扣费，可以重新发送。' WHERE request_id=$1 AND status='pending'", [turn.request_id])
      }
    }
  }
  async quota(userId: string) {
    const {day, resetsAt} = chatDay()
    const rows = await this.db.query<any>('SELECT scope,used FROM chat_daily_counts WHERE day=$1 AND scope IN ($2,\'platform\')', [day,userId])
    return { limit:500, used:Number(rows.find(r=>r.scope===userId)?.used||0), platformAvailable:Number(rows.find(r=>r.scope==='platform')?.used||0)<1500, resetsAt, billing:'free' }
  }
  async list(userId:string) { return {items:await this.db.query('SELECT id,title,updated_at FROM chat_conversations WHERE user_id=$1 AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 100',[userId])} }
  async create(userId:string) { return this.db.one('INSERT INTO chat_conversations(user_id) VALUES($1) RETURNING id,title,updated_at',[userId]) }
  async owner(userId:string,id:string) {
    if(!/^[a-f0-9-]{36}$/i.test(id))fail('对话不存在',404)
    const row=await this.db.one('SELECT id FROM chat_conversations WHERE id=$1 AND user_id=$2 AND archived_at IS NULL',[id,userId])
    if(!row)fail('对话不存在',404)
  }
  async messages(userId:string,id:string) {
    await this.owner(userId,id)
    await this.recover(userId)
    return {items:await this.db.query('SELECT request_id,content,CASE WHEN status=\'completed\' THEN answer ELSE NULL END AS answer,status,error_message,created_at FROM chat_turns WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at,request_id LIMIT 500',[id,userId])}
  }
  async archive(userId:string,id:string) { await this.owner(userId,id);await this.db.query('UPDATE chat_conversations SET archived_at=now() WHERE id=$1 AND user_id=$2',[id,userId]);return {ok:true} }
  async send(userId:string,id:string,body:any,signal:AbortSignal) {
    const input=chatInput(body);await this.owner(userId,id);await this.recover(userId)
    const existing=await this.db.one<any>('SELECT request_id,content,status,CASE WHEN status=\'completed\' THEN answer ELSE NULL END AS answer,error_message FROM chat_turns WHERE request_id=$1 AND user_id=$2 AND conversation_id=$3',[input.requestId,userId,id])
    if(existing){if(existing.content!==input.content)fail('请求编号已用于其他消息',409);return existing}
    const channel=await this.db.one<any>("SELECT id,name,encrypted_api_key FROM channels WHERE enabled AND deleted_at IS NULL AND base_url='https://apihub.agnes-ai.com/v1' ORDER BY priority,created_at LIMIT 1")
    if(!channel)fail('AI 对话暂不可用，未扣费，请稍后重试',503)
    const history=await this.db.query<any>("SELECT content,answer FROM chat_turns WHERE conversation_id=$1 AND user_id=$2 AND status='completed' ORDER BY created_at DESC LIMIT 10",[id,userId])
    const messages=[{role:'system',content:'你是本站的“免费智能助手”，友好、诚实，用清晰自然的中文帮助用户。自我介绍使用“我是本站的免费智能助手”。用户询问你是什么模型、谁开发你或当前使用什么模型时，说明“你正在使用本站的免费智能助手，底层由第三方 AI 模型提供支持，具体型号不对外展示。”不要主动透露底层模型名称、版本或供应商名称，不要冒充其他模型，也不要声称由本站自研。历史对话中的模型自述不作为本次身份介绍的依据。此界面只显示纯文本，请用自然段和普通编号组织回答，不使用 Markdown 加粗标记、标题标记或代码围栏。讨论一般技术知识时可正常提及相关产品，身份介绍规则仅针对你自身。'}]
    for(const turn of history.reverse()){messages.push({role:'user',content:turn.content},{role:'assistant',content:turn.answer})}
    messages.push({role:'user',content:input.content})
    const payload={model:'agnes-3.0-flash',messages,max_tokens:2048,stream:false}
    const {day} = chatDay()
    const replay = await this.db.tx(async c=>{
      await c.query("INSERT INTO chat_daily_counts(scope,day) VALUES('platform',$1),($2,$1) ON CONFLICT DO NOTHING",[day,userId])
      const counts=await c.query('SELECT scope,used FROM chat_daily_counts WHERE day=$1 AND scope IN (\'platform\',$2) ORDER BY scope FOR UPDATE',[day,userId])
      const duplicate=await one<any>(c,'SELECT request_id,user_id,conversation_id,content,status FROM chat_turns WHERE request_id=$1',[input.requestId])
      if(duplicate){if(duplicate.user_id!==userId||duplicate.conversation_id!==id||duplicate.content!==input.content)fail('请求编号已使用',409);return duplicate}
      if(counts.rows.some(r=>Number(r.used)>=(r.scope==='platform'?1500:500)))fail('今日对话次数已用完，未扣费，请北京时间明日 00:00 后再试',429)
      await c.query('SELECT id FROM chat_conversations WHERE id=$1 FOR UPDATE',[id])
      if(await one(c,"SELECT request_id FROM chat_turns WHERE user_id=$1 AND status='pending'",[userId]))fail('上一条消息正在生成，请稍候',409)
      await c.query('INSERT INTO chat_turns(request_id,user_id,conversation_id,content) VALUES($1,$2,$3,$4)',[input.requestId,userId,id,input.content])
      await c.query('UPDATE chat_daily_counts SET used=used+1 WHERE day=$1 AND scope IN (\'platform\',$2)',[day,userId])
    })
    if(replay)return replay
    let completed=false, upstreamSucceeded=false
    const started=Date.now()
    try {
      const response=await fetch('https://apihub.agnes-ai.com/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+decryptSecret(channel!.encrypted_api_key,this.config.channelEncryptionKey),'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.any([signal,AbortSignal.timeout(90000)]),redirect:'error'})
      if(!response.ok)fail('AI 暂时无法回答，未扣费，请稍后重试',502)
      const data:any=await response.json()
      const answer=data?.choices?.[0]?.message?.content
      if(typeof answer!=='string'||!answer.trim()||answer.length>100000)fail('回答内容异常，未扣费，请稍后重试',502)
      upstreamSucceeded=true
      // Store the answer before settlement so a network retry never repeats a paid upstream call.
      const settlement = {billing:'free',userId,requestId:input.requestId,model:'gpt-5.6-sol',upstreamModel:'agnes-3.0-flash',channelId:channel!.id,channelName:channel!.name,requestPath:'/v1/site-chat',requestMethod:'POST',usage:usageFromPayload(data),success:true,statusCode:200,latencyMs:Date.now()-started}
      await this.db.query('UPDATE chat_turns SET answer=$2,settlement=$3::jsonb WHERE request_id=$1',[input.requestId,answer,JSON.stringify(settlement,(_key,value)=>typeof value==='bigint'?value.toString():value)])
      completed=true
      await this.db.query("UPDATE chat_turns SET status='completed' WHERE request_id=$1",[input.requestId])
      await this.db.query("UPDATE chat_conversations SET title=CASE WHEN title='新对话' THEN $2 ELSE title END,updated_at=now() WHERE id=$1",[id,input.content.slice(0,30)])
      return {request_id:input.requestId,status:'completed',answer}
    } catch(error:any) {
      if(!completed && !upstreamSucceeded){
        await this.db.query("UPDATE chat_turns SET status='failed',error_message=$2 WHERE request_id=$1",[input.requestId,'回答未完成，未扣费，可以重新发送。']).catch(()=>undefined)
      }
      fail(completed?'回答已生成，请刷新对话查看':upstreamSucceeded?'回答已生成，正在保存记录，请稍后刷新':'回答未完成，未扣费，可以重新发送。',502)
    }
  }
}
