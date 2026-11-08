#!/usr/bin/env bun
// Video generation: MiniMax H3 Max, Kling 4 or Seedance 2.5 (generate/animate/transition/loop,
// keyframes on Kling) and Veo 3.1 (extend). Argv in, a verified .mp4 file on disk out.
import type { Model } from '../../../lib/models'

import { parseArgs } from 'node:util'
import { write } from 'bun'

import { fail, intArg, oneOf } from '../../../lib/cli'
import { download, exitOnError, firstFile, localImage, resumeRequest, runModel } from '../../../lib/provider'

const MODELS = ['h3-max', 'kling-4', 'seedance-2.5'] as const
// `resume` only accepts this script's own models, so a mistyped key fails with a clear message.
const RESUME_MODELS = [
  'h3-max-text-to-video',
  'h3-max-image-to-video',
  'kling-4-text-to-video',
  'kling-4-image-to-video',
  'seedance-2.5-text-to-video',
  'seedance-2.5-image-to-video',
  'veo-extend',
] as const satisfies readonly Model[]
type VideoModel = (typeof MODELS)[number]

// What differs between the two models' APIs; everything else is shared.
const SPECS: Record<
  VideoModel,
  {
    textToVideo: Model
    imageToVideo: Model
    startKey: string
    duration: [min: number, max: number]
    resolutions: readonly string[]
    defaultResolution: string
    // Field for frames between the first and the last, if the model takes them.
    middleKey?: string
    maxMiddle?: number
    aspectRatios: readonly string[]
    extra: Record<string, unknown>
    frameLimits: boolean
  }
> = {
  'h3-max': {
    textToVideo: 'h3-max-text-to-video',
    imageToVideo: 'h3-max-image-to-video',
    startKey: 'image_url',
    duration: [1, 15],
    resolutions: ['480p', '768p', '1080p'],
    defaultResolution: '1080p',
    aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    // Required by the API; "balanced" lets the model expand a short prompt into a timed shot plan.
    extra: { prompt_expansion_mode: 'balanced' },
    frameLimits: false,
  },
  'kling-4': {
    textToVideo: 'kling-4-text-to-video',
    imageToVideo: 'kling-4-image-to-video',
    startKey: 'start_image_url',
    duration: [3, 30],
    resolutions: ['720p', '1080p'],
    defaultResolution: '1080p',
    middleKey: 'middle_image_urls',
    maxMiddle: 8,
    aspectRatios: ['16:9', '9:16', '1:1', '21:9'],
    extra: {},
    frameLimits: true,
  },
  'seedance-2.5': {
    textToVideo: 'seedance-2.5-text-to-video',
    imageToVideo: 'seedance-2.5-image-to-video',
    startKey: 'image_url',
    duration: [4, 30],
    resolutions: ['480p', '720p', '1080p'],
    // 1080p costs about $1.16/s, so the default is the 720p tier.
    defaultResolution: '720p',
    aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    // It adds a generated soundtrack unless told not to; web backgrounds play muted anyway.
    extra: { generate_audio: false },
    frameLimits: false,
  },
}

// Flags shared by the four generation commands.
const VIDEO_OPTIONS = {
  prompt: { type: 'string' },
  output: { type: 'string' },
  model: { type: 'string', default: 'h3-max' },
  duration: { type: 'string', default: '5' },
  resolution: { type: 'string' },
} as const

function videoSettings(values: { model: string; duration: string; resolution?: string }) {
  const model = oneOf('model', values.model, MODELS)
  const spec = SPECS[model]
  const resolution = oneOf('resolution', values.resolution ?? spec.defaultResolution, spec.resolutions)
  const duration = intArg('duration', values.duration, ...spec.duration)!
  return {
    model,
    spec,
    input: {
      // Seedance takes the duration as a string ("5"), the others as a number.
      duration: model === 'seedance-2.5' ? String(duration) : duration,
      // H3 spells resolutions in capitals (768P), Kling in lower case.
      resolution: model === 'h3-max' ? resolution.toUpperCase() : resolution,
      ...spec.extra,
    },
  }
}

