// The only module that knows Pino exists.

import type { Middleware } from '@arcton/contracts'
import pino, {
  type LevelWithSilent,
  type Logger as PinoLogger,
  type LoggerOptions as PinoLoggerOptions
} from 'pino'

export interface LoggerOptions {
  /**
   * An already-configured Pino logger to use instead of building one from
   * the options below — for an app that already centralizes its own Pino
   * setup. When given, `level`/`pretty`/`pino` are ignored.
   */
  instance?: PinoLogger
  /** Minimum level to log. Passed straight to Pino. */
  level?: LevelWithSilent
  /**
   * Pretty-prints instead of newline-delimited JSON, via Pino's own
   * `pino-pretty` transport. `pino-pretty` is a peer dependency, not a
   * regular one — install it yourself (`bun add pino-pretty`) to use this;
   * without it, `logger({ pretty: true })` throws the same
   * `unable to determine transport target for "pino-pretty"` error Pino
   * itself would.
   */
  pretty?: boolean
  /**
   * Additional Pino options, merged in on top of `level`/`pretty` — the
   * escape hatch for anything this options object doesn't expose directly
   * (redaction, custom serializers, a different transport entirely, ...).
   */
  pino?: PinoLoggerOptions
}

/** What `logger()` returns: `app.use()`-able, with the underlying Pino instance attached for logging anything outside the request/response cycle. */
export type ArctonLogger = Middleware & {
  readonly pino: PinoLogger
}

function createPino(options: LoggerOptions): PinoLogger {
  if (options.instance) return options.instance
  return pino({
    ...(options.level === undefined ? {} : { level: options.level }),
    ...(options.pretty ? { transport: { target: 'pino-pretty' } } : {}),
    ...options.pino
  })
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
 * Builds a request-logging middleware backed by Pino:
 *
 * ```ts
 * app.use(logger())
 * ```
 *
 * Logs one line per request, once the response is known (status, duration)
 * — or once the request fails, if nothing downstream caught the error. The
 * underlying Pino instance is available as `.pino`, for logging anything
 * outside the request/response cycle (e.g. `logger().pino.info(...)` right
 * after `app.listen()`).
 */
export function logger(options: LoggerOptions = {}): ArctonLogger {
  const log = createPino(options)

  const middleware: Middleware = async (ctx, next) => {
    const start = performance.now()
    const method = ctx.request.method
    const path = new URL(ctx.request.url).pathname

    try {
      await next()
    } catch (err) {
      const durationMs = performance.now() - start
      log.error(
        { method, path, durationMs, err },
        `${method} ${path} - unhandled error`
      )
      throw err
    }

    const durationMs = performance.now() - start
    const status = ctx.response.status ?? 200
    log[levelFor(status)](
      { method, path, status, durationMs },
      `${method} ${path} ${status} ${durationMs.toFixed(1)}ms`
    )
  }

  return Object.assign(middleware, { pino: log })
}
