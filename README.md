# claude-media-generation

Image, SVG and video generation for Claude Code. Claude can't generate images on its own, and this
plugin adds that. Ask for a hero image, an SVG logo or a looping background video, and Claude Code
writes the file into your project. Generation runs on fal.ai (GPT Image 2.5, Nano Banana 2.1, Recraft,
MiniMax H3 Max, Kling, Seedance, Veo); resizing, conversion and compression run locally, so the result is ready to ship.

<img width="960" alt="Claude Code on the left generates a looping hero video and an SVG logo from one prompt; the coffee shop page on the right fills in as the files arrive" src="https://github.com/user-attachments/assets/6243e8c4-3003-4da8-b7a1-cba295910f29" />

| Skill | What it does |
| --- | --- |
| `generate-image` | Generate images from a prompt with GPT Image 2.5 or Nano Banana 2.1, edit an existing image, remove backgrounds |
| `generate-svg` | Generate real SVG logos, icons and illustrations with Recraft V4.1, vectorize a raster image |
| `generate-video` | Text-to-video, image-to-video, transitions, multi-keyframe clips and seamless loops with MiniMax H3 Max, Kling 4 or Seedance 2.5, extend a clip with Veo 3.1 |
| `process-image` | Resize, convert to WebP/AVIF, rotate/flip, adjust colors, blur-up placeholders, PNGs and favicons from SVG. Free and offline |
| `process-video` | Poster frames, WebM/AV1 encodes, compression, trims, seamless loops, frame sequences for scroll and cursor animation, reverse/ping-pong, joins. Free and offline (ffmpeg) |

Three prompts build a whole landing page, with every image, logo and video made by the plugin:

https://github.com/user-attachments/assets/ef9af96a-e7b0-4601-903f-a44cc9d7098e

## Can Claude generate images?

