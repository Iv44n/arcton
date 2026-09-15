import type { Middleware } from '@arcton/contracts'
import type { LevelWithSilent, LogLevel } from './levels'
import { isEnabled } from './levels'
import { formatPretty } from './pretty'
import type { LogRecord } from './record'
import { serializeRecord } from './record'
import {
  formatRequestEnd,
  formatRequestError,
  formatRequestStart
} from './request-pretty'

export type { LevelWithSilent, LogLevel } from './levels'

export interface Logger {
  trace(msg: string, data?: Record<string, unknown>): void
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
  fatal(msg: string, data?: Record<string, unknown>): void
  /** A new Logger with `bindings` merged into every record it writes from here on, in addition to (and overriding, on conflict) this logger's own. */
  child(bindings: Record<string, unknown>): Logger
}

export interface LoggerOptions {
  /** Minimum level to log. Anything below it is dropped before a record is even built. */
  level?: LevelWithSilent
  /** Formats each line for a human instead of newline-delimited JSON. */
  pretty?: boolean
  /**
   * Where each formatted line is written. Defaults to `process.stdout.write`
   * where `process` exists (Node, Bun), and `console.log` otherwise (a
   * Worker, or any runtime with no `process`) — never `console.log` on
   * Node/Bun, where it carries formatting overhead a raw stream write
   * doesn't.
   */
  sink?: (line: string) => void
  /** Fields merged into every record this logger writes — the same thing `child()` adds to, not a replacement for it. */
  bindings?: Record<string, unknown>
}

// Detected once at module load, not per call — the runtime doesn't change
// out from under a running process.
const defaultSink: (line: string) => void =
  typeof process !== 'undefined' && typeof process.stdout?.write === 'function'
    ? line => {
        process.stdout.write(`${line}\n`)
      }
    : line => {
        console.log(line)
      }

/**
 * Builds a standalone `Logger` — `trace`/`debug`/`info`/`warn`/`error`/
 * `fatal`, plus `child()` for adding bindings without repeating them on
 * every call. Independent of any request; `logger()` below builds one of
 * these internally for its request-logging middleware, but this is just as
 * usable in a background job or at startup.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const minimum = options.level ?? 'info'
  const pretty = options.pretty ?? false
  const sink = options.sink ?? defaultSink
  const bindings = options.bindings ?? {}

  function write(
    level: LogLevel,
    msg: string,
    data?: Record<string, unknown>
  ): void {
    if (!isEnabled(level, minimum)) return
    const record: LogRecord = {
      level,
      time: new Date().toISOString(),
      msg,
      ...bindings,
      ...data
    }
    sink(pretty ? formatPretty(record) : serializeRecord(record))
  }

  return {
    trace: (msg, data) => write('trace', msg, data),
    debug: (msg, data) => write('debug', msg, data),
    info: (msg, data) => write('info', msg, data),
    warn: (msg, data) => write('warn', msg, data),
    error: (msg, data) => write('error', msg, data),
    fatal: (msg, data) => write('fatal', msg, data),
    child: childBindings =>
      createLogger({
        level: minimum,
        pretty,
        sink,
        bindings: { ...bindings, ...childBindings }
      })
  }
}

/** What `logger()` returns: `app.use()`-able, with the underlying `Logger` attached for logging anything outside the request/response cycle. */
export type ArctonLogger = Middleware & {
  readonly logger: Logger
}

// >=500 as an operational error, >=400 as a client-caused warning, anything
// else at the configured default level — mirrors what any access log
// bucket would flag for triage, without requiring a handler to log
// anything itself.
function levelFor(status: number): 'error' | 'warn' | 'info' {
  if (status >= 500) return 'error'
  if (status >= 400) return 'warn'
  return 'info'
}

/**
 * Builds a request-logging middleware:
 *
 * ```ts
 * app.use(logger())
 * ```
 *
 * With `pretty: false` (the default), logs one JSON line per request, once
 * the response is known (status, duration) — or once the request fails, if
 * nothing downstream caught the error. With `pretty: true`, logs two lines
 * instead — `→` as the request arrives, `←` once it's done — since watching
 * requests arrive is what a human reading a live terminal wants that a
 * machine parsing structured output doesn't. Either way, `level` still
 * gates what gets written: `level: 'silent'` prints nothing, and a
 * `level` above `'info'` with `pretty: true` drops the `→` arrival line
 * along with any `←` line whose own level — `warn` for a 4xx, `error` for
 * a 5xx — doesn't clear it either.
 *
 * The underlying `Logger` is available as `.logger`, for logging anything
 * outside the request/response cycle (e.g. `logger().logger.info(...)`
 * right after `app.listen()`).
 */
export function logger(options: LoggerOptions = {}): ArctonLogger {
  const minimum = options.level ?? 'info'
  const pretty = options.pretty ?? false
  const sink = options.sink ?? defaultSink
  const log = createLogger(options)

  const middleware: Middleware = async (ctx, next) => {
    const start = performance.now()
    const method = ctx.request.method
    const path = new URL(ctx.request.url).pathname

    if (pretty && isEnabled('info', minimum)) {
      sink(formatRequestStart(method, path))
    }

    try {
      await next()
    } catch (err) {
      const durationMs = performance.now() - start
      if (pretty) {
        if (isEnabled('error', minimum)) {
          sink(formatRequestError(method, path, durationMs, err))
        }
      } else {
        log.error(`${method} ${path} - unhandled error`, {
          method,
          path,
          durationMs,
          err
        })
      }
      throw err
    }

    const durationMs = performance.now() - start
    const status = ctx.response.status ?? 200
    const level = levelFor(status)

    if (pretty) {
      if (isEnabled(level, minimum)) {
        sink(formatRequestEnd(method, path, status, durationMs, level))
      }
    } else {
      log[level](`${method} ${path} ${status} ${durationMs.toFixed(1)}ms`, {
        method,
        path,
        status,
        durationMs
      })
    }
  }

  return Object.assign(middleware, { logger: log })
}
