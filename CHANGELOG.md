# Changelog

All notable changes to this plugin are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-11-08

First public release.

### Added

- **`generate-image`** — `generate`, `edit` and `remove-background` through fal.ai: GPT Image 2.5
  (default, quality tiers from ~$0.005 to ~$0.21) or Nano Banana 2.1 (1K/2K/4K), with model guidance
  by use case and an explicit `--model` when the user names one. Background removal with Bria RMBG
  2.0, `--keep` to say what the cutout should hold.
- **`generate-svg`** — `generate` (text to real SVG with Recraft V4.1 / V4.1 Pro, brand-color control)
  and `vectorize` (raster to SVG, fitted locally to the API's size limits).
- **`generate-video`** — `generate`, `animate`, `transition`, `loop` with MiniMax H3 Max (default),
  Kling 4 or Seedance 2.5, `keyframes` (up to 10 stills in order, Kling 4), and `extend` with Veo 3.1.
  Guidance on writing prompts that actually produce motion and on measuring it, so seamless hero loops
  don't come back frozen, and on planning media for scroll- and cursor-driven pages.
- **`process-image`** — offline `info`, `resize`, `convert` (JPEG/PNG/WebP, plus AVIF/HEIC where the OS
  has the codec), `rotate`, `flip`, `adjust` and `placeholder` (blur-up data URI) on Bun's native
  image API. SVG sources are rendered with resvg, so a generated logo becomes a PNG or favicon.
- **`process-video`** — offline `info`, `poster`, `encode` (VP9/AV1/H.264, `--keyframe-interval` for
  scrubbed video), `trim`, `strip-audio`, `loop-seam` (blends a loop's tail into its head so it wraps
  without a jump), `frames` (image sequence plus manifest for canvas scroll/cursor
  animation, `--even` to pace it by measured change), `reverse` (`--pingpong`), `concat` (`--chained`),
  `sheet` (contact sheet) and `motion` (per-second change timeline that shows frozen clips, uneven
  speed and cuts) through ffmpeg.
- The fal.ai API key is read from `FAL_KEY`.
- `resume --model <key> --request-id <id>` in every generation skill: the request ID is printed as
  soon as fal.ai accepts a job, so a paid result survives a failed download or an interrupted run.
- Every argument is validated before a paid call, and every downloaded or rendered file is checked
  before the command reports success.
