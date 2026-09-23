import {describe,test,expect,vi} from 'vitest'
import {mediaPrice,validateMedia,mediaResultUrl,agnesVideoQueueFull} from '../src/lib/media.js'
import {MediaService} from '../src/services/media.js'
import {encryptSecret} from '../src/lib/crypto.js'
describe('media pricing and input',()=>{
 test('30 percent cash contribution after 3x credit and 10 percent referral',()=>{expect(mediaPrice(100000n,30000,0,1000)).toBe(500000n);expect(mediaPrice(100000n,30000,60,1000)).toBe(505051n)})
 test('rounds up and rejects zero/unknown cost or excessive expenses',()=>{expect(mediaPrice(1n,30000,0,0)).toBe(5n);expect(()=>mediaPrice(0n,30000,0,0)).toThrow();expect(()=>mediaPrice(1n,30000,7000,0)).toThrow()})
 test('normalizes image edit and seconds without permitting extra billable references',()=>{expect(validateMedia({kind:'image',prompt:'test',images:['https://example.com/a.png']})).toMatchObject({units:1,payload:{extra_body:{image:['https://example.com/a.png'],response_format:'url'}}});expect(validateMedia({kind:'video',prompt:'test',seconds:'12'}).units).toBe(12);expect(()=>validateMedia({kind:'image',prompt:'test',images:Array(4).fill('https://example.com/a.png')})).toThrow()})
 test('maps the public professional engine without exposing a client-selected upstream model',()=>{
  expect(validateMedia({kind:'image',engine:'pro',prompt:'test',size:'1K',ratio:'9:16'})).toMatchObject({engine:'pro',model:'gpt-image-2',payload:{model:'gpt-image-2',size:'1024x1536',quality:'low',output_format:'png',n:1}})
  expect(()=>validateMedia({kind:'image',engine:'pro',prompt:'test',size:'2K'})).toThrow('仅开放 1K')
  expect(()=>validateMedia({kind:'image',engine:'pro',prompt:'test',images:['https://example.com/a.png']})).toThrow('仅支持文字')
  expect(()=>validateMedia({kind:'image',engine:'unknown',prompt:'test'})).toThrow('引擎')
 })
 test('maps the enhanced image engine to its separate provider model',()=>{
  expect(validateMedia({kind:'image',engine:'enhanced',prompt:'test',size:'1K'})).toMatchObject({engine:'enhanced',model:'gpt-image-2.5',payload:{model:'gpt-image-2.5',size:'1536x1024'}})
 })
 test('keeps standard images free while preserving their upstream cost snapshot',async()=>{
  const s=new MediaService({one:vi.fn(async(sql:string)=>sql.includes('media_prices')?{enabled:true,channel_enabled:true,cost_source:'Agnes',normal_cost_micros:'100',actual_cost_micros:'80',channel_id:'channel'}:null),query:vi.fn(async()=>[])} as any,{walletTopupMultiplierBps:30000} as any)
  const q=await s.quote('user',{kind:'image',engine:'standard',prompt:'test',size:'1K'})
  expect(q.chargeMicros).toBe('0');expect(q.snapshot).toMatchObject({freeStandard:true,actualCostMicros:'80'})
 })
 test.each([{kind:'video',size:'1080P'},{kind:'video',seconds:13},{kind:'video',mode:'reference'},{kind:'video',mode:'text',images:['https://example.com/a']},{kind:'video',mode:'keyframe'},{kind:'image',size:'100K'},{kind:'image',n:2},{kind:'image',images:['http://localhost/a']}])('rejects unsupported request %j',p=>{expect(()=>validateMedia({prompt:'test',...p})).toThrow()})
 test('only accepts HTTPS result links',()=>{expect(mediaResultUrl({data:[{url:'https://example.com/x.png'}]})).toBe('https://example.com/x.png');expect(mediaResultUrl({url:'javascript:alert(1)'})).toBeNull();expect(mediaResultUrl({metadata:{url:'https://example.com/video.mp4'}})).toBe('https://example.com/video.mp4')})
})
describe('media submission lifecycle',()=>{
 test.each([
  [503,{code:503,message:'video queue is full, please retry later (request id: diagnostic)',data:null},true],
  [503,{message:'video queue is full, please retry later',data:null,video_id:'accepted-task'},false],
  [503,{message:'video queue is full, please retry later',data:{id:'accepted-task'}},false],
  [503,{message:'service unavailable'},false],
  [200,{message:'video queue is full, please retry later'},false],
 ])('only recognizes explicit queue admission rejection (%s)',(status,payload,expected)=>{
  expect(agnesVideoQueueFull(status as number,payload)).toBe(expected)
 })
 test.each(['queued','processing'])('queue-full response while %s only requeues an unaccepted submission',async(status)=>{
  const key=Buffer.alloc(32,12),task={id:'task',kind:'video',model:'agnes-video-2.5-flash',status,channel_id:'channel',request_payload:{},upstream_id:status==='processing'?'accepted-task':null}
  const query=vi.fn(async()=>[])
  const db:any={query,one:vi.fn(async()=>({id:'channel',base_url:'https://apihub.agnes-ai.com/v1',encrypted_api_key:encryptSecret('provider-key',key),enabled:true})),tx:async(fn:any)=>fn({query:vi.fn(async(sql:string)=>({rows:sql.startsWith('SELECT')?[task]:[]}))})}
  const svc=new MediaService(db,{channelEncryptionKey:key} as any),finish=vi.spyOn(svc,'finish').mockResolvedValue()
  const fetchMock=vi.fn(async()=>new Response(JSON.stringify({code:503,message:'video queue is full, please retry later (request id: diagnostic)',data:null}),{status:503}))
  vi.stubGlobal('fetch',fetchMock)
  try{await svc.tick()}finally{vi.unstubAllGlobals()}
  expect(fetchMock).toHaveBeenCalledTimes(1)
  if(status==='queued'){
   expect(finish).not.toHaveBeenCalled()
   expect(query.mock.calls.some(([sql,params])=>sql.includes("SET status='queued'")&&params?.[0]==='task')).toBe(true)
  }else{
   expect(finish).not.toHaveBeenCalled()
   expect(query.mock.calls.some(([sql,params])=>sql.includes("SET status='unknown'")&&params?.[0]==='task')).toBe(true)
  }
 })
 test('generic submit 503 remains uncertain and is never resubmitted',async()=>{
  const key=Buffer.alloc(32,13),task={id:'task',kind:'video',model:'agnes-video-2.5-flash',status:'queued',channel_id:'channel',request_payload:{}}
  const query=vi.fn(async()=>[])
  const db:any={query,one:vi.fn(async()=>({id:'channel',base_url:'https://apihub.agnes-ai.com/v1',encrypted_api_key:encryptSecret('provider-key',key),enabled:true})),tx:async(fn:any)=>fn({query:vi.fn(async(sql:string)=>({rows:sql.startsWith('SELECT')?[task]:[]}))})}
  const svc=new MediaService(db,{channelEncryptionKey:key} as any),finish=vi.spyOn(svc,'finish').mockResolvedValue()
  const fetchMock=vi.fn(async()=>new Response('Service unavailable',{status:503}));vi.stubGlobal('fetch',fetchMock)
  try{await svc.tick()}finally{vi.unstubAllGlobals()}
  expect(fetchMock).toHaveBeenCalledTimes(1);expect(finish).not.toHaveBeenCalled()
  expect(query.mock.calls.some(([sql,params])=>sql.includes("SET status='unknown'")&&params?.[0]==='task')).toBe(true)
 })
 test('legacy unknown task starts its automatic confirmation window',async()=>{
  const query=vi.fn(async()=>[])
  const db:any={query,tx:async(fn:any)=>fn({query:vi.fn(async()=>({rows:[]}))})}
  await new MediaService(db,{} as any).tick()
  expect(query.mock.calls.some(([sql])=>sql.includes("status='unknown' AND uncertain_since IS NULL"))).toBe(true)
 })
 test('ambiguous submit is not resent or released',async()=>{
 const task={id:'task',kind:'video',model:'agnes-video-2.5-flash',status:'queued',channel_id:'channel',request_payload:{}}
 const query=vi.fn(async()=>[]);const db:any={query,one:vi.fn(async()=>({id:'channel',base_url:'https://apihub.agnes-ai.com/v1',encrypted_api_key:'bad',enabled:true})),tx:async(fn:any)=>fn({query:vi.fn(async(sql:string)=>({rows:sql.startsWith('SELECT')?[task]:[]}))})}
 const s=new MediaService(db,{channelEncryptionKey:Buffer.alloc(32)} as any);const finish=vi.spyOn(s,'finish');await s.tick();expect(finish).not.toHaveBeenCalled()
 expect(query.mock.calls.some(([sql,params])=>sql.includes("SET status='unknown'")&&params?.[0]==='task')).toBe(true)
 })
 test('unknown task without upstream id is never submitted again',async()=>{
  const task={id:'task',kind:'video',model:'agnes-video-2.5-flash',status:'unknown',channel_id:'channel',request_payload:{},upstream_id:null}
  const query=vi.fn(async(sql:string)=>sql.startsWith('SELECT id FROM media_tasks')?[]:[])
  const db:any={query,one:vi.fn(),tx:async(fn:any)=>fn({query:vi.fn(async(sql:string)=>({rows:sql.startsWith('SELECT')?[task]:[]}))})}
  const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock)
  try{await new MediaService(db,{} as any).tick()}finally{vi.unstubAllGlobals()}
  expect(fetchMock).not.toHaveBeenCalled();expect(db.one).not.toHaveBeenCalled()
  expect(query.mock.calls.some(([sql])=>sql.includes("WHERE id=$1 AND status='unknown'"))).toBe(true)
 })
 test('unknown video task expires after 45 minutes and is refunded',async()=>{
  const query=vi.fn(async(sql:string)=>sql.includes("status='unknown'")?[{id:'expired',kind:'video'}]:[])
  const s=new MediaService({query,tx:vi.fn()} as any,{} as any),finish=vi.spyOn(s,'finish').mockResolvedValue()
  await s.tick()
  expect(finish).toHaveBeenCalledWith('expired',false,null,'暂时无法安排生成，额度已全部退回',undefined,undefined,'confirmation_timeout')
 })
 test('unknown task with upstream id recovers within the confirmation window',async()=>{
  const key=Buffer.alloc(32,6),task={id:'task',kind:'video',model:'agnes-video-2.5-flash',status:'unknown',channel_id:'channel',request_payload:{},upstream_id:'upstream',uncertain_since:new Date()}
  const query=vi.fn(async()=>[]);const db:any={query,one:vi.fn(async()=>({base_url:'https://apihub.agnes-ai.com/v1',encrypted_api_key:encryptSecret('provider-key',key),enabled:true})),tx:async(fn:any)=>fn({query:vi.fn(async(sql:string)=>({rows:sql.startsWith('SELECT')?[task]:[]}))})}
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({status:'processing',progress:42}),{status:200})))
  try{await new MediaService(db,{channelEncryptionKey:key} as any).tick()}finally{vi.unstubAllGlobals()}
  expect(query.mock.calls.some(([sql,params])=>sql.includes("SET status='processing'")&&params?.[0]==='task'&&params?.[1]===42)).toBe(true)
  expect(query.mock.calls.some(([sql])=>sql.includes('uncertain_since=NULL'))).toBe(true)
 })
 test('video tasks reject non-Agnes channel mappings before contacting the provider',async()=>{
  const key=Buffer.alloc(32,10),task={id:'task',kind:'video',model:'agnes-video-2.5-flash',status:'queued',channel_id:'channel',request_payload:{}}
  const db:any={query:vi.fn(async()=>[]),one:vi.fn(async()=>({id:'channel',base_url:'https://ripp.best/v1',encrypted_api_key:encryptSecret('provider-key',key)})),tx:async(fn:any)=>fn({query:vi.fn(async(sql:string)=>({rows:sql.startsWith('SELECT')?[task]:[]}))})}
  const svc=new MediaService(db,{channelEncryptionKey:key} as any),finish=vi.spyOn(svc,'finish').mockResolvedValue()
  const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock)
  try{await svc.tick()}finally{vi.unstubAllGlobals()}
  expect(fetchMock).not.toHaveBeenCalled()
  expect(finish).toHaveBeenCalledWith('task',false,null,'媒体渠道与模型不匹配，冻结额度已释放',undefined,undefined,'channel_mismatch')
 })
 test('queued image with a disabled or deleted channel is refunded without an upstream call',async()=>{
  const task={id:'task',kind:'image',model:'gpt-image-2.5',status:'queued',channel_id:'channel',request_payload:{model:'gpt-image-2.5'}}
  const db:any={query:vi.fn(async()=>[]),one:vi.fn(async()=>null),tx:async(fn:any)=>fn({query:vi.fn(async(sql:string)=>({rows:sql.startsWith('SELECT')?[task]:[]}))})}
  const svc=new MediaService(db,{} as any),finish=vi.spyOn(svc,'finish').mockResolvedValue()
  const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock)
  try{await svc.tick()}finally{vi.unstubAllGlobals()}
  expect(fetchMock).not.toHaveBeenCalled()
  expect(finish).toHaveBeenCalledWith('task',false,null,'生成失败，额度已自动退回',undefined,undefined,'no_compatible_channel')
 })
 test('public task has safe retry input and no cost, internal payload, upstream id or snapshots',()=>{const s=new MediaService({} as any,{} as any);const t=s.publicTask({id:'test',kind:'video',status:'processing',created_at:new Date(),charge_micros:'10',user_input:{kind:'video',engine:'standard',prompt:'retry me',size:'720P',ratio:'9:16',seconds:5,mode:'text'},price_snapshot:{secret:true},actual_cost_micros:'10',request_payload:{privatePayload:true},upstream_id:'private',channel_id:'channel'});expect(t.reserved).toBe(true);expect(t.input).toMatchObject({prompt:'retry me',engine:'standard',ratio:'9:16'});expect(t.canRetry).toBe(false);expect(JSON.stringify(t)).not.toMatch(/secret|privatePayload|upstream|channel|actual_cost|snapshot|request_payload/);expect(s.publicTask({status:'failed'})).toMatchObject({reserved:false,canRetry:true,refundStatus:'returned'})})
 test('professional image worker accepts base64 without exposing an upstream URL',async()=>{
  const key=Buffer.alloc(32,7),task={id:'task',kind:'image',model:'gpt-image-2',status:'queued',channel_id:'channel',request_payload:{model:'gpt-image-2'}}
  const db:any={query:vi.fn(async()=>[]),one:vi.fn(async()=>({id:'channel',base_url:'https://cdn.yyapi.cloud/v1',encrypted_api_key:encryptSecret('provider-key',key)})),tx:async(fn:any)=>fn({query:vi.fn(async(sql:string)=>({rows:sql.startsWith('SELECT')?[task]:[]}))})}
  const svc=new MediaService(db,{channelEncryptionKey:key} as any),finish=vi.spyOn(svc,'finish').mockResolvedValue()
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({data:[{b64_json:Buffer.from([0x89,0x50,...Array(20).fill(0)]).toString('base64')}]}),{status:200,headers:{'content-type':'application/json'}})))
  try{await svc.tick()}finally{vi.unstubAllGlobals()}
  expect(finish).toHaveBeenCalledWith('task',true,null,null,expect.any(Buffer),'image/png')
 })
 test('explicit non-json policy rejection releases the wallet hold',async()=>{
  const key=Buffer.alloc(32,8),task={id:'task',kind:'image',model:'gpt-image-2.5',status:'queued',channel_id:'channel',request_payload:{model:'gpt-image-2.5'}}
  const db:any={query:vi.fn(async()=>[]),one:vi.fn(async()=>({id:'channel',base_url:'https://ripp.best/v1',encrypted_api_key:encryptSecret('provider-key',key)})),tx:async(fn:any)=>fn({query:vi.fn(async(sql:string)=>({rows:sql.startsWith('SELECT')?[task]:[]}))})}
  const svc=new MediaService(db,{channelEncryptionKey:key} as any),finish=vi.spyOn(svc,'finish').mockResolvedValue()
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('status_code=400, request rejected',{status:400})))
  try{await svc.tick()}finally{vi.unstubAllGlobals()}
  expect(finish).toHaveBeenCalledWith('task',false,null,'提示词未通过上游审核，额度已全部退回',undefined,undefined,'upstream_rejected')
 })
})

