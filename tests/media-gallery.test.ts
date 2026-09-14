import {describe,test,expect} from 'vitest'
import {buildApp} from '../src/server.js'
import {loadConfig} from '../src/config.js'

describe('media gallery privacy',()=>{
  test('gallery response exposes only public presentation fields',async()=>{
    const config=loadConfig()
    const relay=await buildApp({...config,env:'test'})
    relay.db.query=async(sql:string)=>sql.includes("gallery_status='published'")?[{id:'11111111-1111-1111-1111-111111111111',kind:'image',gallery_title:'晨光山湖',gallery_featured:true,finished_at:new Date('2026-09-11T00:00:00Z'),user_id:'secret-user',model:'secret-model',request_payload:{prompt:'secret'}}] as any:[] as any
    const response=await relay.app.inject({method:'GET',url:'/api/gallery'})
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({items:[{id:'11111111-1111-1111-1111-111111111111',kind:'image',title:'晨光山湖',featured:true,createdAt:'2026-09-11T00:00:00.000Z',assetUrl:'/api/gallery/11111111-1111-1111-1111-111111111111/asset'}]})
    expect(response.body).not.toMatch(/secret|model|prompt|user/i)
    await relay.app.close()
  })

  test('invalid gallery filter is rejected',async()=>{
    const config=loadConfig()
    const relay=await buildApp({...config,env:'test'})
    const response=await relay.app.inject({method:'GET',url:'/api/gallery?kind=audio'})
    expect(response.statusCode).toBe(400)
    await relay.app.close()
  })
})
