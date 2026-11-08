import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { file, Image, write } from 'bun'

import { runSkill } from './run'

let dir: string
let photo: string
let log: string

type Submission = { endpoint: string; input: Record<string, any> }

async function submissions(): Promise<Submission[]> {
  const text = (await file(log).exists()) ? await file(log).text() : ''
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

function generate(skill: string, args: string[], mode = '', fixture = photo, env: Record<string, string> = {}) {
  return runSkill(skill, args, { MOCK_FAL_LOG: log, MOCK_FAL_MODE: mode, MOCK_FAL_FIXTURE: fixture, ...env })
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'claude-media-generation-generate-'))
  photo = join(dir, 'photo.png')
  await new Image(join(import.meta.dir, 'fixtures/pixel.png')).resize(640, 480, { fit: 'fill' }).png().write(photo)
})

afterAll(() => rm(dir, { recursive: true, force: true }))

let n = 0
const out = (ext: string) => join(dir, `out-${++n}.${ext}`)

describe('invalid input never reaches the API', () => {
  const cases: [string, string[]][] = [
    ['unknown image model', ['generate', '--prompt', 'cat', '--output', 'x.png', '--model', 'typo']],
    ['unknown aspect ratio', ['generate', '--prompt', 'cat', '--output', 'x.png', '--aspect-ratio', 'oops']],
    ['non-numeric output quality', ['generate', '--prompt', 'cat', '--output', 'x.png', '--output-quality', 'nope']],
    ['unsupported output extension', ['generate', '--prompt', 'cat', '--output', 'x.avif']],
    ['format/extension conflict', ['generate', '--prompt', 'cat', '--output', 'x.webp', '--format', 'png']],
    [
      'flag the model ignores',
      ['generate', '--prompt', 'cat', '--output', 'x.png', '--model', 'nano-banana-2.1', '--quality', 'high'],
    ],
    ['JPEG cutout', ['remove-background', '--image-url', 'https://x/y.png', '--output', 'x.jpg']],
    [
      'two edit sources',
      ['edit', '--prompt', 'cat', '--output', 'x.png', '--source', 'a.png', '--image-url', 'https://x/y'],
    ],
    ['missing edit source', ['edit', '--prompt', 'cat', '--output', 'x.png', '--source', 'missing.png']],
  ]
  for (const [name, args] of cases)
    test(`generate-image: ${name}`, async () => {
      log = join(dir, `log-${++n}`)
      expect(generate('generate-image', args).code).toBe(1)
      expect(await submissions()).toEqual([])
    })

  const videoCases: [string, string[]][] = [
    ['duration out of range', ['generate', '--prompt', 'sea', '--output', 'x.mp4', '--duration', '100']],
    ['unknown tier', ['generate', '--prompt', 'sea', '--output', 'x.mp4', '--model', 'ultra']],
    ['two keyframes', ['keyframes', '--prompt', 'sea', '--output', 'x.mp4', '--frame', 'a.png', '--frame', 'b.png']],
    [
      'keyframes on a model without middle frames',
      [
        'keyframes',
        '--model',
        'h3-max',
        '--prompt',
        'sea',
        '--output',
        'x.mp4',
        ...['a', 'b', 'c'].flatMap(f => ['--frame', `${f}.png`]),
      ],
    ],
    [
      'extend duration Veo does not offer',
      ['extend', '--prompt', 'sea', '--source', 'https://x/y.mp4', '--output', 'x.mp4', '--duration', '5'],
    ],
  ]
  for (const [name, args] of videoCases)
    test(`generate-video: ${name}`, async () => {
      log = join(dir, `log-${++n}`)
      expect(generate('generate-video', args).code).toBe(1)
      expect(await submissions()).toEqual([])
    })

  test('generate-video: frame below Kling minimum size', async () => {
    log = join(dir, `log-${++n}`)
    const small = join(dir, 'small.png')
    await new Image(photo).resize(200, 200, { fit: 'fill' }).png().write(small)
    const args = ['loop', '--model', 'kling-4', '--prompt', 'sea', '--source', small, '--output', 'x.mp4']
    const result = generate('generate-video', args)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('300x300')
    expect(await submissions()).toEqual([])
  })

  test('generate-svg: fractional custom size', async () => {
    log = join(dir, `log-${++n}`)
    expect(
      generate('generate-svg', [
        'generate',
        '--prompt',
        'logo',
        '--output',
        'x.svg',
        '--width',
        '10.5',
        '--height',
        '10',
      ]).code,
    ).toBe(1)
    expect(await submissions()).toEqual([])
  })

  test('generate-svg: aspect ratio too extreme to fit the vectorize window', async () => {
    log = join(dir, `log-${++n}`)
    const wide = join(dir, 'wide.png')
    await new Image(photo).resize(8192, 256, { fit: 'fill' }).png().write(wide)
    expect(generate('generate-svg', ['vectorize', '--source', wide, '--output', 'x.svg']).code).toBe(1)
    expect(await submissions()).toEqual([])
  })
})