Not by itself. Claude can read images but has no image model, so out of the box Claude Code can't
draw a picture, a logo or a video. This plugin connects it to image and video models on
[fal.ai](https://fal.ai) through five Claude Code skills. You describe what you need; Claude picks
the model, saves the file in your project and optimizes it for the web.

## What you can ask for

You don't have to name a skill: Claude picks one from what you ask, for example:

- "Make a hero image for this landing page": image generation with GPT Image 2.5.
- "Generate it with Nano Banana in 4K": name a model and Claude uses it.
- "Draw an SVG logo in our brand colors": vector paths from Recraft that you can edit in Figma.
- "Turn this hero image into a looping background video": a seamless loop made with MiniMax H3 Max.
- "Make the product come apart as the user scrolls": stills of each state, a keyframed clip, and a
  frame sequence the page draws on a canvas.
- "The character's head should follow the cursor": left, centre and right poses joined into one clip
  that the cursor position scrubs.
- "Remove the background from this product photo": a transparent PNG or WebP cutout.
- "Add a mug to this photo and keep everything else": an instruction-based edit of the same image.
- "Make this smaller and convert it to WebP": offline resizing and conversion with no API cost.
- "Give this video a poster frame and a WebM version": offline post-production with ffmpeg.

## Install

The skills run on [Bun](https://bun.com) 1.4 or later. If you don't have it yet,
[install it first](https://bun.com/docs/installation).

Then install the plugin (Claude Code 2.1.292 or later):

```sh
claude plugin install media-generation --marketplace krowten/claude-media-generation
```

Or in two steps, which also works from the `/plugin` command inside Claude Code:

```sh
claude plugin marketplace add krowten/claude-media-generation
claude plugin install media-generation@krowten
```

Then export your fal.ai key, which you can create at
[fal.ai/dashboard/keys](https://fal.ai/dashboard/keys):

```sh
export FAL_KEY="..."
```

Add that line to your shell profile so new sessions see it: `~/.profile` on Linux, `~/.zprofile` on
macOS (the default zsh doesn't read `~/.profile`). Restart Claude Code afterwards so it picks up the
new environment.

You can skip the key if you only want the local skills. The generation skills then stop with a
message saying the key is missing.

## Requirements

- [Bun](https://bun.com). Every skill is a TypeScript CLI run with `bun`, and Node.js won't work:
  the local skills use Bun's built-in `Bun.Image` API (statically linked codecs, so there is no
  `sharp` to install), and the scripts rely on Bun running `.ts` files directly. Developed and
  tested on Bun 1.4.4. `process-image` checks for `Bun.Image` at startup and tells you to upgrade if
  your Bun is too old.
- A fal.ai API key in `FAL_KEY`, for `generate-image`, `generate-svg` and `generate-video` only. The
  local skills need no key and don't upload your files.
- [ffmpeg](https://ffmpeg.org), for `process-video` and for checking generated video clips (motion,
  loop seams). It isn't bundled; if it's missing, the skill
  prints install instructions for your OS (`sudo apt install ffmpeg`, `brew install ffmpeg`, …).
  Everything else works without it.

The npm dependencies, `@fal-ai/client` and `@resvg/resvg-js` (renders SVG sources in `process-image`),
need no install step because Bun installs missing imports on first run. Run `bun install` in the
plugin directory only if you want them pinned locally or available offline.

## Costs

Everything that goes through fal.ai is pay-per-use and billed to your own key. These are approximate
rates at the time of writing, so check [fal.ai](https://fal.ai/models) for current pricing before
relying on them:

| Operation | Approx. price |
| --- | --- |
| Image with `gpt-image-2.5` (default, `--quality medium`) | ~$0.01 / image (`low` ~$0.005, `high` ~$0.05, `max` ~$0.21) |
| Image with `nano-banana-2.1` | ~$0.04 / image at 1K (~$0.06 at 2K, ~$0.13 at 4K) |
| `remove-background` (Bria RMBG 2.0) | ~$0.018 / image |
| `remove-background --keep` | ~$0.03 / image |
| SVG `generate` (Recraft V4.1) | $0.08 / image |
| SVG `generate --model pro` (Recraft V4.1 Pro) | $0.30 / image |
| `vectorize` (Recraft) | $0.01 / image |
| Video with `h3-max` (default) | ~$0.16 / second at 1080p (~$0.08 at 768p) |
| Video with `kling-4` | ~$0.24 / second at 1080p (~$0.16 at 720p) |
| Video with `seedance-2.5` | ~$1.16 / second at 1080p (~$0.47 at 720p, ~$0.22 at 480p) |
| `extend` (Veo 3.1) | ~$0.10–0.20 / second |

Video is priced per second of output, so a 10-second clip costs twice as much as a 5-second one
however simple the prompt. The skills tell Claude to give an estimate before a batch and to start
with the shortest duration that shows the motion.

`process-image` and `process-video` are free and never leave your machine.

## Notes and limits

- Video generation is slow. A 5 to 10 second clip usually takes 30 seconds to 3 minutes, longer
  when the fal.ai queue is busy. The CLI waits until the file is written, so Claude needs one call and
  no polling.
- Paid results can be recovered. Every generation command prints the request ID as soon as fal.ai accepts
  the job, along with a ready `resume` command. If the download fails or the run is interrupted,
  `resume` fetches the result you already paid for instead of generating it again.
- `extend` needs a public URL because Veo fetches the video itself through Vertex AI. Every fal
  command prints a temporary result URL, so a fresh `generate-video` clip can go straight into `extend`
  if it is 16:9 or 9:16 (Veo doesn't extend 1:1) and 3 to 10 seconds long. The other commands accept
  a local file (sent as a data URI) or a URL.
- What leaves your machine: `generate-image`, `generate-svg` and `generate-video` send your prompts and
  source images to fal.ai, with your `FAL_KEY`. Bun downloads the npm dependencies from the npm registry
  on first use. The plugin has no telemetry. See [SECURITY.md](SECURITY.md) for details.
- Claude keeps work files out of your project: the raw clip as fal.ai returned it, contact sheets and
  previews go in `.media-generation/` (git never sees it), or in `media-generation/` inside your own
  scratch folder if the project has one. The raw clips are worth keeping, since re-encoding one later
  is free and generating it again isn't. Delete the folder whenever you like.
- Text inside generated images and video is unreliable with every diffusion model. `generate-image`
  steers requests for readable text to `gpt-image-2.5` at higher quality, but text that matters
  belongs in HTML on top of the image.
- The generation skills spend real money. None of them has a free tier, and every `generate-image`,
  `generate-svg` or `generate-video` call bills your key.

## Not covered yet

Icon libraries (Lucide, Heroicons as inline SVG), cropping and compositing for Open Graph images,
upscaling, stock photography and site screenshots. Ideas and pull requests are welcome.

## Skill reference

These are the CLIs Claude runs. You rarely need them directly, but they list every option.

### `generate-image`: AI image generation, editing and background removal

Generates and edits raster images with GPT Image 2.5 (the default) or Nano Banana 2.1, and removes
backgrounds with Bria RMBG 2.0.

```sh
generate-image.ts generate --prompt "<description>" --output <path>
  [--model gpt-image-2.5|nano-banana-2.1] [--aspect-ratio 1:1|2:3|3:2|3:4|4:3|4:5|5:4|9:16|16:9|21:9]
  [--quality low|medium|high|xhigh|max] [--resolution 1K|2K|4K] [--remove-background]
  [--format jpeg|png|webp] [--output-quality 1-100] [--max-width N]

generate-image.ts edit --prompt "<what to change>" --output <path>
  (--source <path> | --image-url <url>) [--model gpt-image-2.5|nano-banana-2.1]
  [--quality …] [--resolution …] [--no-match-source-size] [--format jpeg|png|webp] [--output-quality 1-100]

generate-image.ts remove-background --output <path>.png|.webp
  (--source <path> | --image-url <url>) [--format png|webp] [--output-quality 1-100] [--max-width N]
  [--keep "<what to keep>"]

generate-image.ts resume --model <key> --request-id <id> --output <path>
```

The output extension (`.jpg`, `.png`, `.webp`) sets the encoding, and `--format`, if given, has to
match it. `--quality` works with `gpt-image-2.5` only and `--resolution` with `nano-banana-2.1`
only; passing either to the other model is an error. GPT Image 2.5 is the top-ranked model for
generation and editing and costs about a cent per image at medium quality; Nano Banana 2.1 is the
choice for 2K/4K output and for keeping one character or product consistent across images.

`remove-background` works on any existing photo, people included. When a picture has several
subjects, `--keep "only the woman on the left"` tells the model in plain words what to cut out.

Use `edit` for a before/after of the same image. `generate` draws a new subject every time, so two
generations never share a face, product or scene.

### `generate-svg`: SVG logo, icon and illustration generation

Recraft V4.1 produces real SVG with editable paths and layers that go straight into HTML, Figma or
Illustrator. Use it for logos, icons, favicons and flat illustrations that have to stay sharp at any
size.

```sh
generate-svg.ts generate --prompt "<description>" --output <path>.svg
  [--model standard|pro] [--size square_hd|square|portrait_4_3|portrait_16_9|landscape_4_3|landscape_16_9]
  [--width N --height N] [--colors "#RRGGBB,#RRGGBB"] [--background "#RRGGBB"]

generate-svg.ts vectorize (--source <path> | --image-url <url>) --output <path>.svg

generate-svg.ts resume --model <key> --request-id <id> --output <path>.svg
```

`--colors` pins the palette to your brand's hex values, which works far better than describing
colors in the prompt. `vectorize` turns an existing raster into SVG paths. Keep it for flat graphic
content: photos trace into SVGs of several megabytes that look worse than the original.

### `generate-video`: AI video generation and seamless loops

MiniMax H3 Max (the default), Kling 4 or Seedance 2.5 handles text-to-video, image-to-video,
transitions and loops; Kling 4 also passes through up to 10 keyframes in order; Veo 3.1 extends an
existing clip.

```sh
generate-video.ts generate   --prompt "<description>" --output <path>.mp4
generate-video.ts animate    --prompt "<motion>" --source <image> --output <path>.mp4
generate-video.ts transition --prompt "<how it morphs>" --from <image> --to <image> --output <path>.mp4
generate-video.ts loop       --prompt "<continuous motion>" --source <image> --output <path>.mp4
generate-video.ts keyframes  --prompt "<how it moves>" --frame <a> --frame <b> --frame <c> [...] --output <path>.mp4
generate-video.ts extend     --prompt "<what happens next>" --source <public-video-url> --output <path>.mp4
generate-video.ts resume     --model <key> --request-id <id> --output <path>.mp4
```

Shared flags are `[--model h3-max|kling-4|seedance-2.5] [--duration N] [--resolution …]`, and
`generate` also takes `--aspect-ratio`. H3 Max makes 1–15 s at 480p/768p/1080p and tops the image-to-video
ranking for clips without audio; Kling 4 makes 3–30 s at 720p/1080p and is the one that takes
keyframes; Seedance 2.5 makes 4–30 s continuous camera moves and tops the ranking for clips with
audio, at several times the price. Resolution defaults to 1080p (720p for Seedance). `extend` uses
Veo 3.1, which only offers a 7-second continuation at 720p. With Kling 4, local frames must be at
least 300×300 px with an aspect ratio between 2:5 and 5:2.

`loop` uses the same frame as the start and the end, so the clip repeats in `<video loop>` without a
visible cut. That makes it the command for hero backgrounds. Describe motion that is clearly
visible and cyclical (thick steam, a turning wheel, swaying light) and keep only the camera static:
prompts like "everything else stays still" make models return an almost frozen clip. The skill tells
Claude to measure the motion afterwards instead of trusting a couple of frames, and to pass the clip
through `process-video loop-seam`, because even a start=end clip ends slightly off its first frame.

For pages driven by the scroll or the cursor, the skill has Claude make every state as a consistent
still first, join them with `transition` or `keyframes` at constant speed with a static camera, and
then export a frame sequence with `process-video frames`.

H3 Max always adds a quiet generated soundtrack, Kling 4 clips are silent and Seedance's soundtrack
is turned off; `process-video` drops the audio for the page (`loop-seam` does it on the way). Veo `extend` adds audio only with `--audio`.

### `process-image`: resize, convert to WebP/AVIF, placeholders

Local, offline and free. Use it when the job is to change an existing file, not to create new
pixels.

```sh
process-image.ts info        --source <path>
process-image.ts resize      --source <path> --output <path> --width N [--height N] [--fit inside|fill] [--quality 1-100]
process-image.ts convert     --source <path> --output <path> --format jpeg|png|webp|avif|heic [--quality 1-100]
process-image.ts rotate      --source <path> --output <path> --degrees 90|180|270
process-image.ts flip        --source <path> --output <path> [--axis horizontal|vertical]
process-image.ts adjust      --source <path> --output <path> [--brightness N] [--saturation N]
process-image.ts placeholder --source <path>
```

`placeholder` prints a small blurred data URI for the blur-up loading pattern.

An `.svg` source is rendered to pixels first, so `resize --source logo.svg --output favicon.png --width 64`
makes a sharp favicon from a generated logo.

JPEG, PNG and WebP behave the same on every system. HEIC and AVIF (and TIFF input) use the operating
system's codecs, so support depends on the machine:

| | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Read HEIC/AVIF | no | yes (macOS 13+) | with the HEIF / AV1 extensions from the Microsoft Store |
| Write HEIC | no | yes | with the HEIF extension |
| Write AVIF | no | Apple M3 or newer only | with the AV1 extension |

When a codec is missing, the script says so and suggests WebP.

There's no need to chain `generate-image generate` and `process-image convert`: the generation commands
take `--format`, `--output-quality` and `--max-width` themselves.

### `process-video`: poster frames, WebM encodes, seamless loops, scroll frame sequences

The post-production half of the video pipeline, using local ffmpeg at no cost. A generated MP4 is a
master file. Before it goes on a page it usually needs a poster frame, a WebM version (30 to 50%
smaller) and sometimes a trim.

```sh
process-video.ts info        --source <path>
process-video.ts poster      --source <video> --output <path>.jpg|.png|.webp [--time SEC]
process-video.ts encode      --source <video> --output <path>.webm|.mp4 [--codec vp9|av1|h264] [--crf N] [--width N] [--fps N] [--keyframe-interval N] [--no-audio]
process-video.ts trim        --source <video> --output <path> --start SEC (--duration SEC | --end SEC) [--copy]
process-video.ts strip-audio --source <video> --output <path>
process-video.ts loop-seam   --source <video> --output <path>.webm|.mp4 [--fade SEC] [--crf N]
process-video.ts frames      --source <video> --output-dir <dir> [--fps N | --count N] [--start SEC] [--end SEC] [--width N] [--format webp|jpg] [--quality 1-100] [--even]
process-video.ts reverse     --source <video> --output <path> [--pingpong]
process-video.ts concat      --source <a> --source <b> [...] --output <path> [--chained]
process-video.ts sheet       --source <video> --output <path>.png|.jpg|.webp [--count 12] [--columns 4] [--width 320] [--start SEC] [--end SEC] [--crop w:h:x:y]
process-video.ts motion      --source <video> [--crop w:h:x:y]
```

The output extension picks the codec (`.webm` for VP9, `.mp4` for H.264), each with a sensible CRF.
`--width` only shrinks a video, never enlarges it, and is rounded down to an even number because web
codecs require one. `trim` re-encodes for a frame-accurate cut by default; `--copy` is instant and
lossless but can only cut on keyframes. Each result is checked before it replaces the output file,
so a poster time or trim range past the end of the clip fails with an error.

`loop-seam` fixes the jump where a generated loop repeats: it blends the last half second into the
first, so the clip ends on the frame right before the one it starts on.

`frames` turns a clip into a numbered WebP or JPEG sequence plus a `frames.json` manifest: the format
behind pages where scrolling or the cursor drives the animation, drawn frame by frame on a `<canvas>`.
`--even` picks the frames by measured change instead of time, so a clip that eases in and out still
moves the same amount for every bit of scrolling.
For a page that scrubs a `<video>` directly, `encode --keyframe-interval 5` makes seeking smooth.
`reverse --pingpong` turns a one-way movement (a head turning, a product rotating) into a clip that
loops, and `concat --chained` joins clips generated end-frame-to-start-frame into one journey.
`sheet` and `motion` are how Claude checks a generated clip: a grid of frames to look at, and a
per-second timeline of how much each frame changes, which shows frozen clips, uneven speed and cuts.

## Development

```sh
bun install
bun run check   # prettier, tsc and the test suite
```

The tests run every skill script for real with the fal.ai SDK and downloads mocked, so they cost
nothing and need no API key. The `process-video` tests run only when `ffmpeg` is on `PATH`.

`evals/` holds routing evals for `claude plugin eval`: realistic requests, each graded on whether
Claude picked the right skill and command. Every run is a real Claude session billed to your plan.
Clear `FAL_KEY` for the run so no case can spend fal.ai credit:

```sh
FAL_KEY= claude plugin eval . --allow-tools Bash --max-cost-usd 5
```

Contributions are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see
[SECURITY.md](SECURITY.md).

## License

MIT, see [LICENSE](LICENSE).
