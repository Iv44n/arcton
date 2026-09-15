import { expect, test } from 'bun:test'
import type { Context } from '@arcton/contracts'
import { createLogger, logger } from './logger'

function captureSink(): { sink: (line: string) => void; lines: string[] } {
  const lines: string[] = []
  return { sink: line => lines.push(line), lines }
}

function makeCtx(request: Request): Context {
  return {
    request,
    params: {},
    query: {},
    response: { headers: new Headers() }
  }
}

// ── createLogger() ──────────────────────────────────────────────────────

test('logs at or above the configured level, as JSON by default', () => {
  const { sink, lines } = captureSink()
  const log = createLogger({ level: 'warn', sink })

  log.info('ignored')
  log.warn('kept', { code: 'X' })

  expect(lines).toHaveLength(1)
  expect(JSON.parse(lines[0] as string)).toMatchObject({
    level: 'warn',
    msg: 'kept',
    code: 'X'
  })
})

test('level: silent drops every call', () => {
  const { sink, lines } = captureSink()
  const log = createLogger({ level: 'silent', sink })

  log.trace('a')
  log.fatal('b')

  expect(lines).toHaveLength(0)
})

test('every record includes an ISO time field', () => {
  const { sink, lines } = captureSink()
  createLogger({ sink }).info('hello')

  const time = JSON.parse(lines[0] as string).time
  expect(new Date(time).toISOString()).toBe(time)
})

test('child() bindings are merged into every subsequent record', () => {
  const { sink, lines } = captureSink()
  const log = createLogger({ sink })
  const child = log.child({ component: 'database' })

  child.info('query executed')

  expect(JSON.parse(lines[0] as string)).toMatchObject({
    component: 'database',
    msg: 'query executed'
  })
})

test('child() bindings compose across nested children', () => {
  const { sink, lines } = captureSink()
  const log = createLogger({ sink })
  const grandchild = log.child({ component: 'database' }).child({ op: 'query' })

  grandchild.info('done')

  expect(JSON.parse(lines[0] as string)).toMatchObject({
    component: 'database',
    op: 'query'
  })
})

test('per-call data overrides a binding of the same name', () => {
  const { sink, lines } = captureSink()
  const log = createLogger({ sink, bindings: { status: 'unknown' } })

  log.info('done', { status: 'ok' })

  expect(JSON.parse(lines[0] as string).status).toBe('ok')
})

test('child() inherits the parent level and sink', () => {
  const { sink, lines } = captureSink()
  const log = createLogger({ sink, level: 'error' })
  const child = log.child({ component: 'x' })

  child.info('dropped')
  child.error('kept')

  expect(lines).toHaveLength(1)
})

test('pretty: true formats through the human-readable formatter, not JSON', () => {
  const { sink, lines } = captureSink()
  createLogger({ sink, pretty: true }).info('hello')

  expect(() => JSON.parse(lines[0] as string)).toThrow()
  expect(lines[0]).toContain('hello')
})

test('with no sink given, the default one does not throw', () => {
  // Exercises the real process.stdout/console.log fallback — silent so
  // nothing actually hits output during the test run.
  expect(() =>
    createLogger({ level: 'silent' }).info('unreachable')
  ).not.toThrow()
})

// ── logger() request-logging middleware ─────────────────────────────────

test('logs at info for a 2xx response, after next() resolves', async () => {
  const { sink, lines } = captureSink()
  const middleware = logger({ sink })
  const ctx = makeCtx(new Request('http://localhost/users'))

  await middleware(ctx, async () => {
    ctx.response.status = 200
  })

  expect(lines).toHaveLength(1)
  const record = JSON.parse(lines[0] as string)
  expect(record).toMatchObject({
    level: 'info',
    method: 'GET',
    path: '/users',
    status: 200
  })
  expect(typeof record.durationMs).toBe('number')
  expect(record.msg).toMatch(/^GET \/users 200 \d+\.\dms$/)
})

test('logs at warn for a 4xx response', async () => {
  const { sink, lines } = captureSink()
  const middleware = logger({ sink })
  const ctx = makeCtx(new Request('http://localhost/missing'))

  await middleware(ctx, async () => {
    ctx.response.status = 404
  })

  const record = JSON.parse(lines[0] as string)
  expect(record.level).toBe('warn')
  expect(record.status).toBe(404)
})

test('logs at error for a 5xx response', async () => {
  const { sink, lines } = captureSink()
  const middleware = logger({ sink })
  const ctx = makeCtx(new Request('http://localhost/boom'))

  await middleware(ctx, async () => {
    ctx.response.status = 500
  })

  const record = JSON.parse(lines[0] as string)
  expect(record.level).toBe('error')
  expect(record.status).toBe(500)
})

test('a response with no status set defaults the log to 200', async () => {
  const { sink, lines } = captureSink()
  const middleware = logger({ sink })
  const ctx = makeCtx(new Request('http://localhost/'))

  await middleware(ctx, async () => {})

  expect(JSON.parse(lines[0] as string).status).toBe(200)
})

