import { describe, expect, test, vi } from 'vitest'
import { chatDay, chatInput, ChatService } from '../src/services/chat.js'
const id='11111111-1111-4111-8111-111111111111'
describe('site chat safety',()=>{
 test('resets at Beijing midnight across UTC dates',()=>{
  expect(chatDay(new Date('2026-09-14T15:59:59Z'))).toEqual({day:'2026-09-14',resetsAt:'2026-09-14T16:00:00.000Z'})
  expect(chatDay(new Date('2026-09-14T16:00:00Z')).day).toBe('2026-09-15')
 })
 test('requires bounded text and a stable request id',()=>{
  expect(chatInput({content:'  你好 ',requestId:id}).content).toBe('你好')
  for(const content of ['', ' ', 'x'.repeat(12001), null])expect(()=>chatInput({content,requestId:id})).toThrow()
  expect(()=>chatInput({content:'你好',requestId:'invalid'})).toThrow()
 })
 test('enforces ownership before reading conversation history',async()=>{
  const query=vi.fn();const service=new ChatService({one:async()=>null,query} as any,{} as any,{} as any)
  await expect(service.messages('user',id)).rejects.toMatchObject({statusCode:404})
  expect(query).not.toHaveBeenCalled()
 })
 test('replays cannot submit another upstream request',async()=>{
  const billing={priceForRequest:vi.fn()}
  const db={query:async()=>[],one:vi.fn().mockResolvedValueOnce({id}).mockResolvedValueOnce({content:'hi',status:'completed',answer:'hello'})}
  const service=new ChatService(db as any,{} as any,billing as any)
  expect(await service.send('user',id,{content:'hi',requestId:id},new AbortController().signal)).toMatchObject({answer:'hello'})
  expect(billing.priceForRequest).not.toHaveBeenCalled()
 })
 test('rejects changing content while reusing the request id',async()=>{
  const db={query:async()=>[],one:vi.fn().mockResolvedValueOnce({id}).mockResolvedValueOnce({content:'original'})}
  await expect(new ChatService(db as any,{} as any,{} as any).send('user',id,{content:'different',requestId:id},new AbortController().signal)).rejects.toMatchObject({statusCode:409})
 })
 test('recovers persisted answer using original settlement and never releases it',async()=>{
  const query=vi.fn().mockResolvedValueOnce([{request_id:id,user_id:'user',answer:'saved',settlement:{success:true,usage:{input:'9',output:'3',cache:'0'}}}]).mockResolvedValue([])
  const billing={settle:vi.fn(),release:vi.fn()}
  await new ChatService({query} as any,{} as any,billing as any).recover()
  expect(billing.settle).toHaveBeenCalledWith(expect.objectContaining({requestId:id,usage:{input:9n,output:3n,cache:0n}}))
  expect(billing.release).not.toHaveBeenCalled()
 })
 test('failed recovery retains pending state when settlement fails',async()=>{
  const query=vi.fn().mockResolvedValueOnce([{request_id:id,user_id:'user',answer:'saved',settlement:{success:true}}])
  const billing={settle:vi.fn().mockRejectedValue(new Error('database down')),release:vi.fn()}
  await expect(new ChatService({query} as any,{} as any,billing as any).recover()).rejects.toThrow('database down')
  expect(query).toHaveBeenCalledTimes(1);expect(billing.release).not.toHaveBeenCalled()
 })
 test('abandoned requests release funds before marking failure',async()=>{
  const query=vi.fn().mockResolvedValueOnce([{request_id:id,user_id:'user'}]).mockResolvedValue([])
  const release=vi.fn();await new ChatService({query} as any,{} as any,{release} as any).recover()
  expect(release).toHaveBeenCalledWith(id)
  expect(query).toHaveBeenCalledTimes(2)
 })
})

test('free conversation has no pricing, reserve or settle dependency', async()=>{
 const {readFileSync}=await import('node:fs')
 const source=readFileSync(new URL('../src/services/chat.ts',import.meta.url),'utf8').split('async send(')[1]
 expect(source).not.toContain('this.billing.')
})
test('free saved answer recovers without charging while legacy recovery remains supported',async()=>{
 const query=vi.fn().mockResolvedValueOnce([{request_id:id,user_id:'user',answer:'saved',settlement:{billing:'free',usage:{input:'9',output:'3',cache:'0'}}}]).mockResolvedValue([])
 const billing={settle:vi.fn(),release:vi.fn()}
 await new ChatService({query} as any,{} as any,billing as any).recover()
 expect(billing.settle).not.toHaveBeenCalled();expect(billing.release).not.toHaveBeenCalled();expect(query).toHaveBeenCalledTimes(2)
})
