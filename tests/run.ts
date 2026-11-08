import { tmpdir } from 'node:os'
import { spawnSync } from 'bun'

const root = new URL('..', import.meta.url).pathname
const mockProvider = `${root}tests/mock-provider.ts`

// A 1x1 PNG inlined so the plugin ships no binary test fixture.
export const pixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGElEQVR4nGP8z8Dwn4GBgYGRAcT4z8AAACcGA/+V7GS1AAAAAElFTkSuQmCC',
  'base64',
)

export type RunResult = { code: number; stdout: string; stderr: string }

// Runs a skill script the way Claude does, with the generation SDK mocked out for generate-* skills.
export function runSkill(skill: string, args: string[], env: Record<string, string> = {}): RunResult {
  const preload = skill.startsWith('generate-') ? ['--preload', mockProvider] : []
  const proc = spawnSync(['bun', ...preload, `${root}skills/${skill}/scripts/${skill}.ts`, ...args], {
    // Relative --output paths in the tests land in the temp dir, never in the repository.
    cwd: tmpdir(),
    env: { ...process.env, FAL_KEY: 'test-key', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}
