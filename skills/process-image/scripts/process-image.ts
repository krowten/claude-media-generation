#!/usr/bin/env bun
// Local image processing on Bun's native Image API — no network, no npm sharp.
import { parseArgs } from 'node:util'
import { file, Image, version } from 'bun'

import { exitOnError, fail, intArg, numberArg, oneOf } from '../../../lib/cli'

const FORMATS = ['jpeg', 'png', 'webp', 'avif', 'heic'] as const
type Format = (typeof FORMATS)[number]

if (typeof Image !== 'function') {
  fail(`Bun ${version} has no native Bun.Image API. Upgrade with \`bun upgrade\` and retry.`)
}

// Bun.Image can't decode SVG, so an .svg source is rendered to PNG first (at `width` when the
// command knows its target size, so a favicon is drawn sharp instead of scaled down).
async function openImage(sourcePath: string, width?: number): Promise<Image> {
  const source = file(sourcePath)
  if (!(await source.exists())) fail(`Source file not found: ${sourcePath}`)
  if (!sourcePath.toLowerCase().endsWith('.svg')) return new Image(source)
  // Loaded on demand: only SVG sources need it, and Bun installs it on first use.
  const { Resvg } = await import('@resvg/resvg-js')
  const svg = new Resvg(await source.text(), width ? { fitTo: { mode: 'width', value: width } } : {})
  return new Image(svg.render().asPng())
}

function formatFromPath(path: string): Format {
  const ext = path.split('.').pop()?.toLowerCase()
  const format = ext === 'jpg' ? 'jpeg' : FORMATS.find(f => f === ext)
  if (!format) fail(`--output must end in .jpg, .jpeg, .png, .webp, .avif or .heic, got ${path}`)
  return format
}

function encode(img: Image, format: Format, quality: number) {
  if (format === 'jpeg') return img.jpeg({ quality })
  if (format === 'png') return img.png()
  if (format === 'webp') return img.webp({ quality })
  if (format === 'avif') return img.avif({ quality })
  return img.heic({ quality })
}

// Encodes in the format of the output extension, writes, and reports what actually landed on disk.
async function save(img: Image, outputPath: string, quality: string, action: string): Promise<void> {
  await encode(img, formatFromPath(outputPath), intArg('quality', quality, 1, 100)!).write(outputPath)

  const meta = await new Image(outputPath).metadata()
  const sizeKB = Math.round(file(outputPath).size / 1024)
  console.log(`${action} (${meta.width}x${meta.height} ${meta.format}, ${sizeKB}KB):\n  → ${outputPath}`)
}

const QUALITY_OPTION = { quality: { type: 'string', default: '85' } } as const

