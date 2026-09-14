import {expect,test} from 'vitest'
import {welcomeGift} from '../src/services/media.js'
test('standard 1K consumes one of sixty images independently of video',()=>{
 expect(welcomeGift({model:'agnes-image-2.5-flash',size:'1K',units:1},{images_remaining:60,video_seconds_remaining:0})).toEqual({kind:'image',units:1})
})
test('premium engines and higher resolution never spend free standard images',()=>{
 for(const model of ['gpt-image-2','gpt-image-2.5'])expect(welcomeGift({model,size:'1K',units:1},{images_remaining:60})).toBeNull()
 expect(welcomeGift({model:'agnes-image-2.5-flash',size:'4K',units:1},{images_remaining:60})).toBeNull()
})
test('video requires enough seconds for the whole clip; no unexpected partial billing',()=>{
 expect(welcomeGift({model:'agnes-video-2.5-flash',size:'720P',units:10},{video_seconds_remaining:10})).toEqual({kind:'video',units:10})
 expect(welcomeGift({model:'agnes-video-2.5-flash',size:'720P',units:10},{video_seconds_remaining:9})).toBeNull()
})
test('legacy and exhausted accounts do not receive gifts at quote time',()=>{
 expect(welcomeGift({model:'agnes-image-2.5-flash',size:'1K',units:1},null)).toBeNull()
 expect(welcomeGift({model:'agnes-image-2.5-flash',size:'1K',units:1},{images_remaining:0})).toBeNull()
})
