// A dedicated pretty format for the request-logging middleware — arrows for
// a request's two natural points (arrival, completion), not the generic
// single-line `formatPretty` used for an arbitrary `log.info(...)` call.
// The level label and its color come from `./colors`, the same as
// `formatPretty` uses, so a level reads identically in either format.

import { CYAN, GRAY, GREEN, levelLabel, RED, RESET, YELLOW } from './colors'
import type { LogLevel } from './levels'

function statusColor(status: number): string {
  if (status >= 500) return RED
  if (status >= 400) return YELLOW
  return GREEN
}

// The same HH:MM:SS.mmm precision `formatPretty` shows for a plain log
// call — computed fresh here, at the moment each line is actually emitted,
// not reused from a shared record the way the JSON path builds one.
function clock(): string {
  return new Date().toISOString().slice(11, 23)
}

// Arrival has no status yet to derive a level from — always 'info', the
// same as any other request that isn't a 4xx/5xx.
export function formatRequestStart(method: string, path: string): string {
  return (
    `\n${GRAY}→${RESET} ${levelLabel('info')} ${GRAY}${clock()}${RESET} ` +
    `${CYAN}${method.padEnd(6)}${RESET} ${path}`
  )
}

export function formatRequestEnd(
  method: string,
  path: string,
  status: number,
  durationMs: number,
  level: LogLevel
): string {
  return (
    `${GRAY}←${RESET} ${levelLabel(level)} ${GRAY}${clock()}${RESET} ` +
    `${statusColor(status)}${status}${RESET} ` +
    `${CYAN}${method.padEnd(6)}${RESET} ${path} ` +
    `${GRAY}${durationMs.toFixed(1)}ms${RESET}`
  )
}

// No status to show — the same reason the JSON path's error line has no
// `status` field either: the request never got a response.
export function formatRequestError(
  method: string,
  path: string,
  durationMs: number,
  err: unknown
): string {
  const message = err instanceof Error ? err.message : String(err)
  return (
    `${GRAY}←${RESET} ${levelLabel('error')} ${GRAY}${clock()}${RESET} ` +
    `${CYAN}${method.padEnd(6)}${RESET} ${path} ` +
    `${GRAY}${durationMs.toFixed(1)}ms${RESET} ${RED}${message}${RESET}`
  )
}