describe('API key', () => {
  test('a missing key fails before any request', async () => {
    log = join(dir, `log-${++n}`)
    const args = ['generate', '--prompt', 'cat', '--output', out('png')]
    const result = generate('generate-image', args, '', photo, { FAL_KEY: '' })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('FAL_KEY is not set')
    expect(await submissions()).toEqual([])
  })
})

describe('generate-image', () => {
  test('generate sends the default model payload and saves a decodable image', async () => {
    log = join(dir, `log-${++n}`)
    const output = out('png')
    const result = generate('generate-image', [
      'generate',
      '--prompt',
      'a cat',
      '--output',
      output,
      '--aspect-ratio',
      '16:9',
    ])
    expect(result.code).toBe(0)
    expect(await submissions()).toEqual([
      {
        endpoint: 'openai/gpt-image-2.5/sunburst/text-to-image',
        input: { prompt: 'a cat', image_size: { width: 1280, height: 720 }, quality: 'medium', num_images: 1 },
      },
    ])
    expect((await new Image(output).metadata()).format).toBe('png')
    expect(result.stderr).toContain('--request-id mock-request-id')
    expect(result.stdout).toContain('Result URL')
  })

  test('a missing cutout fails instead of saving the opaque original', async () => {
    log = join(dir, `log-${++n}`)
    const output = out('png')
    const result = generate(
      'generate-image',
      ['generate', '--prompt', 'a mug', '--output', output, '--remove-background'],
      'empty-cutout',
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('remove-background --image-url https://mock.invalid/result')
    expect(await file(output).exists()).toBe(false)
  })

  test('the output extension decides the encoded format', async () => {
    log = join(dir, `log-${++n}`)
    const output = out('webp')
    expect(generate('generate-image', ['remove-background', '--source', photo, '--output', output]).code).toBe(0)
    expect((await new Image(output).metadata()).format).toBe('webp')
  })

  test('--keep reaches the background remover as its prompt', async () => {
    log = join(dir, `log-${++n}`)
    const args = ['remove-background', '--source', photo, '--output', out('png'), '--keep', 'only the woman']
    expect(generate('generate-image', args).code).toBe(0)
    const [submission] = await submissions()
    expect(submission?.input.prompt).toBe('only the woman')
  })

  test('nano-banana edit requests the chosen resolution and never stretches to the source size', async () => {
    log = join(dir, `log-${++n}`)
    const portrait = join(dir, 'portrait.png')
    await new Image(photo).resize(300, 600, { fit: 'fill' }).png().write(portrait)
    const output = out('png')
    const result = generate('generate-image', [
      'edit',
      '--prompt',
      'bluer',
      '--source',
      portrait,
      '--output',
      output,
      '--model',
      'nano-banana-2.1',
      '--resolution',
      '4K',
    ])
    expect(result.code).toBe(0)
    const [submission] = await submissions()
    if (!submission) throw new Error('nothing was submitted')
    expect(submission.endpoint).toBe('google/nano-banana-2.1/edit')
    expect(submission.input.resolution).toBe('4K')
    // The mock returns the 640x480 photo; a 300x600 source must not distort it.
    const { width, height } = await new Image(output).metadata()
    expect([width, height]).toEqual([640, 480])
  })

  test('a failed download points to resume, and resume saves without resubmitting', async () => {
    log = join(dir, `log-${++n}`)
    const failed = generate('generate-image', ['generate', '--prompt', 'cat', '--output', out('png')], 'download-error')
    expect(failed.code).toBe(1)
    expect(failed.stderr).toContain('resume --model gpt-image-2.5 --request-id mock-request-id')

    const output = out('png')
    const resumed = generate('generate-image', [
      'resume',
      '--model',
      'gpt-image-2.5',
      '--request-id',
      'mock-request-id',
      '--output',
      output,
    ])
    expect(resumed.code).toBe(0)
    expect(await submissions()).toHaveLength(1)
    expect(await file(output).exists()).toBe(true)
  })
})

describe('generate-svg', () => {
  test('vectorize fits a wide source inside every limit of the final file', async () => {
    log = join(dir, `log-${++n}`)
    const wide = join(dir, 'wide-ok.png')
    await new Image(photo).resize(8192, 1024, { fit: 'fill' }).png().write(wide)
    const svg = join(dir, 'logo.svg')
    await write(svg, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>')
    expect(generate('generate-svg', ['vectorize', '--source', wide, '--output', out('svg')], '', svg).code).toBe(0)
    const [submission] = await submissions()
    if (!submission) throw new Error('nothing was submitted')
    const { width, height, bytes } = submission.input.image_url
    expect(width).toBeLessThan(4096)
    expect(Math.min(width, height)).toBeGreaterThan(256)
    expect(width * height).toBeLessThan(16_000_000)
    expect(bytes).toBeLessThan(5_000_000)
  })

  test('an HTML page is not saved as SVG', () => {
    log = join(dir, `log-${++n}`)
    expect(generate('generate-svg', ['generate', '--prompt', 'logo', '--output', out('svg')], 'html').code).toBe(1)
  })

  test('an SVG with active content is not saved', async () => {
    const evil = join(dir, 'evil.svg')
    for (const svg of [
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
      '<svg/onload=alert(1)>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://tracker.invalid/p.png"/></svg>',
    ]) {
      log = join(dir, `log-${++n}`)
      await write(evil, svg)
      const output = out('svg')
      const result = generate('generate-svg', ['generate', '--prompt', 'logo', '--output', output], '', evil)
      expect(result.code).toBe(1)
      expect(await file(output).exists()).toBe(false)
    }
  })
})

describe('generate-video', () => {
  test('an HTML page is not saved as MP4', () => {
    log = join(dir, `log-${++n}`)
    expect(generate('generate-video', ['generate', '--prompt', 'sea', '--output', out('mp4')], 'html').code).toBe(1)
  })

  test('the result URL is printed for a follow-up extend', async () => {
    log = join(dir, `log-${++n}`)
    const mp4 = join(dir, 'clip.mp4')
    await write(mp4, new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypisom'), 0, 0, 2, 0]))
    const result = generate(
      'generate-video',
      ['loop', '--prompt', 'sea', '--source', photo, '--output', out('mp4')],
      '',
      mp4,
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Result URL (temporary, usable as extend --source): https://mock.invalid/result')
    const [submission] = await submissions()
    if (!submission) throw new Error('nothing was submitted')
    expect(submission.endpoint).toBe('minimax/h3-max/image-to-video')
    expect(submission.input.image_url).toEqual(submission.input.end_image_url)
    expect(submission.input).toMatchObject({ resolution: '1080P', duration: 5, prompt_expansion_mode: 'balanced' })
  })

  test('kling-4 gets its own field names and resolution spelling', async () => {
    log = join(dir, `log-${++n}`)
    const mp4 = join(dir, 'clip.mp4')
    const args = ['animate', '--model', 'kling-4', '--prompt', 'sea', '--source', photo, '--output', out('mp4')]
    expect(generate('generate-video', [...args, '--resolution', '720p'], '', mp4).code).toBe(0)
    const [submission] = await submissions()
    if (!submission) throw new Error('nothing was submitted')
    expect(submission.endpoint).toBe('kling/v4/image-to-video')
    expect(submission.input).toMatchObject({ resolution: '720p', duration: 5 })
    expect(submission.input.start_image_url).toBeDefined()
  })

  test('keyframes go to Kling as first, middle and last frames', async () => {
    log = join(dir, `log-${++n}`)
    const mp4 = join(dir, 'clip.mp4')
    const frames = [photo, photo, photo, photo].flatMap(f => ['--frame', f])
    expect(
      generate('generate-video', ['keyframes', '--prompt', 'turn', ...frames, '--output', out('mp4')], '', mp4).code,
    ).toBe(0)
    const [submission] = await submissions()
    if (!submission) throw new Error('nothing was submitted')
    expect(submission.endpoint).toBe('kling/v4/image-to-video')
    expect((submission.input.middle_image_urls as unknown[]).length).toBe(2)
    expect(submission.input.end_image_url).toBeDefined()
  })

  test('seedance-2.5 defaults to 720p, a string duration and no soundtrack', async () => {
    log = join(dir, `log-${++n}`)
    const mp4 = join(dir, 'clip.mp4')
    const args = ['animate', '--model', 'seedance-2.5', '--prompt', 'sea', '--source', photo, '--output', out('mp4')]
    expect(generate('generate-video', args, '', mp4).code).toBe(0)
    const [submission] = await submissions()
    if (!submission) throw new Error('nothing was submitted')
    expect(submission.endpoint).toBe('bytedance/seedance-2.5/us/image-to-video')
    expect(submission.input).toMatchObject({ resolution: '720p', duration: '5', generate_audio: false })
  })
})