describe('wallet media settlement',()=>{
 test.each([true,false])('settles or releases exactly once: %s',async success=>{
 const task:any={id:'task',user_id:'user',status:'processing',charge_micros:'50',price_snapshot:{},actual_cost_micros:'10'}
 const wallet:any={balance_micros:'100',reserved_micros:'50'};const ledgers:any[]=[]
 const query=vi.fn(async(sql:string,params:any[])=>{
 if(sql.startsWith('SELECT * FROM media_tasks'))return {rows:[task]}
 if(sql.startsWith('SELECT balance_micros'))return {rows:[wallet]}
 if(sql.startsWith('UPDATE wallets')){wallet.balance_micros=params[0];wallet.reserved_micros=String(BigInt(wallet.reserved_micros)-BigInt(params[1]))}
 if(sql.startsWith('INSERT INTO wallet_ledger'))ledgers.push(params)
 if(sql.startsWith('UPDATE media_tasks'))task.status=params[1]
 return {rows:[]}
 });const s=new MediaService({tx:async(fn:any)=>fn({query})} as any,{} as any)
 await s.finish('task',success,success?'https://example.com/result':null,null);await s.finish('task',success,null,null)
 expect(wallet.balance_micros).toBe(success?'50':'100');expect(wallet.reserved_micros).toBe('0');expect(ledgers).toHaveLength(1);expect(ledgers[0][1]).toBe(success?'usage_settle':'usage_release')
 expect(query.mock.calls.some(([sql])=>sql.includes('subscription'))).toBe(false)
 })
})

