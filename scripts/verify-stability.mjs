/** Integration acceptance against a disposable, empty PostgreSQL database only.
 * Requires compiled dist and RELAY_STABILITY_DATABASE_URL ending in relay_stability_verify_*.
 * No real provider, payment, credentials, production rows or production schema changes.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Database } from '../dist/db/index.js'
import { loadConfig } from '../dist/config.js'
import { encryptSecret } from '../dist/lib/crypto.js'
import { VideoKeyService } from '../dist/services/video-keys.js'
import { MediaService } from '../dist/services/media.js'
import { ChannelHealthService } from '../dist/services/channel-health.js'
import { ProductAnalytics } from '../dist/services/product-analytics.js'
import { OperationsService } from '../dist/services/operations.js'
import { maintainStorage, refreshOperationsAlerts } from '../dist/services/maintenance.js'

const target = process.env.RELAY_STABILITY_DATABASE_URL
if (!target || !/^\/relay_stability_verify_[a-z0-9_]+$/.test(new URL(target).pathname)) throw new Error('An isolated verification database is required')
process.env.NODE_ENV='test'
const config={...loadConfig(),databaseUrl:target,channelEncryptionKey:Buffer.alloc(32,7)}
const db=new Database(config)
const replicaDb=new Database(config)
let checks=0
const check=(condition,message)=>{assert.ok(condition,message);checks++}
try {
 await db.migrate();check(!(await db.migrate()).applied,'migration idempotent')
 const user=randomUUID();await db.query("INSERT INTO users(id,username,password_hash,invite_code) VALUES($1,'stability-test',$2,'STABILITY1')",[user,'x'.repeat(64)])
 await db.query('INSERT INTO wallets(user_id,balance_micros) VALUES($1,1000000) ON CONFLICT DO NOTHING',[user])
 async function key(label,concurrency=64){
  const c=randomUUID(),k=randomUUID()
  await db.query("INSERT INTO channels(id,name,base_url,encrypted_api_key,enabled,model_map) VALUES($1,$2,'https://apihub.agnes-ai.com/v1',$3,true,'{\"agnes-video-2.5-flash\":\"agnes-video-2.5-flash\"}')",[c,label,encryptSecret('mock-no-real-credential',config.channelEncryptionKey)])
  await db.query("INSERT INTO video_provider_keys(id,channel_id,account_label,max_concurrency,enabled,video_generation_enabled,probe_status) VALUES($1,$2,$3,$4,true,true,'passed')",[k,c,label,concurrency])
  return {c,k}
 }
 const first=await key('first'); const keys=new VideoKeyService(db,config);const media=new MediaService(db,config,keys)
 async function task(channel=first.c){const id=randomUUID();await db.query("INSERT INTO media_tasks(id,user_id,idempotency_key,kind,model,channel_id,request_payload,user_input,price_snapshot,charge_micros,actual_cost_micros,status) VALUES($1::uuid,$2,$1::text,'video','agnes-video-2.5-flash',$3,'{\"seconds\":10,\"prompt\":\"mock\"}','{\"seconds\":10}','{}',0,20000,'submitting')",[id,user,channel]);return id}
 const ids=await Promise.all(Array.from({length:60},()=>task()))
 const replicaKeys=new VideoKeyService(replicaDb,config)
 const selected=await Promise.all(ids.map((id,i)=>(i%2?replicaKeys:keys).reserveForTask(id,10)))
 check(selected.filter(Boolean).length===50,'60 concurrent reservations admit exactly 500 seconds')
 let usage=await db.one('SELECT * FROM video_key_usage_daily WHERE key_id=$1',[first.k]);check(usage.reserved_seconds===500,'no oversell')
 const second=await key('second')
 const unassigned=ids.find((id,i)=>!selected[i]);const alternate=await keys.reserveForTask(unassigned,10);check(alternate.id===second.k,'insufficient quota switches key');check((await db.one('SELECT channel_id FROM media_tasks WHERE id=$1',[unassigned])).channel_id===second.c,'selected credential channel persists for later polling')
 const accepted=ids.find((id,i)=>selected[i]);check(await keys.acceptTask(accepted,'mock-existing-id'),'accepted task')
 check(!await keys.acceptTask(accepted,'never-duplicate'),'cannot accept twice');check(!await keys.releaseTaskReservation(accepted),'cannot release accepted seconds')
 let row=await db.one('SELECT * FROM media_tasks WHERE id=$1',[accepted]);check(row.status==='processing'&&row.quota_seconds_used===10&&row.quota_seconds_reserved===0,'atomic accepted transition')
 const calls=[];globalThis.fetch=async(url,options)=>{calls.push({url:String(url),method:options?.method});return new Response('{}',{status:404})}
 await media.processClaimedTask(row)
 row=await db.one('SELECT * FROM media_tasks WHERE id=$1',[accepted]);check(row.status==='unknown'&&row.diagnostic_stage==='query_not_found','query 404 distinct lifecycle')
 await media.processClaimedTask(row);check(calls.every(c=>c.method==='GET'),'accepted task never resubmitted')
 await db.query("UPDATE media_tasks SET uncertain_since=now()-interval '46 minutes',lease_until=NULL,charge_micros=350000 WHERE id=$1",[accepted])
 await db.query('UPDATE wallets SET reserved_micros=350000 WHERE user_id=$1',[user])
 await media.finish(accepted,false,null,'mock timeout',undefined,undefined,'confirmation_timeout')
 row=await db.one('SELECT * FROM media_tasks WHERE id=$1',[accepted]);check(row.status==='failed'&&row.quota_seconds_used===10,'accepted timeout retains used seconds')
 const ambiguous=unassigned;await db.query("UPDATE media_tasks SET status='unknown',uncertain_since=now()-interval '46 minutes' WHERE id=$1",[ambiguous])
 await media.finish(ambiguous,false,null,'mock timeout',undefined,undefined,'confirmation_timeout')
 row=await db.one('SELECT * FROM media_tasks WHERE id=$1',[ambiguous]);check(row.provider_quota_uncertain&&row.quota_seconds_reserved===10,'ambiguous refund holds provider quota')
 check(!await keys.releaseTaskReservation(ambiguous),'held provider quota cannot be erased')
 const reject=await task(second.c)
 globalThis.fetch=async()=>new Response('{"error":"queue full"}',{status:429})
 await media.processClaimedTask({...await db.one('SELECT * FROM media_tasks WHERE id=$1',[reject]),_wasQueued:true})
 row=await db.one('SELECT * FROM media_tasks WHERE id=$1',[reject]);check(row.status==='queued'&&row.quota_seconds_reserved===0,'429 releases and requeues')
 const completed=await task(second.c);await keys.reserveForTask(completed,10);await keys.acceptTask(completed,'mock-complete-id')
 await db.query('UPDATE media_tasks SET charge_micros=350000 WHERE id=$1',[completed]);await db.query('UPDATE wallets SET reserved_micros=350000 WHERE user_id=$1',[user])
 globalThis.fetch=async()=>new Response('{"status":"completed","url":"https://platform-outputs.agnes-ai.space/mock.mp4"}',{headers:{'content-type':'application/json'}})
 await media.processClaimedTask(await db.one('SELECT * FROM media_tasks WHERE id=$1',[completed]))
 check((await db.one('SELECT status FROM media_tasks WHERE id=$1',[completed])).status==='completed','completion closes original task')
 const third=await key('third',1)
 await db.query("INSERT INTO video_key_usage_daily(key_id,usage_day,limit_seconds,used_seconds) VALUES($1,(now() AT TIME ZONE 'Asia/Shanghai')::date-1,500,500)",[third.k])
 const slot=await task(third.c);check((await keys.reserveForTask(slot,4)).id===third.k,'Beijing new day has a fresh bucket')
 check((await keys.reserveForTask(await task(third.c),4)).id!==third.k,'per-key concurrency is enforced')
 await keys.releaseTaskReservation(slot)
 for(const setting of ["probe_status='failed'","probe_status='passed',cooldown_until=now()+interval '1 hour'","cooldown_until=NULL,enabled=false"]){
  await db.query('UPDATE video_provider_keys SET '+setting+' WHERE id=$1',[third.k])
  check((await keys.reserveForTask(await task(third.c),4)).id!==third.k,'failed probe / cooldown / paused excluded')
 }
 const health=new ChannelHealthService(db)
 const observation={id:randomUUID(),channelId:first.c,model:'gpt-6.1-sol',outcome:'success',latencyMs:10}
 await health.observe(observation);await health.observe(observation)
 check((await health.list('gpt-6.1-sol'))[0].samples===1,'idempotent health observation')
 for(let i=0;i<3;i++)await health.observe({channelId:first.c,model:'gpt-5.6-terra',outcome:'timeout',latencyMs:1})
 check((await health.list('gpt-5.6-terra'))[0].consecutive_failures===3,'health failures isolated per model')
 const analytics=new ProductAnalytics(db,'mock-pepper');await analytics.sync();await analytics.sync();await analytics.record(user,'visit');await analytics.record(user,'visit')
 check(Number((await db.one("SELECT count(*) AS n FROM product_events WHERE event='visit'")).n)===1,'daily visits deduplicated')
 check((await analytics.report()).retention.length===3,'retention SQL valid')
 await refreshOperationsAlerts(db);await maintainStorage(db)
 const report=await new OperationsService(db).report(new Date(Date.now()-86400000),new Date(Date.now()+1000))
 check(report.media.find(m=>m.kind==='video').accepted_seconds==='20','historical and current accepted seconds reported correctly')
 check(report.media.find(m=>m.kind==='video').charged.micros==='350000' && report.media.find(m=>m.kind==='video').released.micros==='350000','settled video charge and released hold reported independently')
 check(report.cashReceived.micros==='0','quota face value not misreported as cash')
 // Interleave ledger reservation, acceptance, reconciliation and key edits; lock order must not deadlock.
 const multi=await task(second.c);await keys.reserveForTask(multi,10)
 await Promise.all([keys.acceptTask(multi,'mock-concurrent-id'),keys.reconcileUsage(second.k),keys.update(second.k,{priority:111}),keys.reserveForTask(await task(second.c),10)])
 check(true,'concurrent key mutations complete without deadlock')
 check((await keys.diagnostics()).length===3,'video diagnostics SQL valid')
 console.log(JSON.stringify({checks,status:'passed',database:'isolated',providerCalls:'mock-only'}))
} finally {await db.close();await replicaDb.close()}
