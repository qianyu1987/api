import { expect, test } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, rmdir } from 'node:fs/promises'
import { once } from 'node:events'
import { LayaShadow } from '../src/services/laya-shadow.js'

test('Unix transport recovers after socket loss without TCP fallback or queued retries', async () => {
  const directory = await mkdtemp('/tmp/laya-test-')
  const socketPath = `${directory}/c.sock`
  let received = 0
  const server = createServer(async (request, response) => {
    received++
    expect(request.url).toBe('/v1/classify')
    expect(request.headers.authorization).toBe('Bearer test-token')
    const parts = []
    for await (const part of request) parts.push(part)
    expect(JSON.parse(Buffer.concat(parts).toString())).toEqual({ text: 'synthetic example' })
    response.setHeader('Connection', 'close')
    response.end(JSON.stringify({ mode: 'shadow', answers: { task_type: { choice: 'text' } } }))
  })
  const shadow = new LayaShadow({ socketPath, url: 'http://127.0.0.1/v1/classify',
    token: 'test-token', adminUserId: 'admin' })
  const observe = () => shadow.observe('admin', 'admin', 'POST', '/responses', { input: 'synthetic example' })
  const waitCount = async (key: 'completed' | 'failed', value: number) => {
    const { vi } = await import('vitest')
    await vi.waitFor(() => expect(shadow.snapshot()[key]).toBe(value))
  }
  try {
    observe()
    await waitCount('failed', 1)
    server.listen(socketPath)
    await once(server, 'listening')
    observe()
    await waitCount('completed', 1)
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    observe()
    await waitCount('failed', 2)
    server.listen(socketPath)
    await once(server, 'listening')
    observe()
    await waitCount('completed', 2)
    expect(received).toBe(2)
  } finally {
    await shadow.close()
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    await rmdir(directory)
  }
})