describe('stored media results',()=>{
 test('stores generated bytes and settles the wallet exactly once',async()=>{
  const task:any={id:'task',user_id:'user',status:'submitting',charge_micros:'50',price_snapshot:{},actual_cost_micros:'10'}
  const wallet:any={balance_micros:'100',reserved_micros:'50'};const assets:any[]=[]
  const query=vi.fn(async(sql:string,params:any[])=>{
   if(sql.startsWith('SELECT * FROM media_tasks'))return {rows:[task]}
   if(sql.startsWith('SELECT balance_micros'))return {rows:[wallet]}
   if(sql.startsWith('UPDATE wallets')){wallet.balance_micros=params[0];wallet.reserved_micros='0'}
   if(sql.startsWith('INSERT INTO media_task_assets'))assets.push(params)
   if(sql.startsWith('UPDATE media_tasks')){task.status=params[1];task.result_url=params[2]}
   return {rows:[]}
  })
  const svc=new MediaService({tx:async(fn:any)=>fn({query})} as any,{} as any)
  await svc.finish('task',true,null,null,Buffer.from([0x89,0x50,...Array(20).fill(0)]),'image/png')
  expect(assets).toHaveLength(1);expect(task.result_url).toBe('stored://media/task');expect(wallet.balance_micros).toBe('50')
 })
})

