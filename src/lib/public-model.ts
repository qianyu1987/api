import { StringDecoder } from 'node:string_decoder'

export const SOL_FALLBACK_UPSTREAM_MODELS = ['agnes-3.0-flash', 'agnes-2.5-flash'] as const
export const PUBLIC_FALLBACK_MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] as const

export function isPublicFallbackModel(model: string): boolean {
  return PUBLIC_FALLBACK_MODELS.includes(model as typeof PUBLIC_FALLBACK_MODELS[number])
}

export function isSolFallback(requestedModel: string, upstreamModel: string): boolean {
  return isPublicFallbackModel(requestedModel)
    && SOL_FALLBACK_UPSTREAM_MODELS.includes(upstreamModel as typeof SOL_FALLBACK_UPSTREAM_MODELS[number])
}

/** Rewrite protocol metadata only; model fields inside tool results are user data. */
export function rewritePublicModel(json: string, model: string): string {
  try {
    const payload = JSON.parse(json)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return json
    let changed = false
    for (const object of [payload, payload.response]) {
      if (object && typeof object === 'object' && typeof object.model === 'string' && object.model !== model) {
        object.model = model
        changed = true
      }
    }
    return changed ? JSON.stringify(payload) : json
  } catch { return json }
}

/** Incremental SSE framing, including split UTF-8, CRLF and multiline data. */
export class PublicModelSse {
  private readonly decoder = new StringDecoder('utf8')
  private pending = ''
  private event: Array<{ line: string; ending: string }> = []

  constructor(private readonly model: string) {}

  write(chunk: Buffer): string {
    return this.consume(this.decoder.write(chunk), false)
  }

  end(): string {
    return this.consume(this.decoder.end(), true)
  }

  private flushEvent(): string {
    const lines = this.event
    this.event = []
    const data = lines.filter(({ line }) => line === 'data' || line.startsWith('data:'))
    const original = data.map(({ line }) => line.slice(5).replace(/^ /, '')).join('\n')
    const rewritten = rewritePublicModel(original, this.model)
    if (original === rewritten) return lines.map(({ line, ending }) => line + ending).join('')
    let emitted = false
    return lines.map(({ line, ending }) => {
      if (line !== 'data' && !line.startsWith('data:')) return line + ending
      if (emitted) return ''
      emitted = true
      return `data: ${rewritten}${ending}`
    }).join('')
  }

  private consume(text: string, final: boolean): string {
    this.pending += text
    let output = ''
    let offset = 0
    const separator = /\r\n|\r|\n/g
    let match: RegExpExecArray | null
    while ((match = separator.exec(this.pending))) {
      if (!final && match[0] === '\r' && separator.lastIndex === this.pending.length) break
      const line = this.pending.slice(offset, match.index)
      this.event.push({ line, ending: match[0] })
      offset = separator.lastIndex
      if (!line) output += this.flushEvent()
    }
    this.pending = this.pending.slice(offset)
    if (final) {
      if (this.pending) this.event.push({ line: this.pending, ending: '' })
      this.pending = ''
      output += this.flushEvent()
    }
    return output
  }
}
