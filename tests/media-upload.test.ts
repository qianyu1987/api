import {describe,test,expect} from 'vitest'
import {mediaUploadType} from '../src/lib/media-upload.js'
describe('media uploads',()=>{
 test('recognizes image and audio signatures',()=>{
 expect(mediaUploadType(Buffer.from([137,80,78,71,13,10,26,10]))).toBe('image/png')
 expect(mediaUploadType(Buffer.from('RIFF1234WAVEdata'))).toBe('audio/wav')
 expect(mediaUploadType(Buffer.from('ID3audio'))).toBe('audio/mpeg')
 })
 test('rejects executable markup, empty and oversize files',()=>{
 for(const data of [Buffer.from('<svg onload="alert(1)">'),Buffer.alloc(0),Buffer.alloc(20*1024*1024+1)])expect(()=>mediaUploadType(data)).toThrow()
 })
})
