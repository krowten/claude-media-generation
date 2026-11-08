#!/usr/bin/env bun
// Image generation and editing: GPT Image 2.5, Nano Banana 2.1 and Bria background
// removal. Argv in, a verified image file on disk out.
import type { Model as ModelKey } from '../../../lib/models'
import type { ResultFile } from '../../../lib/provider'

import { parseArgs } from 'node:util'
import { Image } from 'bun'

import { fail, intArg, oneOf, oneSource } from '../../../lib/cli'
import { download, exitOnError, firstFile, localImage, resumeRequest, runModel } from '../../../lib/provider'

const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] as const
const MODELS = ['gpt-image-2.5', 'nano-banana-2.1'] as const
// `resume` only accepts this script's own models, so a mistyped key fails with a clear message.
const RESUME_MODELS = [
  'gpt-image-2.5',
  'gpt-image-2.5-edit',
  'nano-banana-2.1',
  'nano-banana-2.1-edit',
  'remove-background',
] as const satisfies readonly ModelKey[]
const QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const RESOLUTIONS = ['1K', '2K', '4K'] as const
const IMAGE_FORMATS = ['jpeg', 'png', 'webp'] as const

type AspectRatio = (typeof ASPECT_RATIOS)[number]
type Model = (typeof MODELS)[number]
type Quality = (typeof QUALITIES)[number]
type Resolution = (typeof RESOLUTIONS)[number]
type ImageFormat = (typeof IMAGE_FORMATS)[number]

// GPT Image has no aspect_ratio param - it takes exact pixel dimensions with both
// edges multiples of 16. Derive them for any W:H ratio, targeting ~1MP (cost scales
// with pixels), so the requested ratio is honored exactly.
const GPT_IMAGE_TARGET_PIXELS = 1024 * 1024

function gptImageSize(aspectRatio: AspectRatio): { width: number; height: number } {
  const [w = 1, h = 1] = aspectRatio.split(':').map(Number)
  const unit = Math.max(1, Math.round(Math.sqrt(GPT_IMAGE_TARGET_PIXELS / (w * h * 16 * 16))))
  return { width: w * unit * 16, height: h * unit * 16 }
}

// Each model has one knob for quality and cost: GPT Image its quality tier, Nano Banana its
// output resolution. Passing the other model's knob is an error, not a silent no-op.
function modelSettings(
  model: Model,
  quality: string | undefined,
  resolution: string | undefined,
): { quality: Quality } | { resolution: Resolution } {
  if (quality !== undefined && model !== 'gpt-image-2.5') fail('--quality only applies to --model gpt-image-2.5')
  if (resolution !== undefined && model !== 'nano-banana-2.1')
    fail('--resolution only applies to --model nano-banana-2.1')
  return model === 'gpt-image-2.5'
    ? { quality: oneOf('quality', quality ?? 'medium', QUALITIES) }
    : { resolution: oneOf('resolution', resolution ?? '1K', RESOLUTIONS) }
}

async function generateImage(
  prompt: string,
  aspectRatio: AspectRatio,
  model: Model,
  settings: ReturnType<typeof modelSettings>,
): Promise<ResultFile | undefined> {
  if (model === 'gpt-image-2.5')
    return firstFile(
      await runModel('gpt-image-2.5', { prompt, image_size: gptImageSize(aspectRatio), num_images: 1, ...settings }),
    )
  return firstFile(await runModel('nano-banana-2.1', { prompt, aspect_ratio: aspectRatio, num_images: 1, ...settings }))
}

// Appended to the prompt when generating for background removal: a flat
// high-contrast backdrop gives RMBG a clean cutout with smooth edges.
const BG_REMOVAL_PROMPT_HINT =
  'Plain solid uniform light-gray studio background, high contrast with the subject, ' +
  'no shadows, no gradients, subject fully inside the frame with margins on all sides.'

// `keep` tells Bria in plain words what the cutout should hold ("only the woman", "without the lamp").
async function removeBackgroundFromUrl(imageUrl: string, keep?: string): Promise<ResultFile | undefined> {
  return firstFile(await runModel('remove-background', { image_url: imageUrl, ...(keep ? { prompt: keep } : {}) }))
}

