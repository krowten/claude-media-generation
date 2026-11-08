#!/usr/bin/env bun
// Vector graphics: Recraft V4.1 text-to-SVG and raster-to-SVG vectorization.
// Argv in, a verified .svg file on disk out.
import type { Model } from '../../../lib/models'

import { parseArgs } from 'node:util'
import { file, Image, write } from 'bun'

import { fail, intArg, oneOf, oneSource } from '../../../lib/cli'
import { download, exitOnError, firstFile, resumeRequest, runModel } from '../../../lib/provider'

const MODELS = ['standard', 'pro'] as const
// `resume` only accepts this script's own models, so a mistyped key fails with a clear message.
const RESUME_MODELS = ['recraft-svg', 'recraft-svg-pro', 'recraft-vectorize'] as const satisfies readonly Model[]
const IMAGE_SIZES = ['square_hd', 'square', 'portrait_4_3', 'portrait_16_9', 'landscape_4_3', 'landscape_16_9'] as const

// Input limits of Recraft vectorize. The API states them as strict inequalities:
// each side more than 256 and less than 4096 px, under 16 MP and under 5 MB.
const VECTORIZE_MIN_SIDE = 257
const VECTORIZE_MAX_SIDE = 4095
const VECTORIZE_MAX_PIXELS = 16_000_000 - 1
const VECTORIZE_MAX_BYTES = 5_000_000 - 1

type RGBColor = { r: number; g: number; b: number }

function parseHexColor(hex: string): RGBColor {
  const digits = /^#?([0-9a-f]{6})$/i.exec(hex.trim())?.[1]
  if (!digits) fail(`Invalid color: "${hex}". Use #RRGGBB hex, e.g. #1a73e8`)
  const value = Number.parseInt(digits, 16)
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff }
}

