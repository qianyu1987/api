export const MEDIA_MODELS = { image: 'agnes-image-2.5-flash', video: 'agnes-video-2.5-flash', proImage: 'gpt-image-2', enhancedImage: 'gpt-image-2.5' } as const
export type MediaEngine = 'standard' | 'pro' | 'enhanced'
export const mediaError = (message: string, statusCode = 400): never => { throw Object.assign(new Error(message), { statusCode }) }
export const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b
export function mediaPrice(cost: bigint, multiplierBps: number, feeBps: number, rebateBps: number) {
  if (cost <= 0n || ![multiplierBps, feeBps, rebateBps].every(Number.isInteger) || multiplierBps < 10000 || multiplierBps > 100000 || feeBps < 0 || rebateBps < 0 || feeBps + rebateBps >= 7000) mediaError('成本或费用配置无效，暂不可生成', 503)
  return ceilDiv(cost * BigInt(multiplierBps), BigInt(7000 - feeBps - rebateBps))
}
export function validateMedia(body: any) {
  const requestedEngine = body?.engine === 'pro' ? 'pro' : body?.engine === 'enhanced' ? 'enhanced' : body?.engine === 'standard' || body?.engine == null ? 'standard' : null
  const kind = body?.kind === 'image' || body?.model === MEDIA_MODELS.image || body?.model === MEDIA_MODELS.proImage || body?.model === MEDIA_MODELS.enhancedImage ? 'image' : body?.kind === 'video' || body?.model === MEDIA_MODELS.video ? 'video' : null
  if (!kind) return mediaError('请选择支持的图片或视频模型')
  if (requestedEngine === null || (kind === 'video' && requestedEngine !== 'standard')) mediaError('图片引擎选择无效')
  const model = kind === 'video' ? MEDIA_MODELS.video : requestedEngine === 'pro' ? MEDIA_MODELS.proImage : requestedEngine === 'enhanced' ? MEDIA_MODELS.enhancedImage : MEDIA_MODELS.image
  if (body.model && body.model !== model) mediaError('模型与生成类型不匹配')
  const prompt = String(body.prompt || '').trim()
  if (!prompt || prompt.length > 12000) mediaError('请输入 1–12000 字的提示词')
  const urls = (value: any, limit: number): string[] => {
    if (value == null) return []
    if (!Array.isArray(value) || value.length > limit) mediaError(`参考素材最多 ${limit} 个`)
    return value.map((v: unknown) => { if (typeof v !== 'string' || v.length > 2048) return mediaError('参考素材须为公开 HTTPS 地址'); let u: URL; try { u = new URL(v) } catch { return mediaError('参考素材地址无效') }; if (u.protocol !== 'https:' || u.username || u.password || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[|172\.(1[6-9]|2\d|3[01])\.)/i.test(u.hostname)) mediaError('请使用公开 HTTPS 素材地址'); return u.toString() })
  }
  const ratio = String(body.ratio || body.aspect_ratio || '16:9')
  if (!(kind === 'image' ? ['1:1','3:4','4:3','16:9','9:16','2:3','3:2','21:9'] : ['1:1','3:4','4:3','16:9','9:16','21:9']).includes(ratio)) mediaError('不支持此画幅比例')
  if (body.n !== undefined && body.n !== 1) mediaError('每次只生成一份作品')
  if (kind === 'image') {
    const size = String(body.size || '1K'); if (!['1K','2K','3K','4K'].includes(size)) mediaError('图片尺寸须为 1K、2K、3K 或 4K')
    const images = urls(body.images ?? body.extra_body?.image, 3)
    if (body.return_base64 || (body.extra_body?.response_format && body.extra_body.response_format !== 'url')) mediaError('创作接口当前仅支持 URL 输出')
    if (requestedEngine === 'pro' || requestedEngine === 'enhanced') {
      if (size !== '1K') mediaError('该图片规格当前仅开放 1K')
      if (images.length) mediaError('该图片规格当前仅支持文字生成图片，请移除参考图')
      const upstreamSize = ratio === '1:1' ? '1024x1024' : ['3:4','9:16','2:3'].includes(ratio) ? '1024x1536' : '1536x1024'
      return { kind, engine: requestedEngine as MediaEngine, model, size, units: 1, payload: { model, prompt, size: upstreamSize, quality: 'low', output_format: 'png', n: 1 } }
    }
    return { kind, engine: requestedEngine as MediaEngine, model, size, units: 1, payload: { model, prompt, size, ratio, extra_body: { response_format: 'url', ...(images.length ? { image: images } : {}) } } }
  }
  const size = String(body.size || '720P'); if (size !== '720P') mediaError('视频 Flash 仅支持 720P')
  const seconds = Number(body.seconds ?? 5); if (!Number.isInteger(seconds) || seconds < 4 || seconds > 12) mediaError('视频时长须为 4–12 秒')
  const mode = String(body.mode || 'text'); if (!['text','keyframe','reference'].includes(mode)) mediaError('视频模式无效')
  const images = urls(body.images, 5), audios = urls(body.audios, 3)
  const first = urls(body.first_frame ? [body.first_frame] : [], 1)[0], last = urls(body.last_frame ? [body.last_frame] : [], 1)[0]
  if (body.videos?.length) mediaError('视频 Flash 不支持视频参考')
  if (mode === 'text' && (images.length || audios.length || first || last)) mediaError('文生视频模式不能附带参考素材')
  if (mode === 'keyframe' && (!(first || last) || images.length || audios.length)) mediaError('首尾帧模式至少需要一张首帧或尾帧，不接受其他参考素材')
  if (mode === 'reference' && (!(images.length || audios.length) || first || last)) mediaError('参考模式需要图片或音频，不接受首尾帧字段')
  return { kind, engine: 'standard' as const, model: MEDIA_MODELS.video, size, units: seconds, payload: { model: MEDIA_MODELS.video, prompt, size, seconds: String(seconds), mode, aspect_ratio: ratio, n: 1, ...(first ? { first_frame: first } : {}), ...(last ? { last_frame: last } : {}), ...(images.length ? { images } : {}), ...(audios.length ? { audios } : {}) } }
}
export function mediaResultUrl(payload: any): string | null {
  const value = payload?.metadata?.url ?? payload?.data?.[0]?.url ?? payload?.video_url ?? payload?.url ?? payload?.output?.video_url ?? payload?.output?.url ?? payload?.data?.video_url
  if (typeof value !== 'string') return null
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : null } catch { return null }
}