// Accepts a local path or an already-public URL; local files are inlined as data URIs since
// the API needs a URL it can fetch, and we don't run a public file host here. Kling's input
// limits are checked before the paid call.
async function resolveFrameUrl(pathOrUrl: string, model: VideoModel): Promise<string> {
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl
  const { dataUri, width, height } = await localImage(pathOrUrl)
  if (!SPECS[model].frameLimits) return dataUri
  if (Math.min(width, height) < 300) fail(`Kling needs frames at least 300x300 px, ${pathOrUrl} is ${width}x${height}`)
  const aspect = width / height
  if (aspect < 0.4 || aspect > 2.5)
    fail(`Kling accepts frames with an aspect ratio between 2:5 and 5:2, ${pathOrUrl} is ${width}x${height}`)
  return dataUri
}

async function saveVideo(sourceUrl: string, outputPath: string, action: string): Promise<void> {
  const bytes = await download(sourceUrl)
  // Every MP4/MOV starts with an `ftyp` box at byte 4; an HTML error page doesn't.
  if (new TextDecoder().decode(bytes.subarray(4, 8)) !== 'ftyp') fail(`The file at ${sourceUrl} is not an MP4 video`)
  await write(outputPath, bytes)
  console.log(`${action} ${outputPath} (${(bytes.byteLength / (1024 * 1024)).toFixed(1)}MB)`)
  console.log(`Result URL (temporary, usable as extend --source): ${sourceUrl}`)
}