const SVG_ROOT = /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i
// Anything that can run code or fetch from elsewhere once the SVG is inlined into a page. The
// handler check also catches `<svg/onload=…>`, where a slash rather than a space precedes it.
const ACTIVE_SVG_CONTENT =
  /<script|<foreignObject|[\s/"']on[a-z]+\s*=|javascript:|href\s*=\s*["']?\s*(?:https?:|data:|\/\/)/i

async function saveSvg(sourceUrl: string, outputPath: string): Promise<void> {
  const svg = new TextDecoder().decode(await download(sourceUrl))
  if (!SVG_ROOT.test(svg))
    fail(`The file at ${sourceUrl} is not an SVG (starts with: ${JSON.stringify(svg.slice(0, 60))})`)
  // Checked before writing, so such a file never lands in the project where it could get inlined.
  if (ACTIVE_SVG_CONTENT.test(svg))
    fail(
      `The SVG at ${sourceUrl} contains scripts, event handlers or external links, so it was not saved. ` +
        'Generate again with a different prompt.',
    )
  await write(outputPath, svg)
  console.log(`SVG saved to ${outputPath} (${Math.round(svg.length / 1024)}KB)`)
  console.log(`Result URL (temporary): ${sourceUrl}`)
}

// Fits the source into vectorize's size window, checking the final file rather than the original:
// a very wide image can pass the minimum-side check and then fall below it after downscaling.
async function prepareVectorizeInput(sourcePath: string): Promise<string> {
  const source = file(sourcePath)
  if (!(await source.exists())) fail(`Source file not found: ${sourcePath}`)

  const { width, height, format } = await new Image(source)
    .metadata()
    .catch(() => fail(`Not a readable image: ${sourcePath}`))
  const scale = Math.min(
    1,
    VECTORIZE_MAX_SIDE / Math.max(width, height),
    Math.sqrt(VECTORIZE_MAX_PIXELS / (width * height)),
  )
  const [targetWidth, targetHeight] = [Math.floor(width * scale), Math.floor(height * scale)]
  if (Math.min(targetWidth, targetHeight) < VECTORIZE_MIN_SIDE)
    fail(
      `Vectorize needs both sides over 256px after fitting into 4095px; ${width}x${height} would become ` +
        `${targetWidth}x${targetHeight}. Crop it to a less extreme aspect ratio, or regenerate it larger — upscaling adds no detail.`,
    )

  const supported = format === 'png' || format === 'jpeg' || format === 'webp'
  if (supported && scale === 1 && source.size <= VECTORIZE_MAX_BYTES)
    return `data:image/${format};base64,${Buffer.from(await source.bytes()).toString('base64')}`

  const img = scale === 1 ? new Image(source) : new Image(source).resize(targetWidth, targetHeight, { fit: 'fill' })
  const png = await img.png().bytes()
  if (png.byteLength <= VECTORIZE_MAX_BYTES) return `data:image/png;base64,${Buffer.from(png).toString('base64')}`
  // Photographic content makes PNG too heavy; step JPEG quality down until it fits.
  for (const quality of [90, 80, 70, 60]) {
    const jpeg = await new Image(png).jpeg({ quality }).bytes()
    if (jpeg.byteLength <= VECTORIZE_MAX_BYTES) return `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}`
  }
  fail(`${sourcePath} stays over vectorize's 5 MB limit even as a JPEG at quality 60 — crop or simplify it first`)
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)

  if (command === 'generate') {
    const { values } = parseArgs({
      args: rest,
      options: {
        prompt: { type: 'string' },
        output: { type: 'string' },
        model: { type: 'string', default: 'standard' },
        size: { type: 'string', default: 'square_hd' },
        width: { type: 'string' },
        height: { type: 'string' },
        colors: { type: 'string' },
        background: { type: 'string' },
      },
    })
    if (!values.prompt || !values.output) fail('generate requires --prompt and --output')
    const model = oneOf('model', values.model, MODELS)
    if ((values.width && !values.height) || (!values.width && values.height))
      fail('--width and --height must be passed together (or use --size)')
    const imageSize = values.width
      ? { width: intArg('width', values.width, 1, 14142), height: intArg('height', values.height, 1, 14142) }
      : oneOf('size', values.size, IMAGE_SIZES)
    const colors = values.colors ? { colors: values.colors.split(',').map(parseHexColor) } : {}
    const background = values.background ? { background_color: parseHexColor(values.background) } : {}

    const svgModel = model === 'pro' ? 'recraft-svg-pro' : 'recraft-svg'
    const image = firstFile(
      await runModel(svgModel, { prompt: values.prompt, image_size: imageSize, ...colors, ...background }),
    )
    if (!image?.url) fail('No SVG was generated. Try rephrasing the prompt.')
    await saveSvg(image.url, values.output)
    return
  }

  if (command === 'vectorize') {
    const { values } = parseArgs({
      args: rest,
      options: {
        source: { type: 'string' },
        'image-url': { type: 'string' },
        output: { type: 'string' },
      },
    })
    if (!values.output) fail('vectorize requires --output')
    oneSource('vectorize', values.source, values['image-url'])

    const inputImage = values['image-url'] ?? (await prepareVectorizeInput(values.source!))
    const image = firstFile(await runModel('recraft-vectorize', { image_url: inputImage }))
    if (!image?.url) fail('Vectorization failed: the API returned no image')
    await saveSvg(image.url, values.output)
    return
  }

  if (command === 'resume') {
    const { values } = parseArgs({
      args: rest,
      options: { model: { type: 'string' }, 'request-id': { type: 'string' }, output: { type: 'string' } },
    })
    if (!values.model || !values['request-id'] || !values.output)
      fail('resume requires --model, --request-id and --output (all printed when the request was accepted)')
    const image = firstFile(await resumeRequest(oneOf('model', values.model, RESUME_MODELS), values['request-id']))
    if (!image?.url) fail(`Request ${values['request-id']} finished without an SVG`)
    await saveSvg(image.url, values.output)
    return
  }

  fail(`Unknown command: ${command ?? '(none)'}. Use generate | vectorize | resume`)
}

main().catch(exitOnError)
