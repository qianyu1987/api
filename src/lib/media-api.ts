import type { FastifyInstance } from 'fastify'
import type { AuthService } from '../services/auth.js'
import type { MediaService } from '../services/media.js'
import { MEDIA_MODELS, mediaError, validateMedia } from './media.js'

// Public API model names select the same priced channel as the creative studio.
// No token-model routing or second billing reservation is involved.
export function mediaApiInput(body: any, kind?: 'image' | 'video') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) mediaError('需要 JSON 请求体')
  // Public API keys expose one image model and one video model. Older image
  // model names remain supported internally for historical task processing.
  const engines: Record<string, string> = {
    [MEDIA_MODELS.enhancedImage]: 'enhanced', [MEDIA_MODELS.video]: 'standard',
  }
  if (!Object.hasOwn(engines, body.model)) mediaError('请选择模型列表中可用的图片或视频模型')
  const expectedKind = body.model === MEDIA_MODELS.video ? 'video' : 'image'
  if ((kind && kind !== expectedKind) || (body.kind && body.kind !== expectedKind)) mediaError('模型与接口类型不匹配')
  if (body.engine && body.engine !== engines[body.model]) mediaError('模型与图片引擎不匹配')
  const allowed = new Set(['model','kind','engine','prompt','size','ratio','aspect_ratio','n','images','audios','videos','first_frame','last_frame','seconds','mode','extra_body','idempotencyKey','quoteToken'])
  for (const field of Object.keys(body)) if (!allowed.has(field)) mediaError(`不支持参数 ${field}，请使用异步媒体 API 文档中的参数`)
  const input = {...body, kind: expectedKind, engine: engines[body.model]}
  validateMedia(input)
  return input
}

export function registerMediaApi(app: FastifyInstance, auth: Pick<AuthService, 'authenticateApiKey'>, media: Pick<MediaService, 'create' | 'get' | 'list' | 'quote'>) {
  const identity = async (request: any) => {
    const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization || '')
    if (!match) mediaError('需要 Bearer API Key', 401)
    try { return await auth.authenticateApiKey(match![1]) } catch { return mediaError('API Key 无效或已撤销', 401) }
  }
  const submit = (kind?: 'image' | 'video') => async (request: any, reply: any) => {
    const {user, key} = await identity(request)
    const input = mediaApiInput(request.body, kind)
    const nonce = request.headers['idempotency-key'] ?? input.idempotencyKey
    if (request.headers['idempotency-key'] && input.idempotencyKey && request.headers['idempotency-key'] !== input.idempotencyKey) mediaError('请求头与请求体的幂等编号不一致')
    if (typeof nonce !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(nonce)) mediaError('请提供 16–100 位 Idempotency-Key；重试必须沿用原编号')
    const task = await media.create(user.id, {...input, idempotencyKey: nonce}, key.id, input.quoteToken === undefined)
    const location = '/v1/media/tasks/' + encodeURIComponent(task.id)
    reply.header('Location', location).header('Cache-Control', 'no-store')
    if (!['completed','failed'].includes(task.status)) reply.code(202).header('Retry-After', '5')
    return {...task, statusUrl: location}
  }
  // Intentionally asynchronous, including images: the original task survives
  // client disconnects and is retrieved with the same authenticated key.
  app.post('/v1/media/tasks', submit())
  app.post('/v1/images/generations', submit('image'))
  app.post('/v1/videos', submit('video'))
  app.post('/v1/media/quote', async (request) => {
    const {user} = await identity(request)
    const q = await media.quote(user.id, mediaApiInput(request.body))
    return {chargeMicros:q.chargeMicros, quoteToken:q.quoteToken, walletOnly:q.walletOnly, gift:q.gift}
  })
  app.get('/v1/media/tasks', async request => media.list((await identity(request)).user.id))
  app.get<{Params:{id:string}}>('/v1/media/tasks/:id', async request => media.get((await identity(request)).user.id, request.params.id))
  app.get<{Params:{id:string}}>('/v1/videos/:id', async request => {
    const task = await media.get((await identity(request)).user.id, request.params.id)
    if (task.kind !== 'video') mediaError('视频任务不存在', 404)
    return task
  })
}
