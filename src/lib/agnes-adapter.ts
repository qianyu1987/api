type AnyRecord = Record<string, any>

const text = (value: any) => typeof value === 'string' ? value : ''

/** Normalize text content emitted by different OpenAI-compatible gateways. */
function outputText(value: any): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((part: any) => {
    if (typeof part === 'string') return part
    if (part?.type === 'text' || part?.type === 'output_text' || part?.type === 'input_text') return text(part.text)
    return ''
  }).join('')
}

function contentToText(content: any): any {
  if (typeof content === 'string' || content == null) return content
  if (!Array.isArray(content)) return content
  const parts = content.map((part: any) => {
    if (part?.type === 'input_text' || part?.type === 'text') return text(part.text)
    return part?.type === 'input_image' || part?.type === 'image_url' ? part : null
  }).filter(Boolean)
  return parts.every((part: any) => typeof part === 'string') ? parts.join('') : parts
}

export function isAgnesResponsesAdapter(baseUrl: string, path: string, enabled = true): boolean {
  try { return enabled && new URL(baseUrl).origin === 'https://apihub.agnes-ai.com' && path.split('?')[0] === '/responses' } catch { return false }
}

export function responsesToChat(input: AnyRecord): AnyRecord {
  const out: AnyRecord = { ...input }
  delete out.instructions
  delete out.input
  const messages: AnyRecord[] = []
  const instructions = input.instructions
  if (instructions) messages.push({ role: 'system', content: contentToText(instructions) })
  const items = Array.isArray(input.input) ? input.input : [{ role: 'user', content: input.input ?? '' }]
  for (const item of items) {
    if (typeof item === 'string') { messages.push({ role: 'user', content: item }); continue }
    if (!item || typeof item !== 'object') continue
    const role = item.role || (item.type === 'message' ? 'user' : null)
    if (role) { messages.push({ role, content: contentToText(item.content) }); continue }
    if (item.type === 'function_call_output') { messages.push({ role: 'tool', tool_call_id: item.call_id, content: text(item.output) }); continue }
    if (item.type === 'function_call') {
      messages.push({ role: 'assistant', tool_calls: [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments || '{}' } }] })
    }
  }
  out.messages = messages
  if (Array.isArray(input.tools)) out.tools = input.tools.map((tool: any) => {
    const fn = tool?.function || tool
    return { type: 'function', function: { name: fn?.name, description: fn?.description, parameters: fn?.parameters || {} }, ...(fn?.strict != null ? { strict: fn.strict } : {}) }
  })
  if (input.tool_choice && typeof input.tool_choice === 'object' && input.tool_choice.type === 'function') {
    out.tool_choice = { type: 'function', function: { name: input.tool_choice.name || input.tool_choice.function?.name } }
  }
  if (input.max_output_tokens != null && out.max_tokens == null) out.max_tokens = input.max_output_tokens
  delete out.max_output_tokens
  delete out.stream_options
  if (typeof out.stream !== 'boolean') delete out.stream
  return out
}

export function chatToResponses(input: AnyRecord, requestedModel: string): AnyRecord {
  // Agnes may return a native Responses envelope from its compatibility route.
  // Keep its output items instead of dropping them while looking for choices.
  if (input?.object === 'response' && Array.isArray(input.output)) {
    const native: AnyRecord = { ...input, model: requestedModel }
    if (!native.id) native.id = `resp_${Date.now().toString(36)}`
    if (!native.created_at) native.created_at = Math.floor(Date.now() / 1000)
    if (native.output.length === 0) {
      const fallbackText = outputText(native.output_text) || outputText(native.text)
      native.output = [{ id: `${native.id}_msg`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: fallbackText, annotations: [] }] }]
    }
    return native
  }
  const id = String(input.id || `resp_${Date.now().toString(36)}`)
  const output: AnyRecord[] = []
  const choice = Array.isArray(input.choices) ? input.choices[0] : null
  const message = choice?.message || {}
  const content = outputText(message.content) || outputText(choice?.text) || outputText(message.reasoning_content) || text(message.refusal) || outputText(input.output_text)
  // Codex expects at least one output item for a completed Responses result.
  if (content || !(message.tool_calls?.length)) output.push({ id: `${id}_msg`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: content, annotations: [] }] })
  for (const call of message.tool_calls || []) output.push({ id: call.id || `${id}_call`, type: 'function_call', status: 'completed', call_id: call.id, name: call.function?.name, arguments: call.function?.arguments || '{}' })
  const usage = input.usage ? { input_tokens: input.usage.prompt_tokens || 0, output_tokens: input.usage.completion_tokens || 0, total_tokens: input.usage.total_tokens || 0 } : undefined
  return { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model: requestedModel, status: 'completed', output, ...(usage ? { usage } : {}) }
}

