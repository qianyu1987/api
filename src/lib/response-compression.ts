import { PassThrough, pipeline, type Readable } from 'node:stream'
import { promisify } from 'node:util'
import { brotliDecompress, gunzip, inflate, createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'

const decompressors = { gzip: promisify(gunzip), deflate: promisify(inflate), br: promisify(brotliDecompress) }
const streams = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress }
type Encoding = keyof typeof decompressors

function encodings(header: unknown): Encoding[] {
  const values = String(header || '').toLowerCase().split(',').map(value => value.trim()).filter(value => value && value !== 'identity')
  if (values.some(value => !Object.hasOwn(decompressors, value))) throw new Error('Unsupported upstream content encoding')
  return (values as Encoding[]).reverse()
}

/** undici.request returns compressed bytes; decode before inspecting protocol metadata. */
export async function decodeResponseBuffer(body: Buffer, encoding: unknown): Promise<Buffer> {
  for (const value of encodings(encoding)) body = await decompressors[value](body, { maxOutputLength: 64 * 1024 * 1024 })
  return body
}

export function decodeResponseStream(body: Readable, encoding: unknown): Readable {
  const decoders = encodings(encoding).map(value => streams[value]())
  if (!decoders.length) return body
  const output = new PassThrough()
  // The reader observes failures on output. pipeline also destroys the source
  // and every decoder on cancellation/error while preserving backpressure.
  pipeline([body, ...decoders, output], () => {})
  return output
}
