import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { file, Image, spawnSync, which, write } from 'bun'

import { runSkill } from './run'

let dir: string
let photo: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'claude-media-generation-process-'))
  photo = join(dir, 'photo.png')
  await new Image(join(import.meta.dir, 'fixtures/pixel.png')).resize(640, 480, { fit: 'fill' }).png().write(photo)
})

afterAll(() => rm(dir, { recursive: true, force: true }))

describe('process-image', () => {
  test('convert writes the requested format', async () => {
    const output = join(dir, 'photo.webp')
    expect(runSkill('process-image', ['convert', '--source', photo, '--output', output, '--format', 'webp']).code).toBe(
      0,
    )
    expect((await new Image(output).metadata()).format).toBe('webp')
  })

  test('an SVG source is rendered at the target width', async () => {
    const svg = join(dir, 'mark.svg')
    await write(
      svg,
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10" fill="#c2410c"/></svg>',
    )
    const output = join(dir, 'mark.png')
    expect(runSkill('process-image', ['resize', '--source', svg, '--output', output, '--width', '64']).code).toBe(0)
    const meta = await new Image(output).metadata()
    expect([meta.width, meta.height]).toEqual([64, 32])
  })

  test('an unknown output extension is rejected instead of silently becoming JPEG', () => {
    const result = runSkill('process-image', [
      'rotate',
      '--source',
      photo,
      '--output',
      join(dir, 'x.gif'),
      '--degrees',
      '90',
    ])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('--output must end in')
  })

  test('--hue is rejected: Bun.Image ignores it', () => {
    const result = runSkill('process-image', [
      'adjust',
      '--source',
      photo,
      '--output',
      join(dir, 'x.png'),
      '--hue',
      '30',
    ])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("Unknown option '--hue'")
  })

  test.if(process.platform === 'linux')('AVIF on Linux explains the platform limit', () => {
    const result = runSkill('process-image', [
      'convert',
      '--source',
      photo,
      '--output',
      join(dir, 'x.avif'),
      '--format',
      'avif',
    ])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('unavailable on Linux')
    expect(result.stderr).not.toContain('libheif')
  })
})

