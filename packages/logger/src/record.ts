import type { LogLevel } from './levels'

export interface LogRecord {
  level: LogLevel
  time: string
  msg: string
  [key: string]: unknown
}

// A plain `Error` serializes to `{}` — `message`/`stack` aren't enumerable
// own properties `JSON.stringify` walks — so it needs its own case. Handled
// in the same replacer pass as circular references, not a separate walk:
// this is the one `JSON.stringify` call per line the hot path gets.
export function serializeRecord(record: LogRecord): string {
  const seen = new WeakSet<object>()
  return JSON.stringify(record, (_key, value) => {
    if (value instanceof Error) {
      // `name` is inherited from `Error.prototype` ("Error") unless a
      // subclass sets it as its own property — most don't bother, so
      // `constructor.name` is what actually identifies a custom error type
      // like `NotFoundError` in the common case. An explicit override is
      // still respected when present.
      const name = Object.hasOwn(value, 'name')
        ? value.name
        : value.constructor.name
      return { name, message: value.message, stack: value.stack }
    }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]'
      seen.add(value)
    }
    return value
  })
}
