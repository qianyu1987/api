export type StreamFailure = 'client_disconnected' | 'upstream_stream_timeout' | 'upstream_stream_interrupted'

export function classifyStreamFailure(error: unknown, clientDisconnected: boolean): StreamFailure {
  if (clientDisconnected) return 'client_disconnected'
  const e = error as any
  const code = String(e?.code || e?.cause?.code || '')
  return /timeout/i.test(String(e?.name || '') + code) ? 'upstream_stream_timeout' : 'upstream_stream_interrupted'
}

/** Detect semantic failures and premature EOF as well as socket exceptions.
 * Only protocol markers are kept; user text and tool data are never retained. */
export class StreamDiagnostics {
  private pending = ''
  complete = false
  failed = false
  completeUsage = false
  consume(text: string): void {
    this.pending += text
    const lines = this.pending.split(/\r?\n/)
    this.pending = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const value = line.slice(5).trim()
      if (value === '[DONE]') { this.complete = true; continue }
      try {
        const data = JSON.parse(value)
        const usage = data.usage || data.response?.usage || data.data?.usage
        const input = usage?.prompt_tokens ?? usage?.input_tokens ?? usage?.inputTokens
        const output = usage?.completion_tokens ?? usage?.output_tokens ?? usage?.outputTokens
        if (Number.isFinite(input) && input >= 0 && Number.isFinite(output) && output >= 0) this.completeUsage = true
        if (['response.completed', 'response.incomplete'].includes(data.type)) this.complete = true
        if (data.type === 'response.failed' || data.type === 'error' || data.error) this.failed = true
      } catch { /* split/non-JSON protocol lines cannot prove completion */ }
    }
    if (this.pending.length > 2 * 1024 * 1024) this.pending = ''
  }
}
