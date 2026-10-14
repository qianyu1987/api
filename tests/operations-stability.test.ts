import { afterEach, describe, expect, test, vi } from 'vitest'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { encryptSecret } from '../src/lib/crypto.js'
import { ChannelService } from '../src/services/channels.js'
import { affectsChannelHealth, healthStatus, rankChannels, ChannelHealthService } from '../src/services/channel-health.js'
import { StreamDiagnostics, classifyStreamFailure } from '../src/lib/stream-diagnostics.js'
import { ProductAnalytics } from '../src/services/product-analytics.js'
import { VideoKeyService } from '../src/services/video-keys.js'
import { buildApp } from '../src/server.js'
import { loadConfig } from '../src/config.js'

const primary = { id:'primary',priority:1,timeoutMs:30000 }
const backup = { id:'backup',priority:2,timeoutMs:30000 }
const stats = (id:string,overrides:any={}) => ({channel_id:id,model:'m',samples:20,successes:20,p95_ms:100,consecutive_failures:0,circuit_open_until:null,...overrides})
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs()})
describe('completed-response channel health',()=>{
 test.each([['canceled',200],['client_error',413],['client_error',400],['client_error',422]])('excludes request/client failure %s %s',(outcome,status)=>expect(affectsChannelHealth(String(outcome),Number(status))).toBe(false))
 test.each([['rate_limited',429],['server_error',503],['timeout',null],['network_error',null],['client_error',401],['client_error',403]])('counts channel failure %s %s',(outcome,status)=>expect(affectsChannelHealth(String(outcome),status as any)).toBe(true))
 test('excludes a model absent from a verified provider directory',()=>expect(rankChannels([primary,backup],[stats('primary',{compatible:false})]).map(c=>c.id)).toEqual(['backup']))
 test('keeps the configured healthy main route',()=>expect(rankChannels([backup,primary],[stats('primary',{p95_ms:1000}),stats('backup')])[0].id).toBe('primary'))
 test('moves a failing primary behind the healthy backup',()=>expect(rankChannels([primary,backup],[stats('primary',{successes:10,consecutive_failures:3}),stats('backup')])[0].id).toBe('backup'))
 test('switches an excessively slow main route',()=>expect(rankChannels([primary,backup],[stats('primary',{p95_ms:31000}),stats('backup')])[0].id).toBe('backup'))
 test('excludes an open circuit and allows it to recover after cooldown',()=>{
  const h=stats('primary',{circuit_open_until:new Date(Date.now()+60000)})
  expect(rankChannels([primary,backup],[h])[0].id).toBe('backup')
  expect(healthStatus(h,Date.now()+61000)).toBe('healthy')
 })
 test('sorts equal-priority candidates by completed success rate then latency',()=>{
  const a={...primary,priority:2}
  expect(rankChannels([a,backup],[stats(a.id,{successes:18}),stats(backup.id,{successes:19,p95_ms:1000})])[0].id).toBe('backup')
 })
 test('does not mutate circuits or store observations for 413/client disconnect',async()=>{
  const tx=vi.fn();const service=new ChannelHealthService({tx} as any)
  await service.observe({channelId:'c',model:'m',outcome:'client_error',latencyMs:1,statusCode:413})
  await service.observe({channelId:'c',model:'m',outcome:'canceled',latencyMs:1,statusCode:200})
  expect(tx).not.toHaveBeenCalled()
 })
})
describe('non-billable compatibility refresh',()=>{
 test('checks model IDs without changing mappings and ignores directory outages',async()=>{
  const secret=Buffer.alloc(32,9)
  const rows=[{id:randomUUID(),base_url:'https://mock.test/v1',encrypted_api_key:encryptSecret('mock-key',secret),model_map:{'gpt-5.6-terra':'absent','gpt-6.1-sol':'available'}}]
  const query=vi.fn(async(sql:string)=>sql.startsWith('SELECT')?rows:[])
  const service=new ChannelService({query} as any,{channelEncryptionKey:secret} as any)
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('{"data":[{"id":"available"}]}',{headers:{'content-type':'application/json'}})))
  await service.refreshCompatibility()
  const writes=query.mock.calls.filter(([sql])=>sql.startsWith('INSERT'))
  expect(writes).toHaveLength(2)
  expect((writes[0] as any)[1][2]).toBe(false);expect((writes[1] as any)[1][2]).toBe(true)
  query.mockClear();vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status:503})))
  await service.refreshCompatibility();expect(query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false)
  vi.unstubAllGlobals()
 })
})
describe('stream protocol diagnostics',()=>{
 test.each(['data: [DONE]\n\n','event: response.completed\ndata: {"type":"response.completed"}\n\n','data: {"type":"response.incomplete"}\n\n'])('detects a complete terminal marker across every chunk boundary',text=>{
  for(let i=0;i<=text.length;i++){const d=new StreamDiagnostics();d.consume(text.slice(0,i));d.consume(text.slice(i));expect(d.complete).toBe(true);expect(d.failed).toBe(false)}
 })
 test('does not accept an EOF after partial output as success',()=>{const d=new StreamDiagnostics();d.consume('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');expect(d.complete).toBe(false)})
 test('records full usage only when both token totals exist',()=>{const d=new StreamDiagnostics();d.consume('data: {"usage":{"input_tokens":10}}\n\n');expect(d.completeUsage).toBe(false);d.consume('data: {"usage":{"input_tokens":10,"output_tokens":2}}\n\n');expect(d.completeUsage).toBe(true)})
 test('does not let DONE conceal a semantic error',()=>{const d=new StreamDiagnostics();d.consume('data: {"error":{"code":"upstream_error"}}\n\ndata: [DONE]\n\n');expect(d.failed).toBe(true)})
 test.each([[{code:'UND_ERR_BODY_TIMEOUT'},false,'upstream_stream_timeout'],[{name:'TimeoutError'},false,'upstream_stream_timeout'],[{code:'ECONNRESET'},false,'upstream_stream_interrupted'],[{code:'ECONNRESET'},true,'client_disconnected']])('classifies %j client=%s',(error,disconnected,expected)=>expect(classifyStreamFailure(error,disconnected as boolean)).toBe(expected))
})
describe('video reservation protection',()=>{
 test.each([{upstream_id:'accepted',status:'processing'},{provider_quota_uncertain:true,status:'failed'}])('cannot release an accepted or ambiguous provider reservation %j',async(extra)=>{
  const query=vi.fn(async()=>({rows:[{...extra,video_provider_key_id:'k',quota_day:'2026-10-13',quota_seconds_reserved:4}]}))
  const service=new VideoKeyService({tx:async(fn:any)=>fn({query})} as any,{} as any)
  expect(await service.releaseTaskReservation('t')).toBe(false)
  expect(query.mock.calls.every(([sql])=>sql.startsWith('SELECT'))).toBe(true)
 })
 test('does not rotate credentials while an accepted task still needs polling',async()=>{
  const query=vi.fn(async(sql:string)=>({rows:sql.includes('FROM media_tasks')?[{count:1}]:[{id:'key',channel_id:'channel'}]}))
  const service=new VideoKeyService({tx:async(fn:any)=>fn({query})} as any,{channelEncryptionKey:Buffer.alloc(32,1)} as any)
  await expect(service.rotate('key','mock-replacement')).rejects.toMatchObject({statusCode:409})
  expect(query.mock.calls.every(([sql])=>sql.startsWith('SELECT'))).toBe(true)
 })
 test('does not accept a second upstream task ID',async()=>{
  const query=vi.fn(async()=>({rows:[{upstream_id:'original',status:'processing'}]}))
  expect(await new VideoKeyService({tx:async(fn:any)=>fn({query})} as any,{} as any).acceptTask('t','duplicate')).toBe(false)
  expect(query.mock.calls.every(([sql])=>sql.startsWith('SELECT'))).toBe(true)
 })
})
describe('product event boundary',()=>{
 test('uses a stable pseudonym, isolated by server secret',()=>{
  const a=new ProductAnalytics({} as any,'secret-a');const b=new ProductAnalytics({} as any,'secret-b')
  expect(a.subject('user')).toMatch(/^[0-9a-f]{64}$/);expect(a.subject('user')).not.toContain('user');expect(a.subject('user')).not.toBe(b.subject('user'))
 })
})
describe('HTTP stability and accounting boundary',()=>{
 async function fixture(role='user'){
  vi.stubEnv('NODE_ENV','test');const s=await buildApp(loadConfig())
  vi.spyOn(s.db,'query').mockResolvedValue([])
  vi.spyOn(s.db,'one').mockImplementation(async(sql:string)=>sql.includes('FROM users')?{id:randomUUID(),role,status:'active',username:'tester',created_at:new Date()}:null as any)
  vi.spyOn(s.auth,'authenticateApiKey').mockResolvedValue({user:{id:'user'},key:{id:'key',name:'key'}} as any)
  vi.spyOn(s.billing,'priceForRequest').mockResolvedValue({modelPattern:'gpt-5.6-terra',billingMode:'token',inputSellMicrosPerMillion:1000000n,outputSellMicrosPerMillion:1000000n,cacheSellMicrosPerMillion:1000000n,inputCostMicrosPerMillion:100000n,outputCostMicrosPerMillion:100000n,cacheCostMicrosPerMillion:100000n,fixedCostMicros:0n,fixedSellMicros:0n} as any)
  vi.spyOn(s.billing,'reserve').mockResolvedValue({} as any)
  vi.spyOn(s.billing,'settle').mockResolvedValue({} as any)
  vi.spyOn(s.channels.health,'observe').mockResolvedValue(undefined)
  await s.app.ready()
  return s
 }
 test('Terra maintenance fails before reservation or upstream submission',async()=>{
  const s=await fixture();try{
   vi.spyOn(s.channels,'nativeAvailable').mockResolvedValue(false);const relay=vi.spyOn(s.channels,'relay')
   const r=await s.app.inject({method:'POST',url:'/v1/responses',headers:{authorization:'Bearer test'},payload:{model:'gpt-5.6-terra'}})
   expect(r.statusCode).toBe(503);expect(r.json().error.code).toBe('model_maintenance');expect(s.billing.reserve).not.toHaveBeenCalled();expect(relay).not.toHaveBeenCalled()
  }finally{await s.app.close();await s.db.close()}
 })
 test('operations is admin-only and browser events cannot forge payments',async()=>{
  const s=await fixture();try{
   expect((await s.app.inject({url:'/api/admin/operations'})).statusCode).toBe(401)
   const headers={cookie:'relay_session='+s.app.jwt.sign({sub:'user'})}
   expect((await s.app.inject({url:'/api/admin/operations',headers})).statusCode).toBe(403)
   expect((await s.app.inject({url:'/api/me/events',method:'POST',headers,payload:{event:'payment_succeeded'}})).statusCode).toBe(400)
   expect((await s.app.inject({url:'/api/me/events',method:'POST',headers,payload:{event:'visit',userId:'spoof'}})).statusCode).toBe(400)
   expect((await s.app.inject({url:'/api/me/events',method:'POST',headers,payload:{event:'visit'}})).statusCode).toBe(200)
  }finally{await s.app.close();await s.db.close()}
 })
 test('static pages still serve with the upgraded Fastify plugins',async()=>{
  const s=await fixture();try{
   const page=await s.app.inject({url:'/'})
   expect(page.statusCode).toBe(200);expect(page.headers['content-type']).toContain('text/html');expect(page.body).toContain('app.js?v=1.0.116')
   expect((await s.app.inject({url:'/src/db/schema.sql'})).statusCode).toBe(404)
   const cookie='relay_session='+s.app.jwt.sign({sub:'user',exp:Math.floor(Date.now()/1000)-60})
   expect((await s.app.inject({url:'/api/admin/operations',headers:{cookie}})).statusCode).toBe(401)
  }finally{await s.app.close();await s.db.close()}
 })
 test('actual client socket disconnect is canceled and never retried',async()=>{
  const s=await fixture();try{
   const stream=new Readable({read(){this.push('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');this._read=()=>{}}})
   const relay=vi.spyOn(s.channels,'relay').mockResolvedValue({channel:{id:randomUUID(),name:'mock'},attempts:[{channelId:randomUUID(),statusCode:200,latencyMs:1}],upstreamModel:'mock',response:{statusCode:200,headers:{'content-type':'text/event-stream'},body:stream}} as any)
   await s.app.listen({port:0,host:'127.0.0.1'})
   const address=s.app.server.address() as any
   await new Promise<void>((resolve,reject)=>{
    const req=httpRequest({host:'127.0.0.1',port:address.port,path:'/v1/responses',method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'}},response=>response.once('data',()=>{req.destroy();resolve()}))
    req.on('error',e=>{if((e as any).code!=='ECONNRESET')reject(e)});req.end(JSON.stringify({model:'gpt-6.1-sol',stream:true}))
   })
   await vi.waitFor(()=>expect(s.billing.settle).toHaveBeenCalledWith(expect.objectContaining({success:false,errorCode:'client_disconnected',statusCode:499})))
   expect(relay).toHaveBeenCalledTimes(1);expect(s.billing.settle).toHaveBeenCalledTimes(1)
  }finally{await s.app.close();await s.db.close()}
 })
 test.each(['upstream_stream_interrupted','upstream_stream_timeout'])('partial stream %s settles once and never retries',async(reason)=>{
  const s=await fixture();try{
   const chunks=Readable.from((async function*(){yield Buffer.from('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');if(reason==='upstream_stream_timeout')throw Object.assign(new Error('timeout'),{code:'UND_ERR_BODY_TIMEOUT'})})())
   const relay=vi.spyOn(s.channels,'relay').mockResolvedValue({channel:{id:randomUUID(),name:'mock',modelMap:{}},attempts:[{channelId:randomUUID(),statusCode:200,latencyMs:1}],upstreamModel:'mock',response:{statusCode:200,headers:{'content-type':'text/event-stream'},body:chunks}} as any)
   const r=await s.app.inject({url:'/v1/responses',method:'POST',headers:{authorization:'Bearer test'},payload:{model:'gpt-6.1-sol',stream:true}})
   expect(r.body).toContain('partial');expect(relay).toHaveBeenCalledTimes(1);expect(s.billing.settle).toHaveBeenCalledTimes(1)
   expect(s.billing.settle).toHaveBeenCalledWith(expect.objectContaining({success:false,errorCode:reason}))
  }finally{await s.app.close();await s.db.close()}
 })
})