export class AgnesResponsesSse {
  private buffer = ''
  private responseId = `resp_${Date.now().toString(36)}`
  private started = false
  private completed = false
  private textOutput = ''
  private toolItems = new Map<number, { id: string; callId: string; name: string }>()
  constructor(private readonly model: string) {}
  write(chunk: Buffer | string): string { this.buffer += Buffer.from(chunk).toString('utf8'); return this.flush(false) }
  end(): string {
    const out = this.flush(true)
    // A few gateways close the stream without emitting [DONE] or a finish
    // reason. Complete the Responses state machine on EOF so clients never
    // receive an in-progress response with no output item.
    if (this.started && !this.completed) {
      this.completed = true
      return out + this.completedEvent()
    }
    return out
  }
  private flush(final: boolean): string {
    const parts = this.buffer.split(/\r?\n\r?\n/); if (!final) this.buffer = parts.pop() || ''
    else this.buffer = ''
    let out = ''
    if (!this.started && parts.length) {
      this.started = true
      out += `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: this.responseId, object: 'response', model: this.model, status: 'in_progress', output: [] } })}\n\n`
    }
    for (const part of parts) {
      const line = part.split(/\r?\n/).find(v => v.startsWith('data:'))
      if (!line) continue
      const raw = line.slice(5).trim();
      if (!raw) continue
      if (raw === '[DONE]') {
        if (!this.completed) { this.completed = true; out += this.completedEvent() }
        continue
      }
      let data: AnyRecord; try { data = JSON.parse(raw) } catch { continue }
      const delta = data.choices?.[0]?.delta?.content
      if (delta) {
        this.textOutput += delta
        out += `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', response_id: this.responseId, item_id: `${this.responseId}_msg`, output_index: 0, content_index: 0, delta })}\n\n`
      }
      for (const call of data.choices?.[0]?.delta?.tool_calls || []) {
        const index = Number(call.index || 0)
        let item = this.toolItems.get(index)
        if (!item) {
          item = { id: call.id || `${this.responseId}_call_${index}`, callId: call.id || `${this.responseId}_call_${index}`, name: call.function?.name || '' }
          this.toolItems.set(index, item)
          out += `event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: index, item: { id: item.id, type: 'function_call', call_id: item.callId, name: item.name, arguments: '' } })}\n\n`
        }
        const args = call.function?.arguments
        if (args) out += `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: index, delta: args })}\n\n`
      }
      if (data.choices?.[0]?.finish_reason && !this.completed) { this.completed = true; out += this.completedEvent() }
    }
    return out
  }

  private completedEvent(): string {
    const output: AnyRecord[] = []
    if (this.textOutput || this.toolItems.size === 0) output.push({ id: `${this.responseId}_msg`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: this.textOutput, annotations: [] }] })
    for (const item of this.toolItems.values()) output.push({ id: item.id, type: 'function_call', status: 'completed', call_id: item.callId, name: item.name, arguments: '' })
    return `event: response.output_text.done\ndata: ${JSON.stringify({ type: 'response.output_text.done', response_id: this.responseId, item_id: `${this.responseId}_msg`, output_index: 0, content_index: 0, text: this.textOutput })}\n\n` +
      `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: this.responseId, object: 'response', model: this.model, status: 'completed', output } })}\n\n`
  }
}
