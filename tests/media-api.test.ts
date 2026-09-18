import Fastify from 'fastify'
import {describe, test, expect, vi} from 'vitest'
import {mediaApiInput, registerMediaApi} from '../src/lib/media-api.js'

function fixture() {
  const app = Fastify()
  const auth = {authenticateApiKey:vi.fn(async (key:string) => {
    if (key !== 'valid') throw new Error('revoked')
    return {user:{id:'owner'},key:{id:'key-id'}}
  })}
  const media = {
    create:vi.fn(async()=>({id:'task-id',kind:'image',status:'queued',chargeMicros:'50000'})),
    get:vi.fn(async(user:string,id:string)=>{if(id!=='task-id')throw Object.assign(new Error('任务不存在'),{statusCode:404});return {id,kind:'image',status:'completed'}}),
    list:vi.fn(async()=>({items:[]})),
    quote:vi.fn(async()=>({chargeMicros:'50000',quoteToken:'quote',walletOnly:true,gift:null,price:{secret:'hidden'}})),
  }
  registerMediaApi(app,auth as any,media as any)
  return {app,auth,media}
}
const headers = {authorization:'Bearer valid','idempotency-key':'test_media_api_123456'}
describe('unified API Key media routing',()=>{
  test.each([
    ['gpt-image-2.5','enhanced','image','/v1/images/generations'],
    ['agnes-video-2.5-flash','standard','video','/v1/videos'],
  ])('routes %s through existing media billing',async(model,engine,kind,url)=>{
    const {app,media}=fixture()
    try {
      const r=await app.inject({method:'POST',url,headers,payload:{model,prompt:'test'}})
      expect(r.statusCode).toBe(202)
      expect(media.create).toHaveBeenCalledWith('owner',expect.objectContaining({model,engine,kind,idempotencyKey:headers['idempotency-key']}),'key-id',true)
      expect(r.headers.location).toBe('/v1/media/tasks/task-id')
    } finally {await app.close()}
  })
  test('rejects missing, revoked and invalid keys without generation',async()=>{
    const {app,media}=fixture()
    try {for(const authorization of ['', 'Bearer revoked']) {
      const r=await app.inject({method:'POST',url:'/v1/videos',headers:{authorization},payload:{model:'agnes-video-2.5-flash',prompt:'test'}})
      expect(r.statusCode).toBe(401)
    }expect(media.create).not.toHaveBeenCalled()}finally{await app.close()}
  })
  test('requires stable idempotency and preserves explicit quote validation',async()=>{
    const {app,media}=fixture(),payload={model:'gpt-image-2.5',prompt:'test'}
    try {
      expect((await app.inject({method:'POST',url:'/v1/media/tasks',headers:{authorization:'Bearer valid'},payload})).statusCode).toBe(400)
      expect(media.create).not.toHaveBeenCalled()
      await app.inject({method:'POST',url:'/v1/media/tasks',headers,payload:{...payload,quoteToken:'original'}})
      expect(media.create).toHaveBeenCalledWith('owner',expect.objectContaining({quoteToken:'original'}),'key-id',false)
    }finally{await app.close()}
  })
  test('only returns public quote fields',async()=>{
    const {app}=fixture()
    try {
      const r=await app.inject({method:'POST',url:'/v1/media/quote',headers,payload:{model:'gpt-image-2.5',prompt:'test'}})
      expect(r.statusCode).toBe(200);expect(r.body).not.toMatch(/secret|price|cost/i)
    }finally{await app.close()}
  })
  test('queries tasks within authenticated ownership and checks video kind',async()=>{
    const {app,media}=fixture()
    try {
      expect((await app.inject({url:'/v1/media/tasks/task-id',headers})).statusCode).toBe(200)
      expect(media.get).toHaveBeenCalledWith('owner','task-id')
      expect((await app.inject({url:'/v1/media/tasks/other',headers})).statusCode).toBe(404)
      expect((await app.inject({url:'/v1/videos/task-id',headers})).statusCode).toBe(404)
    }finally{await app.close()}
  })
  test('rejects mismatched models and unsupported pricing parameters',()=>{
    expect(()=>mediaApiInput({model:'gpt-image-2.5',prompt:'test'},'video')).toThrow('类型不匹配')
    expect(()=>mediaApiInput({model:'gpt-image-2.5',engine:'standard',prompt:'test'})).toThrow('引擎不匹配')
    expect(()=>mediaApiInput({model:'gpt-image-2.5',prompt:'test',quality:'high'})).toThrow('quality')
    expect(()=>mediaApiInput({model:'unknown',prompt:'test'})).toThrow('可用')
    expect(()=>mediaApiInput({model:'gpt-image-2.5',prompt:'test',size:'4K'})).toThrow('仅开放')
    expect(()=>mediaApiInput({model:'agnes-image-2.5-flash',prompt:'test'})).toThrow('可用')
    expect(()=>mediaApiInput({model:'gpt-image-2',prompt:'test'})).toThrow('可用')
  })
})