test('the logged path is the pathname only, not the query string', async () => {
  const { sink, lines } = captureSink()
  const middleware = logger({ sink })
  const ctx = makeCtx(new Request('http://localhost/search?q=arcton'))

  await middleware(ctx, async () => {
    ctx.response.status = 200
  })

  expect(JSON.parse(lines[0] as string).path).toBe('/search')
})

test('calls next() exactly once and awaits it before logging', async () => {
  const { sink, lines } = captureSink()
  const middleware = logger({ sink })
  const ctx = makeCtx(new Request('http://localhost/'))
  let nextCalled = 0
  let nextResolvedBeforeLog = false

  await middleware(ctx, async () => {
    nextCalled++
    await new Promise(resolve => setTimeout(resolve, 5))
    ctx.response.status = 201
    nextResolvedBeforeLog = lines.length === 0
  })

  expect(nextCalled).toBe(1)
  expect(nextResolvedBeforeLog).toBe(true)
  expect(lines).toHaveLength(1)
})

// ── errors ──────────────────────────────────────────────────────────────

test('an error thrown downstream is logged at error and rethrown unchanged', async () => {
  const { sink, lines } = captureSink()
  const middleware = logger({ sink })
  const ctx = makeCtx(new Request('http://localhost/boom'))
  const failure = new Error('downstream boom')

  await expect(
    middleware(ctx, async () => {
      throw failure
    })
  ).rejects.toBe(failure)

  expect(lines).toHaveLength(1)
  const record = JSON.parse(lines[0] as string)
  expect(record).toMatchObject({ level: 'error', method: 'GET', path: '/boom' })
  expect(record.err).toMatchObject({
    name: 'Error',
    message: 'downstream boom'
  })
  expect(record.msg).toBe('GET /boom - unhandled error')
})

test('on a downstream error, no success line is logged afterward', async () => {
  const { sink, lines } = captureSink()
  const middleware = logger({ sink })
  const ctx = makeCtx(new Request('http://localhost/boom'))

  try {
    await middleware(ctx, async () => {
      throw new Error('boom')
    })
  } catch {
    // expected — asserted by the previous test
  }

  expect(lines).toHaveLength(1)
})

// ── pretty mode ─────────────────────────────────────────────────────────

test('pretty: true logs a → line on arrival and a ← line on completion', async () => {
  const { sink, lines } = captureSink()
  const middleware = logger({ sink, pretty: true })
  const ctx = makeCtx(new Request('http://localhost/users/1'))

  await middleware(ctx, async () => {
    expect(lines).toHaveLength(1) // the → line is written before next()
    ctx.response.status = 200
  })

  expect(lines).toHaveLength(2)
  expect(lines[0]).toContain('→')
  expect(lines[0]).toContain('/users/1')
  expect(lines[1]).toContain('←')
  expect(lines[1]).toContain('/users/1')
})

test('pretty: true on a downstream error logs → then an ERR line, no ← line', async () => {
  const { sink, lines } = captureSink()
  const middleware = logger({ sink, pretty: true })
  const ctx = makeCtx(new Request('http://localhost/boom'))

  await expect(
    middleware(ctx, async () => {
      throw new Error('kaboom')
    })
  ).rejects.toThrow('kaboom')

  expect(lines).toHaveLength(2)
  expect(lines[1]).toContain('ERR')
  expect(lines[1]).toContain('kaboom')
})

test('pretty output is not JSON', async () => {
  const { sink, lines } = captureSink()
  const middleware = logger({ sink, pretty: true })
  const ctx = makeCtx(new Request('http://localhost/'))

  await middleware(ctx, async () => {
    ctx.response.status = 200
  })

  for (const line of lines) expect(() => JSON.parse(line)).toThrow()
})

test('level: silent suppresses pretty output too', async () => {
  const { sink, lines } = captureSink()
  const middleware = logger({ sink, pretty: true, level: 'silent' })
  const ctx = makeCtx(new Request('http://localhost/'))

  await middleware(ctx, async () => {
    ctx.response.status = 200
  })

  expect(lines).toHaveLength(0)
})

test('level: warn drops the → arrival line but keeps a 4xx ← line', async () => {
  const { sink, lines } = captureSink()
  const middleware = logger({ sink, pretty: true, level: 'warn' })
  const ctx = makeCtx(new Request('http://localhost/missing'))

  await middleware(ctx, async () => {
    ctx.response.status = 404
  })

  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('←')
})

// ── the .logger escape hatch ─────────────────────────────────────────────

test('a logger is a plain Middleware function with .logger attached', () => {
  const { sink } = captureSink()
  const log = logger({ sink })

  expect(typeof log).toBe('function')
  expect(typeof log.logger.info).toBe('function')
  expect(typeof log.logger.child).toBe('function')
})

test('.logger writes through the same sink as the request-logging middleware', () => {
  const { sink, lines } = captureSink()
  const log = logger({ sink })

  log.logger.info('starting up')

  expect(lines).toHaveLength(1)
  expect(JSON.parse(lines[0] as string).msg).toBe('starting up')
})
