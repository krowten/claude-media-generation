// Generation API plumbing shared by generate-image, generate-svg and generate-video.
import type { Model } from './models'

import { fal } from '@fal-ai/client'
import { file, Image } from 'bun'

import { fail, exitOnError as exitOnLocalError } from './cli'
import { ENDPOINTS } from './models'

const { FAL_KEY } = process.env

export type ResultFile = { url: string; width?: number; height?: number; content_type?: string }
export type ModelOutput = { images?: ResultFile[]; image?: ResultFile; video?: ResultFile }

function configure(): void {
  if (!FAL_KEY)
    fail(
      'FAL_KEY is not set. Create a key at https://fal.ai/dashboard/keys and export it in your shell ' +
        '(export FAL_KEY=...) — never paste the key into the chat.',
    )
  fal.config({ credentials: FAL_KEY })
}

// Covers a busy queue plus the longest render. The SDK's own `timeout` would cancel the job on
// fal and lose a result that may still arrive, so this limit only stops waiting.
const WAIT_TIMEOUT_MS = 20 * 60 * 1000
const POLL_INTERVAL_MS = 2000

function resumeCommand(model: Model, requestId: string): string {
  return `bun ${process.argv[1]} resume --model ${model} --request-id ${requestId} --output <path>`
}

// The ID goes into a command Claude is invited to run, so only plain ID characters get through.
function checkedRequestId(requestId: string): string {
  if (!/^[\w-]{1,128}$/.test(requestId))
    fail(`The API returned an unexpected request ID: ${JSON.stringify(requestId).slice(0, 80)}`)
  return requestId
}

// One line per status change, so a long wait visibly makes progress.
function progress() {
  let last = ''
  return ({ status }: { status: string }) => {
    const line = status === 'IN_QUEUE' ? 'Waiting in the queue…' : status === 'IN_PROGRESS' ? 'Generating…' : ''
    if (line && line !== last) console.error(line)
    last = line
  }
}

async function waitLimited<T>(work: Promise<T>, model: Model, requestId: () => string | undefined): Promise<T> {
  const timer = setTimeout(() => {
    const id = requestId()
    fail(
      `No result after ${WAIT_TIMEOUT_MS / 60000} minutes; the job may still finish.` +
        (id ? ` Fetch it later instead of regenerating:\n  ${resumeCommand(model, id)}` : ''),
    )
  }, WAIT_TIMEOUT_MS)
  try {
    return await work
  } finally {
    clearTimeout(timer)
  }
}

// The request ID is printed the moment the API accepts the job, so a paid result survives a
// CDN error, a crash or an interrupted command: `resume` fetches it without generating again.
export async function runModel(model: Model, input: Record<string, unknown>): Promise<ModelOutput> {
  configure()
  let requestId: string | undefined
  const result = await waitLimited(
    fal.subscribe(ENDPOINTS[model], {
      input,
      pollInterval: POLL_INTERVAL_MS,
      onQueueUpdate: progress(),
      onEnqueue: id => {
        requestId = checkedRequestId(id)
        console.error(
          `Request ${requestId} accepted (${model}). If this run fails after generation, ` +
            `fetch the paid result instead of regenerating:\n  ${resumeCommand(model, requestId)}`,
        )
      },
    }),
    model,
    () => requestId,
  )
  return result.data as ModelOutput
}

export async function resumeRequest(model: Model, requestId: string): Promise<ModelOutput> {
  configure()
  checkedRequestId(requestId)
  await waitLimited(
    fal.queue.subscribeToStatus(ENDPOINTS[model], {
      requestId,
      pollInterval: POLL_INTERVAL_MS,
      onQueueUpdate: progress(),
    }),
    model,
    () => requestId,
  )
  return (await fal.queue.result(ENDPOINTS[model], { requestId })).data as ModelOutput
}

export function firstFile(data: ModelOutput | undefined): ResultFile | undefined {
  return data?.images?.[0] ?? data?.image ?? data?.video
}

// A stalled CDN would otherwise hang the command, and with it Claude's turn, indefinitely.
// Five minutes is far longer than any image or a 15-second clip takes.
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000

export async function download(url: string): Promise<Uint8Array> {
  // The timeout can also fire while the body streams in, so both steps share one handler.
  const failed = (error: unknown) =>
    fail(
      `Failed to download ${url}: ${error instanceof Error ? error.message : error}. Retry with the printed resume command.`,
    )
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) }).catch(failed)
  if (!res.ok)
    fail(
      `Failed to download ${url}: ${res.status} ${res.statusText}. The URL stays valid for a while — retry the download, don't regenerate.`,
    )
  return res.bytes().catch(failed)
}

// Reads the real format from the bytes (extensions lie) and fails before any paid call.
// Formats the endpoints may not accept are re-encoded as PNG.
export async function localImage(path: string): Promise<{ dataUri: string; width: number; height: number }> {
  const source = file(path)
  if (!(await source.exists())) fail(`Source file not found: ${path}`)
  const bytes = await source.bytes()
  const { width, height, format } = await new Image(bytes).metadata().catch(() => fail(`Not a readable image: ${path}`))
  if (format === 'jpeg' || format === 'png' || format === 'webp')
    return { dataUri: `data:image/${format};base64,${Buffer.from(bytes).toString('base64')}`, width, height }
  const png = await new Image(bytes)
    .png()
    .bytes()
    .catch(() => fail(`${path} is ${format}, which this machine can't decode. Convert it to PNG or JPEG first.`))
  return { dataUri: `data:image/png;base64,${Buffer.from(png).toString('base64')}`, width, height }
}

// Adds the API's own validation details (4xx reply bodies) to the generic handler.
export function exitOnError(error: unknown): never {
  const body = (error as { body?: { detail?: unknown } })?.body
  // Capped: the body is network text that lands in Claude's context.
  if (body) fail(`The generation API rejected the request: ${JSON.stringify(body.detail ?? body).slice(0, 500)}`)
  exitOnLocalError(error)
}