describe.skipIf(!which('ffmpeg'))('process-video', () => {
  let clip: string

  beforeAll(() => {
    clip = join(dir, 'clip.mp4')
    const args = [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=25',
      '-pix_fmt',
      'yuv420p',
      clip,
    ]
    expect(spawnSync(['ffmpeg', ...args]).exitCode).toBe(0)
  })

  test('a poster past the end fails and keeps the previous poster', async () => {
    const output = join(dir, 'poster.jpg')
    await write(output, 'previous poster')
    const result = runSkill('process-video', ['poster', '--source', clip, '--output', output, '--time', '999'])
    expect(result.code).toBe(1)
    expect(await file(output).text()).toBe('previous poster')
  })

  test('a trim past the end fails instead of writing an empty MP4', async () => {
    const output = join(dir, 'empty.mp4')
    const result = runSkill('process-video', [
      'trim',
      '--source',
      clip,
      '--output',
      output,
      '--start',
      '999',
      '--duration',
      '1',
    ])
    expect(result.code).toBe(1)
    expect(await file(output).exists()).toBe(false)
  })

  test('an odd width is evened and a missing output directory is created', async () => {
    const output = join(dir, 'new/dir/clip.mp4')
    const result = runSkill('process-video', [
      'encode',
      '--source',
      clip,
      '--output',
      output,
      '--width',
      '161',
      '--no-audio',
    ])
    expect(result.code).toBe(0)
    expect(runSkill('process-video', ['info', '--source', output]).stdout).toContain('160x120')
  })

  test('--width never upscales', () => {
    const output = join(dir, 'wide.webm')
    expect(
      runSkill('process-video', ['encode', '--source', clip, '--output', output, '--width', '1280', '--no-audio']).code,
    ).toBe(0)
    expect(runSkill('process-video', ['info', '--source', output]).stdout).toContain('320x240')
  })

  test('loop-seam drops the blended frames and rejects a fade longer than half the clip', () => {
    const output = join(dir, 'seam.mp4')
    const result = runSkill('process-video', ['loop-seam', '--source', clip, '--output', output, '--fade', '0.4'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('40 of 50 frames kept')
    const count = spawnSync([
      'ffprobe',
      '-v',
      'error',
      '-count_frames',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=nb_read_frames',
      '-of',
      'csv=p=0',
      output,
    ])
    expect(count.stdout.toString().trim()).toBe('40')
    expect(runSkill('process-video', ['loop-seam', '--source', clip, '--output', output, '--fade', '1']).code).toBe(1)
  })

  test('--keyframe-interval puts a keyframe every N frames for scroll scrubbing', () => {
    const output = join(dir, 'scrub.mp4')
    const args = ['encode', '--source', clip, '--output', output, '--keyframe-interval', '5', '--no-audio']
    expect(runSkill('process-video', args).code).toBe(0)
    const keyframes = spawnSync([
      'ffprobe',
      '-v',
      'error',
      '-skip_frame',
      'nokey',
      '-count_frames',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=nb_read_frames',
      '-of',
      'csv=p=0',
      output,
    ])
    // 50 frames, a keyframe every 5; x264 scene detection could only add more, never fewer.
    expect(Number(keyframes.stdout.toString().trim())).toBeGreaterThanOrEqual(10)
  })

  const frameCount = (path: string) =>
    spawnSync([
      'ffprobe',
      '-v',
      'error',
      '-count_frames',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=nb_read_frames',
      '-of',
      'csv=p=0',
      path,
    ])
      .stdout.toString()
      .trim()

  test('frames exports a numbered sequence with a manifest and refuses to mix with old frames', async () => {
    const out = join(dir, 'seq')
    const args = ['frames', '--source', clip, '--output-dir', out, '--count', '10', '--width', '160']
    expect(runSkill('process-video', args).code).toBe(0)
    const manifest = await file(join(out, 'frames.json')).json()
    expect(manifest).toMatchObject({ count: 10, width: 160, height: 120, first: 'frame_0001.webp' })
    expect(await file(join(out, 'frame_0010.webp')).exists()).toBe(true)
    expect(runSkill('process-video', args).code).toBe(1)
  })

  test('reverse --pingpong does not repeat the turning frames; concat --chained drops the shared frame', () => {
    const pingpong = join(dir, 'pingpong.mp4')
    expect(runSkill('process-video', ['reverse', '--source', clip, '--output', pingpong, '--pingpong']).code).toBe(0)
    expect(frameCount(pingpong)).toBe('98')
    const joined = join(dir, 'joined.mp4')
    const args = ['concat', '--source', clip, '--source', clip, '--output', joined, '--chained']
    expect(runSkill('process-video', args).code).toBe(0)
    expect(frameCount(joined)).toBe('99')
  })

  test('sheet maps its tiles to frames, and motion finds a hard cut', () => {
    const sheet = join(dir, 'sheet.png')
    const result = runSkill('process-video', ['sheet', '--source', clip, '--output', sheet, '--count', '4'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('frame 0 (0.00s), frame 16 (0.64s), frame 33 (1.32s), frame 49 (1.96s)')

    const cut = join(dir, 'cut.mp4')
    const lavfi = ['testsrc=duration=1:size=320x240:rate=25', 'color=c=red:duration=1:size=320x240:rate=25']
    const make = spawnSync([
      'ffmpeg',
      '-v',
      'error',
      ...lavfi.flatMap(l => ['-f', 'lavfi', '-i', l]),
      '-filter_complex',
      '[0][1]concat=n=2:v=1:a=0',
      '-pix_fmt',
      'yuv420p',
      cut,
    ])
    expect(make.exitCode).toBe(0)
    const motion = runSkill('process-video', ['motion', '--source', cut])
    expect(motion.code).toBe(0)
    expect(motion.stdout).toContain('frame 25 at 1.00s')
  })

  test('frames --even skips stretches where nothing changes', async () => {
    const still = join(dir, 'still-then-move.mp4')
    const lavfi = ['color=c=gray:duration=1:size=320x240:rate=25', 'testsrc=duration=1:size=320x240:rate=25']
    const make = spawnSync([
      'ffmpeg',
      '-v',
      'error',
      ...lavfi.flatMap(l => ['-f', 'lavfi', '-i', l]),
      '-filter_complex',
      '[0][1]concat=n=2:v=1:a=0',
      '-pix_fmt',
      'yuv420p',
      still,
    ])
    expect(make.exitCode).toBe(0)
    const out = join(dir, 'even')
    const args = ['frames', '--source', still, '--output-dir', out, '--count', '8', '--even']
    expect(runSkill('process-video', args).code).toBe(0)
    const { sourceFrames } = (await file(join(out, 'frames.json')).json()) as { sourceFrames: number[] }
    // The first pick is the start; every later one lands in the moving second half.
    expect(sourceFrames.slice(1).every(n => n >= 24)).toBe(true)
  })

  test('h264 is refused for a WebM container', () => {
    expect(
      runSkill('process-video', ['encode', '--source', clip, '--output', join(dir, 'x.webm'), '--codec', 'h264']).code,
    ).toBe(1)
  })
})
