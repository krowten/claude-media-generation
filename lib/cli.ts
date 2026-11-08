// Argument helpers shared by every skill script. parseArgs hands back raw strings,
// so anything numeric or enumerated is checked here before work (or money) is spent.

export function fail(message: string): never {
  console.error(`Error: ${message}`)
  process.exit(1)
}

export function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) fail(`Unknown --${flag}: ${value}. Use ${allowed.join(' | ')}`)
  return value as T
}

// Number('') is 0 and Number('2x') is NaN, so both need an explicit check.
export function numberArg(flag: string, value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  if (value.trim() === '' || !Number.isFinite(n) || n < min || n > max)
    fail(`--${flag} must be a number from ${min} to ${max}, got "${value}"`)
  return n
}

export function intArg(flag: string, value: string | undefined, min: number, max: number): number | undefined {
  const n = numberArg(flag, value, min, max)
  if (n !== undefined && !Number.isInteger(n)) fail(`--${flag} must be a whole number, got "${value}"`)
  return n
}

// Last-resort handler for main(): one readable line instead of a stack trace
// (unknown flags from parseArgs, unreadable files, codec errors).
export function exitOnError(error: unknown): never {
  fail(error instanceof Error ? error.message : String(error))
}

// For commands that take either a local file or a public URL, never both.
export function oneSource(command: string, source: string | undefined, imageUrl: string | undefined): void {
  // An empty value still counts as given: `--image-url ""` must not slip past both checks.
  if (source === '' || imageUrl === '') fail(`${command}: --source and --image-url can't be empty`)
  if (source && imageUrl) fail(`${command} takes --source or --image-url, not both`)
  if (!source && !imageUrl) fail(`${command} requires --source or --image-url`)
}