describe('media idempotency conflicts',()=>{
 test('concurrent nonce reuse rejects a different payload even at same price',async()=>{
  const input=validateMedia({kind:'image',prompt:'first'})
  const db:any={one:async()=>null,tx:async(fn:any)=>fn({query:async(sql:string)=>({rows:sql.startsWith('SELECT * FROM media_tasks')?[{request_payload:input.payload,price_snapshot:{chargeMicros:'50000'}}]:[]})})}
  const s=new MediaService(db,{} as any)
  await expect(s.create('user',{kind:'image',prompt:'different',idempotencyKey:'same_nonce_123456'})).rejects.toThrow('请求编号已占用')
 })
 test('retry accepts JSONB key reordering without creating another hold',async()=>{
  const p=validateMedia({kind:'image',prompt:'same'}).payload
  const old={request_payload:Object.fromEntries(Object.entries(p).reverse()),status:'completed',id:'existing',charge_micros:'50000'}
  const tx=vi.fn();const s=new MediaService({one:async()=>old,tx} as any,{} as any)
  expect(await s.create('user',{kind:'image',prompt:'same',idempotencyKey:'same_nonce_123456'})).toMatchObject({id:'existing',charged:true})
  expect(tx).not.toHaveBeenCalled()
 })
})

describe('media wallet availability',()=>{
 test('API auto quote still validates wallet and persists API key audit',async()=>{
  const query=vi.fn(async(sql:string,p:any[])=>{
   if(sql.startsWith('SELECT count'))return {rows:[{n:0}]}
   if(sql.startsWith('SELECT balance_micros'))return {rows:[{balance_micros:'100000',reserved_micros:'0'}]}
   if(sql.startsWith('INSERT INTO media_tasks'))return {rows:[{id:p[0],status:'queued',api_key_id:p[2]}]}
   return {rows:[]}
  })
  const s=new MediaService({one:async()=>null,tx:async(fn:any)=>fn({query})} as any,{} as any)
  vi.spyOn(s,'quote').mockResolvedValue({chargeMicros:'50000',quoteToken:'current',price:{channel_id:'channel'},snapshot:{actualCostMicros:'10000'}} as any)
  const body={kind:'image',prompt:'test',idempotencyKey:'auto_quote_123456'}
  await expect(s.create('user',body,'api-key-id')).rejects.toThrow('报价已变化')
  expect(await s.create('user',body,'api-key-id',true)).toMatchObject({status:'queued'})
  const insert=query.mock.calls.find(([sql])=>sql.startsWith('INSERT INTO media_tasks'))
  expect(insert?.[1][2]).toBe('api-key-id')
  expect(query.mock.calls.filter(([sql])=>sql.startsWith('UPDATE wallets'))).toHaveLength(1)
 })
 test.each([['100000','0',true],['100000','90000',false]])('uses wallet balance %s reserved %s',async(balance,reserved,allowed)=>{
 const query=vi.fn(async(sql:string,p:any[])=>{
 if(sql.startsWith('SELECT count'))return {rows:[{n:0}]}
 if(sql.startsWith('SELECT balance_micros'))return {rows:[{balance_micros:balance,reserved_micros:reserved}]}
 if(sql.startsWith('INSERT INTO media_tasks'))return {rows:[{id:p[0],status:'queued'}]}
 return {rows:[]}
 });const s=new MediaService({one:async()=>null,tx:async(fn:any)=>fn({query})} as any,{} as any)
 vi.spyOn(s,'quote').mockResolvedValue({chargeMicros:'50000',quoteToken:'quote',price:{channel_id:'channel'},snapshot:{actualCostMicros:'10000'}} as any)
 const result=s.create('user',{kind:'image',prompt:'test',idempotencyKey:'wallet_test_123456',quoteToken:'quote'})
 if(allowed)expect(await result).toMatchObject({status:'queued',reserved:true});else await expect(result).rejects.toThrow('钱包可用余额不足')
 expect(query.mock.calls.some(([sql])=>sql.includes('sum('))).toBe(false)
 })
 test('expansion rejects empty input before contacting provider',async()=>{const s=new MediaService({} as any,{} as any);await expect(s.expandPrompt({kind:'image',prompt:''})).rejects.toThrow('请先输入')})
 test('expansion rewrites sexualized details introduced by the model',async()=>{
  const key=Buffer.alloc(32,9),db:any={one:async()=>({encrypted_api_key:encryptSecret('provider-key',key)})}
  const fetchMock=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({choices:[{message:{content:'成年女性，前凸后翘，胸部丰满，衣着暴露'}}]}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({choices:[{message:{content:'一位成年女性身着完整典雅服装，站在柔和自然光下，画面构图平衡。'}}]}),{status:200}))
  vi.stubGlobal('fetch',fetchMock)
  try{const result=await new MediaService(db,{channelEncryptionKey:key} as any).expandPrompt({kind:'image',prompt:'一位东方女性'});expect(result.prompt).not.toMatch(/前凸后翘|胸部丰满|衣着暴露/);expect(result.notice).toContain('自动移除')}finally{vi.unstubAllGlobals()}
 })
})