// The output extension decides the encoding; --format is optional and must agree with it.
function outputFormat(outputPath: string, formatFlag: string | undefined, needsAlpha = false): ImageFormat {
  const ext = outputPath.split('.').pop()?.toLowerCase()
  const format = ext === 'jpg' ? 'jpeg' : IMAGE_FORMATS.find(f => f === ext)
  if (!format) fail(`--output must end in .jpg, .jpeg, .png or .webp, got ${outputPath}`)
  if (formatFlag !== undefined && oneOf('format', formatFlag, IMAGE_FORMATS) !== format)
    fail(`--format ${formatFlag} conflicts with the .${ext} extension of --output`)
  if (needsAlpha && format === 'jpeg') fail('JPEG has no transparency — use a .png or .webp output for a cutout')
  return format
}

async function saveImage(
  sourceUrl: string,
  outputPath: string,
  opts: { format: ImageFormat; quality?: number; maxWidth?: number; matchSize?: { width: number; height: number } },
): Promise<{ width: number; height: number; bytes: number; format: string }> {
  const bytes = await download(sourceUrl)
  let img = new Image(bytes)
  const { width, height } = await img.metadata().catch(() => fail(`The file at ${sourceUrl} is not an image`))

  if (opts.matchSize) {
    // Shrinking to the source size is safe; stretching to another aspect ratio or upscaling
    // would only fake detail the model didn't produce, so those cases keep the native output.
    const target = opts.matchSize
    const sameAspect = Math.abs(width / height - target.width / target.height) < 0.01
    if (sameAspect && target.width <= width) img = img.resize(target.width, target.height, { fit: 'fill' })
    else if (target.width !== width || target.height !== height)
      console.error(
        `Note: kept the model's native ${width}x${height} instead of matching the source ${target.width}x${target.height}` +
          (sameAspect
            ? ' (upscaling adds no detail — nano-banana-2.1 with --resolution 2K/4K returns more pixels)'
            : ' (different aspect ratio, would distort)'),
      )
  } else if (opts.maxWidth && width > opts.maxWidth) {
    img = img.resize(opts.maxWidth, undefined, { fit: 'inside' })
  }

  const quality = opts.quality ?? 85
  const { format } = opts
  const encoded = format === 'png' ? img.png() : format === 'webp' ? img.webp({ quality }) : img.jpeg({ quality })
  const written = await encoded.write(outputPath)

  const saved = await new Image(outputPath).metadata()
  return { width: saved.width, height: saved.height, bytes: written, format: saved.format }
}

