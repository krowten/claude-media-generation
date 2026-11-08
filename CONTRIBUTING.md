# Contributing

Bug reports, ideas and pull requests are welcome. For anything bigger than a small fix, open an issue
first so we can agree on the approach before you spend time on it.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go
through [SECURITY.md](SECURITY.md), not public issues.

## Setup

You need [Bun](https://bun.com) 1.4 or later, and [ffmpeg](https://ffmpeg.org) for the `process-video`
tests (they are skipped without it).

```sh
bun install
bun run check   # prettier, tsc and the test suite
```

To try your copy in Claude Code, start it from an empty folder with `claude --plugin-dir <this repo>`.

## Layout

- `skills/<name>/SKILL.md` is what Claude reads. `skills/<name>/scripts/` is the CLI it runs.
- `lib/models.ts` is the only place that knows fal.ai endpoint IDs. `lib/provider.ts` talks to fal.ai.
- `tests/` runs every script for real with the fal.ai SDK and downloads mocked.
- `evals/` holds routing evals for `claude plugin eval`.

## Code

Prettier handles formatting. Beyond that:

- Functions over classes, `type` over `interface`.
- Type imports in their own `import type` statement, above the value imports.
- Use what Bun provides, through named imports (`import { file } from 'bun'`), before reaching for
  `node:*` or an npm package.
- Read environment variables by destructuring `process.env` once, right after the imports.
- Validate every argument before a paid call and check every file before reporting success. A failed run
  must never cost the user a second payment.

## Skills

- The `description` decides when Claude picks a skill, so test any change to it with the evals.
- Write a literal dollar sign before a digit as `\$0.16`. Claude Code replaces `$0` with the skill's
  arguments, and a test fails on an unescaped price.
- Teach a method that works for any project. Don't paste in prompts from one particular result.
- Adding a model: add the endpoint to `lib/models.ts`, its options to the script, a test for the request
  it sends, and a row in both the `SKILL.md` model table and the README cost table.

## Testing a skill change

Tests can't tell you whether Claude follows a `SKILL.md`. Run the change in a fresh session with no
context from your work, phrased the way a user would ask:

```sh
claude -p "<the request>" --plugin-dir <this repo>
```

For routing, run the evals, narrowed to the cases you touched. Clear `FAL_KEY` so they can't spend
credit:

```sh
FAL_KEY= claude plugin eval . --allow-tools Bash --case <name> --max-cost-usd 5
```

Real generation is billed to your own fal.ai key. It isn't required for a pull request; say what you ran
and what you didn't.

## Pull requests

Keep each one to a single change, make sure `bun run check` passes, and add a line to `CHANGELOG.md` if
users will notice the difference.
