#!/usr/bin/env bun
// CLI for local video processing via ffmpeg — the post-production step after
// `generate-video` creates a clip: poster frames, web encodes, trims, audio removal, loop seams.
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { file, Glob, spawnSync, which, write } from 'bun'

import { exitOnError, fail, intArg, numberArg, oneOf } from '../../../lib/cli'

const CODECS = ['vp9', 'av1', 'h264'] as const
type Codec = (typeof CODECS)[number]

function requireTool(name: 'ffmpeg' | 'ffprobe'): string {
  const path = which(name)
  if (!path)
    fail(
      `${name} is not installed (or not in PATH). Install it and retry:\n` +
        '  Debian/Ubuntu:  sudo apt install ffmpeg\n' +
        '  Fedora:         sudo dnf install ffmpeg\n' +
        '  macOS:          brew install ffmpeg\n' +
        '  Windows:        winget install ffmpeg',
    )
  return path
}

async function requireSource(sourcePath: string): Promise<void> {
  if (!(await file(sourcePath).exists())) fail(`Source file not found: ${sourcePath}`)
}

function run(tool: string, args: string[], onFailure?: () => void): string {
  const proc = spawnSync([tool, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (proc.exitCode !== 0) {
    onFailure?.()
    // ffmpeg logs everything to stderr; on failure the useful part is the tail.
    const stderr = proc.stderr.toString().trim().split('\n').slice(-8).join('\n')
    fail(`${tool} exited with code ${proc.exitCode}:\n${stderr}`)
  }
  return proc.stdout.toString()
}

type ProbeStream = { codec_type: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string }
type Probe = { format: { format_name: string; duration?: string }; streams: ProbeStream[] }

function probe(path: string): Probe {
  return JSON.parse(
    run(requireTool('ffprobe'), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path]),
  ) as Probe
}

// Exact frame count and rate; -count_frames decodes the whole clip, fine for short loops.
function countFrames(path: string): { frames: number; rate: number; rateText: string } {
  const [stream] = (
    JSON.parse(
      run(requireTool('ffprobe'), [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-count_frames',
        '-show_entries',
        'stream=r_frame_rate,nb_read_frames',
        '-of',
        'json',
        path,
      ]),
    ) as { streams: { r_frame_rate: string; nb_read_frames: string }[] }
  ).streams
  if (!stream) fail(`${path} has no video stream`)
  const [num = 0, den = 1] = stream.r_frame_rate.split('/').map(Number)
  return { frames: Number(stream.nb_read_frames), rate: num / den, rateText: stream.r_frame_rate }
}

// ffmpeg can exit 0 without writing a single frame (e.g. a start time past the end of the clip),
// and on failure an older file at the output path would pass for the new one. So render to a temp
// file next to the output, check it has a video stream, and only then move it into place.
async function render(source: string, args: string[], outputPath: string, action: string): Promise<void> {
  await mkdir(dirname(outputPath) || '.', { recursive: true })
  const temp = join(dirname(outputPath), `.tmp-${process.pid}-${basename(outputPath)}`)
  const cleanup = () => rmSync(temp, { force: true })
  run(requireTool('ffmpeg'), ['-y', ...args, temp], cleanup)

  const written = (await file(temp).exists()) ? probe(temp) : undefined
  if (!written?.streams.some(s => s.codec_type === 'video' && s.width)) {
    cleanup()
    fail(
      `ffmpeg produced no video frames. Check the requested time range against the source duration (${probe(source).format.duration ?? 'unknown'}s).`,
    )
  }
  await rename(temp, outputPath)

  const bytes = file(outputPath).size
  const size = bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)}MB` : `${Math.round(bytes / 1024)}KB`
  console.log(`${action} ${outputPath} (${size})`)
}

// 1 - SSIM for each frame pair the graph feeds as [a] and [b], from two copies of the source.
async function ssimSeries(source: string, graph: string): Promise<number[]> {
  const dir = await mkdtemp(join(tmpdir(), 'process-video-ssim-'))
  try {
    const stats = join(dir, 'ssim.txt')
    run(requireTool('ffmpeg'), [
      '-v',
      'error',
      '-i',
      source,
      '-i',
      source,
      '-filter_complex',
      `${graph};[a][b]ssim=stats_file=${stats}:shortest=1`,
      '-f',
      'null',
      '-',
    ])
    return ((await file(stats).text()).match(/All:[\d.]+/g) ?? []).map(m => 1 - Number(m.slice(4)))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Entry i is the change from frame i to frame i+1.
const frameSteps = (source: string, crop = '') =>
  ssimSeries(source, `[0:v]trim=start_frame=1,setpts=PTS-STARTPTS${crop}[a];[1:v]null${crop}[b]`)

function codecFromPath(path: string): Codec {
  return path.toLowerCase().endsWith('.webm') ? 'vp9' : 'h264'
}

// WebM holds only VP8/VP9/AV1; MP4 has no standard mapping for VP9 that browsers rely on.
function checkContainer(codec: Codec, outputPath: string): void {
  const ext = outputPath.split('.').pop()?.toLowerCase()
  if (ext === 'webm' && codec === 'h264')
    fail('h264 cannot go in a .webm container — use vp9 or av1, or an .mp4 output')
  if (ext === 'mp4' && codec === 'vp9') fail('vp9 belongs in a .webm container — for an .mp4 output use h264 or av1')
}

// Every codec gets a visually-comparable default CRF (the scales differ per encoder).
const CODEC_ARGS: Record<
  Codec,
  { defaultCrf: number; maxCrf: number; video: (crf: number) => string[]; audio: string[] }
> = {
  vp9: {
    defaultCrf: 32,
    maxCrf: 63,
    video: crf => ['-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-row-mt', '1', '-pix_fmt', 'yuv420p'],
    audio: ['-c:a', 'libopus', '-b:a', '96k'],
  },
  av1: {
    defaultCrf: 35,
    maxCrf: 63,
    video: crf => ['-c:v', 'libsvtav1', '-crf', String(crf), '-preset', '6', '-pix_fmt', 'yuv420p'],
    audio: ['-c:a', 'libopus', '-b:a', '96k'],
  },
  h264: {
    defaultCrf: 23,
    maxCrf: 51,
    video: crf => [
      '-c:v',
      'libx264',
      '-crf',
      String(crf),
      '-preset',
      'slow',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
    ],
    audio: ['-c:a', 'aac', '-b:a', '128k'],
  },
}

function encodeArgs(opts: {
  codec: Codec
  crf?: number
  width?: number
  fps?: number
  keyframeInterval?: number
  noAudio: boolean
}): string[] {
  const spec = CODEC_ARGS[opts.codec]
  if (opts.crf !== undefined && opts.crf > spec.maxCrf) fail(`--crf for ${opts.codec} goes up to ${spec.maxCrf}`)
  const filters: string[] = []
  // yuv420p needs even dimensions: -2 keeps the height even, the width is evened by the caller.
  // min(iw, …) never upscales — enlarging a clip only adds bytes, not detail.
  if (opts.width) filters.push(`scale=w='min(iw,${opts.width})':h=-2`)
  if (opts.fps) filters.push(`fps=${opts.fps}`)
  return [
    ...(filters.length ? ['-vf', filters.join(',')] : []),
    ...spec.video(opts.crf ?? spec.defaultCrf),
    // A browser can only show a frame by decoding from the keyframe before it, so a video whose
    // currentTime follows the scroll stutters unless keyframes come every few frames.
    ...(opts.keyframeInterval
      ? ['-g', String(opts.keyframeInterval), '-keyint_min', String(opts.keyframeInterval)]
      : []),
    ...(opts.noAudio ? ['-an'] : spec.audio),
  ]
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)

  if (command === 'info') {
    const { values } = parseArgs({ args: rest, options: { source: { type: 'string' } } })
    if (!values.source) fail('info requires --source')
    await requireSource(values.source)

    const info = probe(values.source)
    const video = info.streams.find(s => s.codec_type === 'video')
    const audio = info.streams.find(s => s.codec_type === 'audio')
    const duration = info.format.duration ? `${Number(info.format.duration).toFixed(2)}s` : 'unknown'
    // ffprobe reports frame rates as a fraction, e.g. "30000/1001".
    const [frames = 0, seconds = 0] = (video?.avg_frame_rate ?? '').split('/').map(Number)
    const fps = seconds ? ` @ ${(frames / seconds).toFixed(2)}fps` : ''
    const sizeMB = (file(values.source).size / (1024 * 1024)).toFixed(2)
    console.log(
      [
        `Video: ${values.source}`,
        `Container: ${info.format.format_name}`,
        `Duration: ${duration}`,
        `Video: ${video ? `${video.codec_name} ${video.width}x${video.height}${fps}` : 'none'}`,
        `Audio: ${audio ? audio.codec_name : 'none'}`,
        `Size: ${sizeMB}MB`,
      ].join('\n'),
    )
    return
  }

  if (command === 'poster') {
    const { values } = parseArgs({
      args: rest,
      options: {
        source: { type: 'string' },
        output: { type: 'string' },
        time: { type: 'string', default: '0' },
      },
    })
    if (!values.source || !values.output) fail('poster requires --source and --output')
    numberArg('time', values.time, 0, Number.MAX_SAFE_INTEGER)
    await requireSource(values.source)

    const args = ['-ss', values.time, '-i', values.source, '-frames:v', '1', '-q:v', '2', '-update', '1']
    await render(values.source, args, values.output, 'Poster frame saved to')
    return
  }

  if (command === 'encode') {
    const { values } = parseArgs({
      args: rest,
      options: {
        source: { type: 'string' },
        output: { type: 'string' },
        codec: { type: 'string' },
        crf: { type: 'string' },
        width: { type: 'string' },
        fps: { type: 'string' },
        'keyframe-interval': { type: 'string' },
        'no-audio': { type: 'boolean', default: false },
      },
    })
    if (!values.source || !values.output) fail('encode requires --source and --output')
    const codec = values.codec ? oneOf('codec', values.codec, CODECS) : codecFromPath(values.output)
    checkContainer(codec, values.output)
    const crf = intArg('crf', values.crf, 0, 63)
    const fps = numberArg('fps', values.fps, 1, 240)
    const keyframeInterval = intArg('keyframe-interval', values['keyframe-interval'], 1, 600)
    let width = intArg('width', values.width, 2, 16384)
    if (width && width % 2) {
      width -= 1
      console.error(`Note: --width ${values.width} rounded down to ${width} — web codecs need even dimensions`)
    }
    await requireSource(values.source)

    const args = encodeArgs({ codec, crf, width, fps, keyframeInterval, noAudio: values['no-audio'] })
    await render(values.source, ['-i', values.source, ...args], values.output, 'Encoded video saved to')
    return
  }

  if (command === 'trim') {
    const { values } = parseArgs({
      args: rest,
      options: {
        source: { type: 'string' },
        output: { type: 'string' },
        start: { type: 'string', default: '0' },
        end: { type: 'string' },
        duration: { type: 'string' },
        copy: { type: 'boolean', default: false },
      },
    })
    if (!values.source || !values.output) fail('trim requires --source and --output')
    if (!values.end && !values.duration) fail('trim requires --end or --duration (seconds)')
    if (values.end && values.duration) fail('trim takes --end or --duration, not both')
    const start = numberArg('start', values.start, 0, Number.MAX_SAFE_INTEGER)!
    const end = numberArg('end', values.end, 0, Number.MAX_SAFE_INTEGER)
    numberArg('duration', values.duration, 0, Number.MAX_SAFE_INTEGER)
    await requireSource(values.source)

    const duration = values.duration ?? String(end! - start)
    if (Number(duration) <= 0) fail(`Nothing to trim: computed duration is ${duration}s`)

    // Default is a frame-accurate re-encode in the codec the output extension implies;
    // --copy is instant and lossless but can only cut on keyframes, so the
    // start point may shift by up to a couple of seconds.
    const codecArgs = values.copy
      ? ['-c', 'copy']
      : encodeArgs({ codec: codecFromPath(values.output), crf: undefined, noAudio: false })
    const args = ['-ss', values.start, '-i', values.source, '-t', duration, ...codecArgs]
    await render(values.source, args, values.output, 'Trimmed video saved to')
    return
  }

  if (command === 'strip-audio') {
    const { values } = parseArgs({
      args: rest,
      options: { source: { type: 'string' }, output: { type: 'string' } },
    })
    if (!values.source || !values.output) fail('strip-audio requires --source and --output')
    await requireSource(values.source)

    await render(values.source, ['-i', values.source, '-c', 'copy', '-an'], values.output, 'Audio-free video saved to')
    return
  }

  if (command === 'loop-seam') {
    // Generated loops end close to their first frame, not on it, so the wrap jumps. Blend the last
    // --fade seconds into the first ones: the result starts on source frame k and ends exactly on
    // frame k-1, so the wrap joins two consecutive source frames.
    const { values } = parseArgs({
      args: rest,
      options: {
        source: { type: 'string' },
        output: { type: 'string' },
        fade: { type: 'string', default: '0.5' },
        crf: { type: 'string' },
      },
    })
    if (!values.source || !values.output) fail('loop-seam requires --source and --output')
    const fade = numberArg('fade', values.fade, 0.01, 10)!
    const crf = intArg('crf', values.crf, 0, 63)
    await requireSource(values.source)

    const { frames, rate, rateText } = countFrames(values.source)
    const k = Math.max(1, Math.round(fade * rate))
    if (frames <= 2 * k)
      fail(`--fade ${fade}s is ${k} frames but the clip has only ${frames}; use a fade under half the clip`)
    const filter = [
      '[0:v]split=3[a][b][c]',
      `[a]trim=start_frame=${k}:end_frame=${frames - k},setpts=PTS-STARTPTS[mid]`,
      `[b]trim=start_frame=${frames - k},setpts=PTS-STARTPTS[tail]`,
      `[c]trim=end_frame=${k},setpts=PTS-STARTPTS[head]`,
      // N counts blended frames from 0, so the last one is 100% head, i.e. source frame k-1.
      `[tail][head]blend=all_expr='A+(B-A)*(N+1)/${k}'[mix]`,
      '[mid][mix]concat=n=2:v=1:a=0',
    ].join(';')
    // A looping background has no use for audio, which could not loop cleanly anyway.
    const args = encodeArgs({ codec: codecFromPath(values.output), crf, noAudio: true })
    // Without -r the graph's output defaults to 25 fps and ffmpeg pads a 24 fps clip with duplicates.
    await render(
      values.source,
      ['-i', values.source, '-filter_complex', filter, '-r', rateText, ...args],
      values.output,
      'Seamless loop saved to',
    )
    console.log(`Blended the last ${k} frames into the first ${k}; ${frames - k} of ${frames} frames kept`)
    return
  }

  if (command === 'frames') {
    // Scroll- and cursor-driven animations draw one image per step on a <canvas>; this slices a clip
    // into that numbered image sequence plus a small manifest the page code can read.
    const { values } = parseArgs({
      args: rest,
      options: {
        source: { type: 'string' },
        'output-dir': { type: 'string' },
        fps: { type: 'string' },
        count: { type: 'string' },
        start: { type: 'string', default: '0' },
        end: { type: 'string' },
        width: { type: 'string' },
        format: { type: 'string', default: 'webp' },
        quality: { type: 'string', default: '80' },
        prefix: { type: 'string', default: 'frame' },
        even: { type: 'boolean', default: false },
      },
    })
    const dir = values['output-dir']
    if (!values.source || !dir) fail('frames requires --source and --output-dir')
    if (values.fps && values.count) fail('frames takes --fps or --count, not both')
    if (values.even && !values.count) fail('--even picks frames by motion, so it needs --count instead of --fps')
    const format = oneOf('format', values.format, ['webp', 'jpg'] as const)
    const quality = intArg('quality', values.quality, 1, 100)!
    const start = numberArg('start', values.start, 0, Number.MAX_SAFE_INTEGER)!
    const end = numberArg('end', values.end, 0, Number.MAX_SAFE_INTEGER)
    const width = intArg('width', values.width, 2, 16384)
    const count = intArg('count', values.count, 1, 10000)
    if (!/^[\w-]+$/.test(values.prefix)) fail('--prefix may only contain letters, digits, - and _')
    await requireSource(values.source)

    const pattern = `${values.prefix}_*.${format}`
    // Frames left over from an earlier, longer run would silently extend the new sequence.
    await mkdir(dir, { recursive: true })
    if ([...new Glob(pattern).scanSync(dir)].length)
      fail(`${dir} already holds ${pattern} files; pick an empty directory or delete them first`)

    const duration = Number(probe(values.source).format.duration ?? 0)
    const span = (end ?? duration) - start
    if (span <= 0) fail(`Nothing to export: the range ${start}s–${end ?? duration}s is empty (clip is ${duration}s)`)
    const fps = values.even ? undefined : count ? count / span : numberArg('fps', values.fps, 0.1, 240)
    // --even: models ease in and out, so evenly timed frames bunch the change in the middle of a
    // scroll. Pick frames at equal steps of measured change instead, so each scroll step moves alike.
    let picks: number[] | undefined
    if (values.even) {
      const { rate } = countFrames(values.source)
      const steps = await frameSteps(values.source)
      const firstFrame = Math.round(start * rate)
      const lastFrame = Math.min(steps.length, end === undefined ? steps.length : Math.round(end * rate))
      const cumulative = [0]
      for (let i = firstFrame; i < lastFrame; i++) cumulative.push(cumulative.at(-1)! + steps[i]!)
      const total = cumulative.at(-1)!
      picks = [
        ...new Set(
          Array.from({ length: count! }, (_, k) => {
            const target = count === 1 ? 0 : (k * total) / (count! - 1)
            return firstFrame + cumulative.findIndex(c => c >= target - 1e-9)
          }),
        ),
      ]
    }
    const filters = [
      ...(picks ? [`select='${picks.map(n => `eq(n\\,${n})`).join('+')}'`] : []),
      ...(fps ? [`fps=${fps}`] : []),
      ...(width ? [`scale=w='min(iw,${width})':h=-2`] : []),
    ]
    const codec =
      format === 'webp'
        ? ['-c:v', 'libwebp', '-quality', String(quality)]
        : // mjpeg's -q:v runs from 2 (best) to 31 (worst).
          ['-q:v', String(Math.round(2 + ((100 - quality) * 29) / 100))]
    run(requireTool('ffmpeg'), [
      '-v',
      'error',
      // --even selects by absolute frame number, so it reads the clip from the start.
      ...(picks ? [] : ['-ss', String(start), ...(end !== undefined ? ['-to', String(end)] : [])]),
      '-i',
      values.source,
      ...(filters.length ? ['-vf', filters.join(',')] : []),
      ...(picks ? ['-fps_mode', 'vfr'] : []),
      ...(count ? ['-frames:v', String(count)] : []),
      ...codec,
      '-start_number',
      '1',
      join(dir, `${values.prefix}_%04d.${format}`),
    ])

    const names = [...new Glob(pattern).scanSync(dir)].sort()
    if (!names.length) fail(`ffmpeg wrote no frames; check --start/--end against the clip length (${duration}s)`)
    const bytes = names.reduce((sum, name) => sum + file(join(dir, name)).size, 0)
    const first = probe(join(dir, names[0]!)).streams[0]
    const manifest = {
      count: names.length,
      width: first?.width,
      height: first?.height,
      // Evenly paced frames have no fixed rate; the page maps progress to frame index either way.
      fps: picks ? null : (fps ?? countFrames(values.source).rate),
      evenMotion: Boolean(picks),
      ...(picks ? { sourceFrames: picks } : {}),
      pattern: `${values.prefix}_{0000}.${format}`,
      first: names[0],
      last: names.at(-1),
      totalBytes: bytes,
    }
    await write(join(dir, 'frames.json'), JSON.stringify(manifest, null, 2) + '\n')
    console.log(
      `Saved ${names.length} frames to ${dir}/ (${names[0]} … ${names.at(-1)}), ${first?.width}x${first?.height}, ` +
        `${(bytes / (1024 * 1024)).toFixed(1)}MB total, ${Math.round(bytes / names.length / 1024)}KB per frame. Manifest: ${join(dir, 'frames.json')}`,
    )
    return
  }

  if (command === 'reverse') {
    const { values } = parseArgs({
      args: rest,
      options: {
        source: { type: 'string' },
        output: { type: 'string' },
        pingpong: { type: 'boolean', default: false },
        crf: { type: 'string' },
      },
    })
    if (!values.source || !values.output) fail('reverse requires --source and --output')
    const crf = intArg('crf', values.crf, 0, 63)
    await requireSource(values.source)

    const { frames, rateText } = countFrames(values.source)
    if (values.pingpong && frames < 3) fail('--pingpong needs a clip of at least 3 frames')
    // Ping-pong plays forward, then backward without repeating either end frame, so <video loop>
    // turns around smoothly instead of holding a frame twice.
    const filter = values.pingpong
      ? `[0:v]split[f][r];[r]reverse,trim=start_frame=1:end_frame=${frames - 1},setpts=PTS-STARTPTS[b];[f][b]concat=n=2:v=1:a=0`
      : '[0:v]reverse'
    const args = encodeArgs({ codec: codecFromPath(values.output), crf, noAudio: true })
    await render(
      values.source,
      ['-i', values.source, '-filter_complex', filter, '-r', rateText, ...args],
      values.output,
      values.pingpong ? 'Ping-pong clip saved to' : 'Reversed clip saved to',
    )
    return
  }

  if (command === 'concat') {
    const { values } = parseArgs({
      args: rest,
      options: {
        source: { type: 'string', multiple: true },
        output: { type: 'string' },
        chained: { type: 'boolean', default: false },
        crf: { type: 'string' },
      },
    })
    const sources = values.source ?? []
    if (sources.length < 2 || !values.output) fail('concat requires at least two --source flags and --output')
    const crf = intArg('crf', values.crf, 0, 63)
    for (const source of sources) await requireSource(source)

    // Every clip is fitted to the first one's size and frame rate, since concat needs them equal.
    const first = probe(sources[0]!).streams.find(s => s.codec_type === 'video')
    if (!first?.width || !first.height) fail(`${sources[0]} has no video stream`)
    const { rateText } = countFrames(sources[0]!)
    const { width: w, height: h } = first
    const parts = sources.map(
      (_, i) =>
        // --chained: each clip starts on the previous clip's last frame, so that frame would show twice.
        `[${i}:v]${values.chained && i > 0 ? 'trim=start_frame=1,' : ''}setpts=PTS-STARTPTS,` +
        `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${rateText}[v${i}]`,
    )
    const filter = `${parts.join(';')};${sources.map((_, i) => `[v${i}]`).join('')}concat=n=${sources.length}:v=1:a=0`
    const args = encodeArgs({ codec: codecFromPath(values.output), crf, noAudio: true })
    await render(
      sources[0]!,
      [...sources.flatMap(source => ['-i', source]), '-filter_complex', filter, '-r', rateText, ...args],
      values.output,
      `Joined ${sources.length} clips into`,
    )
    return
  }

  if (command === 'sheet') {
    // A grid of evenly spaced frames: the quick way to look at a whole clip in one image.
    const { values } = parseArgs({
      args: rest,
      options: {
        source: { type: 'string' },
        output: { type: 'string' },
        count: { type: 'string', default: '12' },
        columns: { type: 'string', default: '4' },
        width: { type: 'string', default: '320' },
        start: { type: 'string', default: '0' },
        end: { type: 'string' },
        crop: { type: 'string' },
      },
    })
    if (!values.source || !values.output) fail('sheet requires --source and --output')
    const count = intArg('count', values.count, 1, 100)!
    const columns = Math.min(count, intArg('columns', values.columns, 1, 20)!)
    const width = intArg('width', values.width, 16, 4096)!
    const start = numberArg('start', values.start, 0, Number.MAX_SAFE_INTEGER)!
    const end = numberArg('end', values.end, 0, Number.MAX_SAFE_INTEGER)
    if (values.crop && !/^\d+:\d+:\d+:\d+$/.test(values.crop))
      fail('--crop takes w:h:x:y in pixels, e.g. 400:300:100:50')
    await requireSource(values.source)

    const { frames, rate } = countFrames(values.source)
    const firstFrame = Math.min(frames - 1, Math.round(start * rate))
    const lastFrame = end === undefined ? frames - 1 : Math.min(frames - 1, Math.round(end * rate))
    if (lastFrame < firstFrame) fail('--end must come after --start')
    const picks = [
      ...new Set(
        Array.from({ length: count }, (_, i) =>
          Math.round(firstFrame + (count === 1 ? 0 : (i * (lastFrame - firstFrame)) / (count - 1))),
        ),
      ),
    ]
    const filter = [
      `select='${picks.map(n => `eq(n\\,${n})`).join('+')}'`,
      ...(values.crop ? [`crop=${values.crop}`] : []),
      `scale=${width}:-2`,
      `tile=${columns}x${Math.ceil(picks.length / columns)}:padding=4:color=white`,
    ].join(',')
    await render(
      values.source,
      ['-i', values.source, '-vf', filter, '-fps_mode', 'vfr', '-frames:v', '1', '-update', '1'],
      values.output,
      'Contact sheet saved to',
    )
    // A stock ffmpeg build may lack drawtext, so the legend maps tiles to frames instead of labels.
    console.log(
      `Tiles left to right, top to bottom (${columns} per row): ` +
        picks.map(n => `frame ${n} (${(n / rate).toFixed(2)}s)`).join(', '),
    )
    return
  }

  if (command === 'motion') {
    // How much each frame differs from the previous one and from the first, as 1 - SSIM: shows
    // where the motion happens, whether a clip is frozen, and jumps such as cuts or blinks.
    const { values } = parseArgs({
      args: rest,
      options: { source: { type: 'string' }, crop: { type: 'string' } },
    })
    const source = values.source
    if (!source) fail('motion requires --source')
    if (values.crop && !/^\d+:\d+:\d+:\d+$/.test(values.crop))
      fail('--crop takes w:h:x:y in pixels, e.g. 400:300:100:50')
    await requireSource(source)

    const { frames, rate } = countFrames(source)
    if (frames < 2) fail('motion needs a clip of at least two frames')
    const crop = values.crop ? `,crop=${values.crop}` : ''
    const steps = await frameSteps(source, crop)
    const fromFirst = await ssimSeries(
      source,
      `[0:v]null${crop}[a];[1:v]select=eq(n\\,0),loop=-1:1,trim=end_frame=${frames}${crop}[b]`,
    )
    if (!steps.length || !fromFirst.length) fail('ffmpeg returned no SSIM values for this clip')
    const fmt = (v: number) => String(Math.round(v * 1000))
    const perRow = Math.max(1, Math.round(rate))
    console.log(`Change from the previous frame (1 - SSIM, x1000), one row per second:`)
    for (let i = 0; i < steps.length; i += perRow)
      console.log(
        `  ${(i / rate).toFixed(1).padStart(5)}s  ${steps
          .slice(i, i + perRow)
          .map(fmt)
          .join(' ')}`,
      )
    // A cut, blink or glitch stands out against the frames around it, even inside a fast move.
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
    const jumps = steps
      .map((v, i) => ({
        v,
        frame: i + 1,
        around: median([...steps.slice(Math.max(0, i - 4), i), ...steps.slice(i + 1, i + 5)]),
      }))
      .filter(({ v, around }) => v > 0.01 && v > around * 2.5)
      .sort((a, b) => b.v - a.v)
      .slice(0, 8)
    console.log(
      jumps.length
        ? `Spikes over 2.5x the neighbouring frames (cuts, blinks, glitches): ${jumps.map(j => `frame ${j.frame} at ${(j.frame / rate).toFixed(2)}s (${fmt(j.v)})`).join(', ')}`
        : 'No single-frame spikes against the neighbouring frames.',
    )
    const most = Math.max(...fromFirst)
    console.log(
      `Most different from the first frame: ${fmt(most)} at ${(fromFirst.indexOf(most) / rate).toFixed(2)}s; ` +
        `last frame vs first: ${fmt(fromFirst.at(-1)!)}. (Values below ~10 everywhere would mean the clip barely moves.)`,
    )
    return
  }

  fail(
    `Unknown command: ${command ?? '(none)'}. Use info | poster | encode | trim | strip-audio | loop-seam | frames | reverse | concat | sheet | motion`,
  )
}

main().catch(exitOnError)