async function generateAndSave(model: Model, input: Record<string, unknown>, outputPath: string, action: string) {
  const video = firstFile(await runModel(model, input))
  if (!video?.url) fail('No video was returned. Try rephrasing the prompt.')
  await saveVideo(video.url, outputPath, action)
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)

  if (command === 'generate') {
    // Text-to-video — no starting image, pure prompt.
    const { values } = parseArgs({
      args: rest,
      options: { ...VIDEO_OPTIONS, 'aspect-ratio': { type: 'string', default: '16:9' } },
    })
    if (!values.prompt || !values.output) fail('generate requires --prompt and --output')

    const { spec, input } = videoSettings(values)
    const aspectRatio = oneOf('aspect-ratio', values['aspect-ratio'], spec.aspectRatios)
    await generateAndSave(
      spec.textToVideo,
      { prompt: values.prompt, aspect_ratio: aspectRatio, ...input },
      values.output,
      'Video saved to',
    )
    return
  }

  if (command === 'animate') {
    // Image-to-video — a single start frame, camera/scene motion driven by the prompt.
    const { values } = parseArgs({
      args: rest,
      options: { ...VIDEO_OPTIONS, source: { type: 'string' } },
    })
    if (!values.prompt || !values.source || !values.output) fail('animate requires --prompt, --source and --output')

    const { model, spec, input } = videoSettings(values)
    const start = await resolveFrameUrl(values.source, model)
    await generateAndSave(
      spec.imageToVideo,
      { prompt: values.prompt, [spec.startKey]: start, ...input },
      values.output,
      'Video saved to',
    )
    return
  }

  if (command === 'transition') {
    // Start frame -> end frame. Same call also powers `loop` below (start === end).
    const { values } = parseArgs({
      args: rest,
      options: { ...VIDEO_OPTIONS, from: { type: 'string' }, to: { type: 'string' } },
    })
    if (!values.prompt || !values.from || !values.to || !values.output)
      fail('transition requires --prompt, --from, --to and --output')

    const { model, spec, input } = videoSettings(values)
    const start = await resolveFrameUrl(values.from, model)
    const end = await resolveFrameUrl(values.to, model)
    await generateAndSave(
      spec.imageToVideo,
      { prompt: values.prompt, [spec.startKey]: start, end_image_url: end, ...input },
      values.output,
      'Video saved to',
    )
    return
  }

  if (command === 'loop') {
    // Seamless loop — one frame used as both start and end, so playback can repeat with no cut.
    const { values } = parseArgs({
      args: rest,
      options: { ...VIDEO_OPTIONS, source: { type: 'string' } },
    })
    if (!values.prompt || !values.source || !values.output) fail('loop requires --prompt, --source and --output')

    const { model, spec, input } = videoSettings(values)
    const frame = await resolveFrameUrl(values.source, model)
    await generateAndSave(
      spec.imageToVideo,
      { prompt: values.prompt, [spec.startKey]: frame, end_image_url: frame, ...input },
      values.output,
      'Looping video saved to',
    )
    return
  }

  if (command === 'keyframes') {
    // Three or more stills the clip must pass through in order: first, middle ones, last.
    const { values } = parseArgs({
      args: rest,
      options: {
        ...VIDEO_OPTIONS,
        model: { type: 'string', default: 'kling-4' },
        frame: { type: 'string', multiple: true },
      },
    })
    const frames = values.frame ?? []
    if (!values.prompt || !values.output || frames.length < 3)
      fail('keyframes requires --prompt, --output and at least three --frame flags (for two, use transition)')

    const { model, spec, input } = videoSettings(values)
    if (!spec.middleKey) fail(`--model ${model} takes only a first and a last frame; use --model kling-4 for keyframes`)
    if (frames.length - 2 > spec.maxMiddle!)
      fail(`${model} takes at most ${spec.maxMiddle! + 2} keyframes, got ${frames.length}`)
    const urls = []
    for (const frame of frames) urls.push(await resolveFrameUrl(frame, model))
    await generateAndSave(
      spec.imageToVideo,
      {
        prompt: values.prompt,
        [spec.startKey]: urls[0],
        [spec.middleKey]: urls.slice(1, -1),
        end_image_url: urls.at(-1),
        ...input,
      },
      values.output,
      'Video saved to',
    )
    return
  }

  if (command === 'extend') {
    // Continue an existing clip with Veo 3.1.
    const { values } = parseArgs({
      args: rest,
      options: {
        prompt: { type: 'string' },
        source: { type: 'string' },
        output: { type: 'string' },
        duration: { type: 'string', default: '7' },
        resolution: { type: 'string', default: '720p' },
        audio: { type: 'boolean', default: false },
      },
    })
    if (!values.prompt || !values.source || !values.output) fail('extend requires --prompt, --source and --output')
    if (!/^https?:\/\//.test(values.source))
      fail(
        'extend requires --source to be a public https URL (Veo re-fetches it via Vertex AI, a data URI will not work)',
      )

    // Veo 3.1 extend only offers a 7s continuation at 720p. A bare number is accepted for
    // consistency with the plain-number --duration on the other commands.
    if (values.duration !== '7' && values.duration !== '7s') fail('Veo 3.1 extend only supports --duration 7')
    if (values.resolution !== '720p') fail('Veo 3.1 extend only supports --resolution 720p')

    const input = {
      prompt: values.prompt,
      video_url: values.source,
      duration: '7s',
      resolution: '720p',
      generate_audio: values.audio,
    }
    await generateAndSave('veo-extend', input, values.output, 'Extended video saved to')
    return
  }

  if (command === 'resume') {
    const { values } = parseArgs({
      args: rest,
      options: { model: { type: 'string' }, 'request-id': { type: 'string' }, output: { type: 'string' } },
    })
    if (!values.model || !values['request-id'] || !values.output)
      fail('resume requires --model, --request-id and --output (all printed when the request was accepted)')
    const video = firstFile(await resumeRequest(oneOf('model', values.model, RESUME_MODELS), values['request-id']))
    if (!video?.url) fail(`Request ${values['request-id']} finished without a video`)
    await saveVideo(video.url, values.output, 'Video saved to')
    return
  }

  fail(
    `Unknown command: ${command ?? '(none)'}. Use generate | animate | transition | loop | keyframes | extend | resume`,
  )
}

main().catch(exitOnError)
