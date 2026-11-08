// Preloaded into the generate-* scripts by the tests: replaces the fal.ai SDK and fetch so no
// request leaves the machine. Every submission is appended to MOCK_FAL_LOG as one JSON line.
import { mock } from 'bun:test'
import { appendFileSync } from 'node:fs'
import { file, Image } from 'bun'

const { MOCK_FAL_LOG = '/dev/null', MOCK_FAL_MODE = '', MOCK_FAL_FIXTURE = '' } = process.env

// Data URIs are logged as their decoded dimensions so tests can assert what was actually sent.
async function describe(value: unknown): Promise<unknown> {
  if (typeof value === 'string' && value.startsWith('data:')) {
    const bytes = Buffer.from(value.slice(value.indexOf(',') + 1), 'base64')
    const { width, height, format } = await new Image(bytes).metadata()
    return { dataUri: true, width, height, format, bytes: bytes.byteLength }
  }
  if (Array.isArray(value)) return Promise.all(value.map(describe))
  return value
}

const output = (endpoint: string) => {
  const url = 'https://mock.invalid/result'
  if (endpoint.includes('background/remove') && MOCK_FAL_MODE === 'empty-cutout') return {}
  return { images: [{ url }], image: { url }, video: { url } }
}

mock.module('@fal-ai/client', () => ({
  fal: {
    config() {},
    async subscribe(endpoint: string, opts: { input: Record<string, unknown>; onEnqueue?: (id: string) => void }) {
      const input = Object.fromEntries(
        await Promise.all(Object.entries(opts.input).map(async ([k, v]) => [k, await describe(v)])),
      )
      appendFileSync(MOCK_FAL_LOG, `${JSON.stringify({ endpoint, input })}\n`)
      opts.onEnqueue?.('mock-request-id')
      return { data: output(endpoint), requestId: 'mock-request-id' }
    },
    queue: {
      async subscribeToStatus() {},
      async result(endpoint: string) {
        return { data: output(endpoint), requestId: 'mock-request-id' }
      },
    },
  },
}))

globalThis.fetch = (async () => {
  if (MOCK_FAL_MODE === 'download-error') return new Response('unavailable', { status: 503 })
  if (MOCK_FAL_MODE === 'html')
    return new Response('<html>not a media file</html>', { headers: { 'Content-Type': 'text/html' } })
  return new Response(await file(MOCK_FAL_FIXTURE).bytes())
}) as unknown as typeof fetch
