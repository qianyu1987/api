import { mediaError } from './media.js'
export function mediaUploadType(data: Buffer): string {
  if (!Buffer.isBuffer(data) || !data.length || data.length > 20 * 1024 * 1024) return mediaError('文件为空或超过 20 MB')
  const ascii = (a:number,b:number) => data.toString('ascii',a,b)
  if(data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png'
  if(data[0]===255&&data[1]===216&&data[2]===255) return 'image/jpeg'
  if(ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP') return 'image/webp'
  if(ascii(0,4)==='RIFF'&&ascii(8,12)==='WAVE') return 'audio/wav'
  if(ascii(0,3)==='ID3'||(data[0]===255&&(data[1]&0xe0)===0xe0)) return 'audio/mpeg'
  return mediaError('不支持此文件，请使用 PNG、JPG、WebP 图片或 MP3、WAV 音频')
}
