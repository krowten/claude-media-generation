import { Glob, file } from 'bun'
import { expect, test } from 'bun:test'

// Claude Code replaces $0, $1… in skill content with the skill's arguments, so a price like $0.16 reaches
// Claude as "<first argument>.16". A literal dollar before a digit must be written \$.
test('SKILL.md files escape every dollar sign before a digit', async () => {
  const unescaped: string[] = []
  for await (const path of new Glob('skills/*/SKILL.md').scan()) {
    const text = await file(path).text()
    for (const match of text.matchAll(/(?<!\\)\$\d[^\s|)]*/g)) unescaped.push(`${path}: ${match[0]}`)
  }
  expect(unescaped).toEqual([])
})