function report(
  action: string,
  outputPath: string,
  sourceUrl: string,
  saved: { width: number; height: number; bytes: number; format: string },
) {
  console.log(
    `${action} ${outputPath} (${saved.width}x${saved.height} ${saved.format}, ${Math.round(saved.bytes / 1024)}KB)`,
  )
  console.log(`Result URL (temporary, usable as --image-url): ${sourceUrl}`)
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)

  if (command === 'generate') {
    const { values } = parseArgs({
      args: rest,
      options: {
        prompt: { type: 'string' },
        output: { type: 'string' },
        model: { type: 'string', default: 'gpt-image-2.5' },
        'aspect-ratio': { type: 'string', default: '1:1' },
        quality: { type: 'string' },
        resolution: { type: 'string' },
        'remove-background': { type: 'boolean', default: false },
        format: { type: 'string' },
        'output-quality': { type: 'string' },
        'max-width': { type: 'string' },
      },
    })
    if (!values.prompt || !values.output) fail('generate requires --prompt and --output')
    const model = oneOf('model', values.model, MODELS)
    const aspectRatio = oneOf('aspect-ratio', values['aspect-ratio'], ASPECT_RATIOS)
    const settings = modelSettings(model, values.quality, values.resolution)
    const format = outputFormat(values.output, values.format, values['remove-background'])
    const outputQuality = intArg('output-quality', values['output-quality'], 1, 100)
    const maxWidth = intArg('max-width', values['max-width'], 1, 16384)

    let prompt = values.prompt
    if (values['remove-background'] && !/background|backdrop/i.test(prompt)) {
      prompt = `${prompt}. ${BG_REMOVAL_PROMPT_HINT}`
    }

    let result = await generateImage(prompt, aspectRatio, model, settings)
    if (!result?.url) fail('No image was generated. Try rephrasing the prompt.')

    if (values['remove-background']) {
      const cutout = await removeBackgroundFromUrl(result.url)
      if (!cutout?.url)
        fail(
          `The image was generated but background removal returned nothing. Retry only the removal:\n` +
            `  bun ${process.argv[1]} remove-background --image-url ${result.url} --output ${values.output}`,
        )
      result = cutout
    }

    const saved = await saveImage(result.url, values.output, { format, quality: outputQuality, maxWidth })
    report('Image saved to', values.output, result.url, saved)
    return
  }

  if (command === 'edit') {
    const { values } = parseArgs({
      args: rest,
      options: {
        prompt: { type: 'string' },
        source: { type: 'string' },
        'image-url': { type: 'string' },
        output: { type: 'string' },
        model: { type: 'string', default: 'gpt-image-2.5' },
        quality: { type: 'string' },
        resolution: { type: 'string' },
        'no-match-source-size': { type: 'boolean', default: false },
        format: { type: 'string' },
        'output-quality': { type: 'string' },
      },
    })
    if (!values.prompt || !values.output) fail('edit requires --prompt and --output')
    oneSource('edit', values.source, values['image-url'])
    const model = oneOf('model', values.model, MODELS)
    const settings = modelSettings(model, values.quality, values.resolution)
    const format = outputFormat(values.output, values.format)
    const outputQuality = intArg('output-quality', values['output-quality'], 1, 100)

    const local = values.source ? await localImage(values.source) : undefined
    const input = { prompt: values.prompt, image_urls: [values['image-url'] ?? local!.dataUri] }
    const edited = firstFile(
      await runModel(model === 'gpt-image-2.5' ? 'gpt-image-2.5-edit' : 'nano-banana-2.1-edit', {
        ...input,
        ...settings,
      }),
    )
    if (!edited?.url) fail('No image was returned. Try rephrasing the edit instruction.')

    const matchSize =
      local && !values['no-match-source-size'] ? { width: local.width, height: local.height } : undefined
    const saved = await saveImage(edited.url, values.output, { format, quality: outputQuality, matchSize })
    report('Edited image saved to', values.output, edited.url, saved)
    return
  }

  if (command === 'remove-background') {
    const { values } = parseArgs({
      args: rest,
      options: {
        source: { type: 'string' },
        'image-url': { type: 'string' },
        output: { type: 'string' },
        format: { type: 'string' },
        'output-quality': { type: 'string' },
        'max-width': { type: 'string' },
        keep: { type: 'string' },
      },
    })
    if (!values.output) fail('remove-background requires --output')
    if (values.keep !== undefined && !values.keep.trim()) fail('--keep needs a description of what to keep')
    oneSource('remove-background', values.source, values['image-url'])
    const format = outputFormat(values.output, values.format, true)
    const outputQuality = intArg('output-quality', values['output-quality'], 1, 100)
    const maxWidth = intArg('max-width', values['max-width'], 1, 16384)

    const inputImage = values['image-url'] ?? (await localImage(values.source!)).dataUri
    const cutout = await removeBackgroundFromUrl(inputImage, values.keep)
    if (!cutout?.url) fail('Background removal failed: the API returned no image')

    const saved = await saveImage(cutout.url, values.output, { format, quality: outputQuality, maxWidth })
    report('Background removed →', values.output, cutout.url, saved)
    return
  }

  if (command === 'resume') {
    const { values } = parseArgs({
      args: rest,
      options: {
        model: { type: 'string' },
        'request-id': { type: 'string' },
        output: { type: 'string' },
        format: { type: 'string' },
        'output-quality': { type: 'string' },
      },
    })
    if (!values.model || !values['request-id'] || !values.output)
      fail('resume requires --model, --request-id and --output (all printed when the request was accepted)')
    const format = outputFormat(values.output, values.format)
    const outputQuality = intArg('output-quality', values['output-quality'], 1, 100)

    const image = firstFile(await resumeRequest(oneOf('model', values.model, RESUME_MODELS), values['request-id']))
    if (!image?.url) fail(`Request ${values['request-id']} finished without an image`)
    const saved = await saveImage(image.url, values.output, { format, quality: outputQuality })
    report('Image saved to', values.output, image.url, saved)
    return
  }

  fail(`Unknown command: ${command ?? '(none)'}. Use generate | edit | remove-background | resume`)
}

main().catch(exitOnError)