describe('public media identity',()=>{
 test('catalog exposes user-facing tiers and labels',async()=>{
  const svc=new MediaService({query:async()=>[{model:'agnes-image-2.5-flash',size:'4K',enabled:true,normal_cost_micros:'10',channel_enabled:true},{model:'gpt-image-2',size:'1K',enabled:true,normal_cost_micros:'10',channel_enabled:true},{model:'gpt-image-2.5',size:'1K',enabled:true,normal_cost_micros:'10',channel_enabled:true}]} as any,{} as any)
  const catalog=await svc.catalog()
  expect(catalog).toEqual({items:[{kind:'image',size:'4K',engine:'standard',label:'标准图片 · 免费',available:true},{kind:'image',size:'1K',engine:'pro',label:'专业图片 · gpt-image-2.0',available:true},{kind:'image',size:'1K',engine:'enhanced',label:'增强图片 · gpt-image-2.5（顶级画质）',available:true}],walletOnly:true})
 expect(JSON.stringify(catalog)).not.toMatch(/agnes/)
 })
 test('task hides model and upstream result address',()=>{
 const svc=new MediaService({} as any,{} as any)
 const task=svc.publicTask({id:'test',kind:'video',model:'agnes-video-2.5-flash',status:'completed',result_url:'https://platform-outputs.agnes-ai.space/videos/agnes-video-2.5/test.mp4'})
 expect(task.resultUrl).toBe('/api/me/media/tasks/test/result')
 expect(JSON.stringify(task)).not.toMatch(/agnes|model/)
 })
})
