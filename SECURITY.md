# Security policy

## Reporting a vulnerability

Please don't open a public issue. Report it privately through
[GitHub's security advisories](https://github.com/krowten/claude-media-generation/security/advisories/new)
or by email to me@krowten.dev, with the steps to reproduce it and the version you tested. I aim to reply
within a week.

Only the latest release gets security fixes.

## What the plugin does with your data

- `FAL_KEY` is read from the environment. The plugin doesn't write it to disk or print it, and sends it
  only to fal.ai.
- `generate-image`, `generate-svg` and `generate-video` send your prompts and source images to fal.ai
  and the model provider behind the endpoint you use. Results are served from temporary fal.ai URLs that
  anyone holding the link can open.
- `process-image` and `process-video` work on local files and don't upload them. Bun downloads the npm
  dependencies the first time a script needs them.
- Generated and vectorized SVGs are checked before saving. A file with scripts, event handlers,
  `foreignObject` or external links is rejected.
- The plugin has no telemetry.

## Scope

In scope: leaks of `FAL_KEY`, ways around the SVG check, and command or path injection through script
arguments.

Out of scope: what a model generates, charges on your own fal.ai account, and bugs in fal.ai, Bun or
ffmpeg, which belong with those projects.
