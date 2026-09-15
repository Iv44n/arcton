// Six raw ANSI codes — no color library. Shared by the generic formatter
// (pretty.ts) and the request-logging one (request-pretty.ts).
import type { LogLevel } from './levels'

export const RESET = '\x1b[0m'
export const GRAY = '\x1b[90m'
export const CYAN = '\x1b[36m'
export const GREEN = '\x1b[32m'
export const YELLOW = '\x1b[33m'
export const RED = '\x1b[31m'
export const MAGENTA = '\x1b[35m'

// One mapping, so a level reads the same color everywhere it appears —
// a plain `log.warn(...)` and a 4xx request line are both `YELLOW`.
export const LEVEL_COLOR: Record<LogLevel, string> = {
  trace: GRAY,
  debug: CYAN,
  info: GREEN,
  warn: YELLOW,
  error: RED,
  fatal: MAGENTA
}

// The same fixed-width label every level renders as, level color included
// — `formatPretty`'s header and every request-pretty line share this
// exact text, not just the color underneath it.
export function levelLabel(level: LogLevel): string {
  return `${LEVEL_COLOR[level]}${level.toUpperCase().padEnd(5)}${RESET}`
}
