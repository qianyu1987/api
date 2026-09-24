import type { AppConfig } from '../config.js'
import { Agent } from 'undici'

/** Observation only: never returns a routing decision or touches billing. */
export class LayaShadow {
  private active: AbortController | null = null
  private closed = false
  private counts = { submitted: 0, completed: 0, failed: 0, busy: 0 }
  private types: Record<string, number> = { text: 0, coding: 0, image: 0, video: 0, other: 0 }

  private readonly dispatcher?: Agent
  constructor(private readonly config: AppConfig['layaShadow'], private readonly send = fetch) {
    if (config?.socketPath) this.dispatcher = new Agent({
      connect: { socketPath: config.socketPath }, connections: 1, pipelining: 0,
    })
  }

  snapshot() {
    return { mode: 'shadow', enabled: Boolean(this.config), scope: 'configured_admin_only',
      replicaLocal: true, ...this.counts, types: { ...this.types } }
  }

  observe(role: string, userId: string, method: string, path: string, payload: unknown): void {
    try {
      if (!this.config || this.closed || role !== 'admin' || userId !== this.config.adminUserId) return
      const text = shadowText(method, path, payload)
      if (text === null) return
      if (this.active) { this.counts.busy++; return }
      const controller = new AbortController()
      this.active = controller
      this.counts.submitted++
      // No queue, retry, raw prompt logging, or dependency on the relay response.
      void this.classify(text, controller)
    } catch { /* Shadow failures must never enter the relay/billing error path. */ }
  }

  async close() {
    this.closed = true
    this.active?.abort()
    await this.dispatcher?.destroy()
  }

  private async classify(text: string, controller: AbortController): Promise<void> {
    const timer = setTimeout(() => controller.abort(), 750)
    timer.unref()
    try {
      const init: RequestInit & { dispatcher?: Agent } = {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config!.token}` },
        body: JSON.stringify({ text }),
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      }
      const response = await this.send(this.config!.url, init)
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('unavailable') }
      const reader = response.body.getReader()
      let raw = ''
      let bytes = 0
      const decoder = new TextDecoder()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > 16_384) { await reader.cancel(); throw new Error('oversize') }
          raw += decoder.decode(value, { stream: true })
        }
      } finally { reader.releaseLock() }
      const result = JSON.parse(raw + decoder.decode())
      const type = result?.answers?.task_type?.choice
      if (result?.mode !== 'shadow' || !Object.hasOwn(this.types, type)) throw new Error('invalid_result')
      this.types[type]++
      this.counts.completed++
    } catch { this.counts.failed++ }
    finally { clearTimeout(timer); this.active = null }
  }
}

/** Deliberately narrow first pilot: one user message, no history, tools or files. */
export function shadowText(method: string, path: string, payload: unknown): string | null {
  if (method !== 'POST' || !payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const body = payload as Record<string, unknown>
  const allowed = new Set(['model', 'stream', 'temperature', 'max_tokens', 'max_output_tokens',
    'top_p', 'messages', 'input'])
  if (Object.keys(body).some(key => !allowed.has(key))) return null
  let text: unknown
  if (path === '/responses' && !Object.hasOwn(body, 'messages')) text = body.input
  else if (path === '/chat/completions' && !Object.hasOwn(body, 'input')) {
    if (!Array.isArray(body.messages) || body.messages.length !== 1) return null
    const message = body.messages[0]
    if (!message || message.role !== 'user' || Object.keys(message).some(key => !['role', 'content'].includes(key))) return null
    text = message.content
  }
  return typeof text === 'string' && text.trim() && text.length <= 2000 ? text : null
}
