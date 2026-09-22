import { levelLabel } from './colors'
import type { LogRecord } from './record'

function formatValue(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

export function formatPretty(record: LogRecord): string {
  const { level, time, msg, ...rest } = record
  // An ISO timestamp's own HH:MM:SS.mmm slice — no date-formatting library
  // for a fixed-width, fixed-format string.
  const clock = time.slice(11, 23)
  const header = `${levelLabel(level)} ${clock}  ${msg}`

  const keys = Object.keys(rest)
  if (keys.length === 0) return header

  const fields = keys
    .map(key => `    ${key}: ${formatValue(rest[key])}`)
    .join('\n')
  return `${header}\n${fields}`
}