async function main() {
  const [command, ...rest] = process.argv.slice(2)

  if (command === 'info') {
    const { values } = parseArgs({ args: rest, options: { source: { type: 'string' } } })
    if (!values.source) fail('info requires --source')

    const img = await openImage(values.source)
    const meta = await img.metadata()
    const sizeBytes = file(values.source).size
    const sizeKB = Math.round(sizeBytes / 1024)
    const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2)
    console.log(
      [
        `Image: ${values.source}`,
        `Format: ${values.source.toLowerCase().endsWith('.svg') ? 'svg (rendered size)' : meta.format}`,
        `Dimensions: ${meta.width}x${meta.height}`,
        `Size: ${sizeKB}KB (${sizeMB}MB)`,
      ].join('\n'),
    )
    return
  }

  if (command === 'resize') {
    const { values } = parseArgs({
      args: rest,
      options: {
        source: { type: 'string' },
        output: { type: 'string' },
        width: { type: 'string' },
        height: { type: 'string' },
        fit: { type: 'string', default: 'inside' },
        ...QUALITY_OPTION,
      },
    })
    if (!values.source || !values.output || !values.width) fail('resize requires --source, --output, --width')
    const fit = oneOf('fit', values.fit, ['inside', 'fill'] as const)
    const width = intArg('width', values.width, 1, 65535)!
    const height = intArg('height', values.height, 1, 65535)
    formatFromPath(values.output)

    const img = await openImage(values.source, width)
    await save(img.resize(width, height, { fit }), values.output, values.quality, 'Image resized')
    return
  }

  if (command === 'convert') {
    const { values } = parseArgs({
      args: rest,
      options: {
        source: { type: 'string' },
        output: { type: 'string' },
        format: { type: 'string' },
        ...QUALITY_OPTION,
      },
    })
    if (!values.source || !values.output || !values.format) fail('convert requires --source, --output, --format')
    const format = oneOf('format', values.format, FORMATS)
    if (formatFromPath(values.output) !== format)
      fail(`--format ${format} conflicts with the extension of --output ${values.output}`)

    const img = await openImage(values.source)
    await save(img, values.output, values.quality, `Image converted to ${format.toUpperCase()}`)
    return
  }

  if (command === 'rotate') {
    const { values } = parseArgs({
      args: rest,
      options: {
        source: { type: 'string' },
        output: { type: 'string' },
        degrees: { type: 'string' },
        ...QUALITY_OPTION,
      },
    })
    if (!values.source || !values.output || !values.degrees) fail('rotate requires --source, --output, --degrees')
    const degrees = Number(values.degrees)
    if (![90, 180, 270].includes(degrees)) fail('rotate supports --degrees 90 | 180 | 270 (clockwise)')

    const img = await openImage(values.source)
    await save(img.rotate(degrees), values.output, values.quality, `Image rotated ${degrees}°`)
    return
  }

  if (command === 'flip') {
    const { values } = parseArgs({
      args: rest,
      options: {
        source: { type: 'string' },
        output: { type: 'string' },
        axis: { type: 'string', default: 'horizontal' },
        ...QUALITY_OPTION,
      },
    })
    if (!values.source || !values.output) fail('flip requires --source and --output')
    if (values.axis !== 'horizontal' && values.axis !== 'vertical')
      fail(`Unknown axis: ${values.axis}. Use horizontal (mirror left-right) | vertical (upside down)`)

    const img = await openImage(values.source)
    const flipped = values.axis === 'horizontal' ? img.flop() : img.flip()
    await save(flipped, values.output, values.quality, `Image flipped (${values.axis})`)
    return
  }

  if (command === 'adjust') {
    const { values } = parseArgs({
      args: rest,
      options: {
        source: { type: 'string' },
        output: { type: 'string' },
        brightness: { type: 'string' },
        saturation: { type: 'string' },
        ...QUALITY_OPTION,
      },
    })
    if (!values.source || !values.output) fail('adjust requires --source and --output')
    if (!values.brightness && !values.saturation)
      fail('adjust requires --brightness and/or --saturation (multipliers, 1.0 = unchanged)')

    const img = await openImage(values.source)
    const adjusted = img.modulate({
      brightness: numberArg('brightness', values.brightness, 0, 10),
      saturation: numberArg('saturation', values.saturation, 0, 10),
    })
    await save(adjusted, values.output, values.quality, 'Image adjusted')
    return
  }

  if (command === 'placeholder') {
    const { values } = parseArgs({ args: rest, options: { source: { type: 'string' } } })
    if (!values.source) fail('placeholder requires --source')

    const img = await openImage(values.source)
    const dataUri = await img.placeholder()
    console.log(dataUri)
    return
  }

  fail(`Unknown command: ${command ?? '(none)'}. Use info | resize | convert | rotate | flip | adjust | placeholder`)
}

// Bun reads/writes HEIC, AVIF and TIFF only through an OS codec: none on Linux, AVIF encode only on
// Apple M3+ Macs, extra Store extensions on Windows. JPEG/PNG/WebP work everywhere.
main().catch(error => {
  if (error?.code === 'ERR_IMAGE_FORMAT_UNSUPPORTED') {
    fail(
      'This machine has no codec for the HEIC/AVIF/TIFF image involved (Bun relies on the OS for those: ' +
        'unavailable on Linux, AVIF encoding needs an Apple M3+ Mac, Windows needs the HEIF/AV1 extensions ' +
        'from the Microsoft Store). Use webp/png/jpeg for the output, or convert the source on another machine.',
    )
  }
  exitOnError(error)
})
