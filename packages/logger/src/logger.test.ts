import { expect, test } from 'bun:test'
import type { Context } from '@arcton/contracts'
import type { Logger as PinoLogger } from 'pino'
import { logger } from './logger'

interface Call {
  level: 'info' | 'warn' | 'error'
  obj: Record<string, unknown>
  msg: string
}

// A Pino-shaped stand-in, not a real Pino instance — what matters here is
// that `logger()` calls the right method with the right fields at the right
// time, not how Pino itself serializes a log line (that's Pino's own test
// suite's job, not this package's).
function fakeLogger(): { instance: PinoLogger; calls: Call[] } {
  const calls: Call[] = []
  const record =
    (level: Call['level']) => (obj: Record<string, unknown>, msg: string) => {
      calls.push({ level, obj, msg })
    }
  const instance = {
    info: record('info'),
    warn: record('warn'),
    error: record('error')
  } as unknown as PinoLogger
  return { instance, calls }
}

function makeCtx(request: Request): Context {
  return {
    request,
    params: {},
    query: {},
    response: { headers: new Headers() }
  }
}

// ── construction ────────────────────────────────────────────────────────

test('a logger is a plain Middleware function with .pino attached', () => {
  const { instance } = fakeLogger()
  const log = logger({ instance })

  expect(typeof log).toBe('function')
  expect(log.pino).toBe(instance)
})

test('instance bypasses building a Pino logger from level/pretty/pino', () => {
  const { instance } = fakeLogger()
  const log = logger({ instance, level: 'debug', pino: { name: 'ignored' } })

  expect(log.pino).toBe(instance)
})

test('pretty: true wires up the pino-pretty transport without throwing', () => {
  // Real Pino construction — confirms the transport actually resolves
  // pino-pretty (installed here as a dev dependency), not just that the
  // option is accepted. Silent so nothing hits stdout during the test run.
  expect(() => logger({ pretty: true, level: 'silent' })).not.toThrow()
})

test('with no options, a default (silent) Pino logger builds without throwing', () => {
  expect(() => logger({ level: 'silent' })).not.toThrow()
})

// ── request logging ────────────────────────────────────────────────────

test('logs at info for a 2xx response, after next() resolves', async () => {
  const { instance, calls } = fakeLogger()
  const middleware = logger({ instance })
  const ctx = makeCtx(new Request('http://localhost/users'))

  await middleware(ctx, async () => {
    ctx.response.status = 200
  })

  expect(calls).toHaveLength(1)
  expect(calls[0]?.level).toBe('info')
  expect(calls[0]?.obj).toMatchObject({
    method: 'GET',
    path: '/users',
    status: 200
  })
  expect(typeof calls[0]?.obj.durationMs).toBe('number')
  expect(calls[0]?.msg).toMatch(/^GET \/users 200 \d+\.\dms$/)
})

test('logs at warn for a 4xx response', async () => {
  const { instance, calls } = fakeLogger()
  const middleware = logger({ instance })
  const ctx = makeCtx(new Request('http://localhost/missing'))

  await middleware(ctx, async () => {
    ctx.response.status = 404
  })

  expect(calls[0]?.level).toBe('warn')
  expect(calls[0]?.obj.status).toBe(404)
})

test('logs at error for a 5xx response', async () => {
  const { instance, calls } = fakeLogger()
  const middleware = logger({ instance })
  const ctx = makeCtx(new Request('http://localhost/boom'))

  await middleware(ctx, async () => {
    ctx.response.status = 500
  })

  expect(calls[0]?.level).toBe('error')
  expect(calls[0]?.obj.status).toBe(500)
})

test('a response with no status set defaults the log to 200', async () => {
  const { instance, calls } = fakeLogger()
  const middleware = logger({ instance })
  const ctx = makeCtx(new Request('http://localhost/'))

  await middleware(ctx, async () => {})

  expect(calls[0]?.obj.status).toBe(200)
})

test('the logged path is the pathname only, not the query string', async () => {
  const { instance, calls } = fakeLogger()
  const middleware = logger({ instance })
  const ctx = makeCtx(new Request('http://localhost/search?q=arcton'))

  await middleware(ctx, async () => {
    ctx.response.status = 200
  })

  expect(calls[0]?.obj.path).toBe('/search')
})

test('calls next() exactly once and awaits it before logging', async () => {
  const { instance, calls } = fakeLogger()
  const middleware = logger({ instance })
  const ctx = makeCtx(new Request('http://localhost/'))
  let nextCalled = 0
  let nextResolvedBeforeLog = false

  await middleware(ctx, async () => {
    nextCalled++
    await new Promise(resolve => setTimeout(resolve, 5))
    ctx.response.status = 201
    nextResolvedBeforeLog = calls.length === 0
  })

  expect(nextCalled).toBe(1)
  expect(nextResolvedBeforeLog).toBe(true)
  expect(calls).toHaveLength(1)
})

// ── errors ──────────────────────────────────────────────────────────────

test('an error thrown downstream is logged at error and rethrown unchanged', async () => {
  const { instance, calls } = fakeLogger()
  const middleware = logger({ instance })
  const ctx = makeCtx(new Request('http://localhost/boom'))
  const failure = new Error('downstream boom')

  await expect(
    middleware(ctx, async () => {
      throw failure
    })
  ).rejects.toBe(failure)

  expect(calls).toHaveLength(1)
  expect(calls[0]?.level).toBe('error')
  expect(calls[0]?.obj).toMatchObject({
    method: 'GET',
    path: '/boom',
    err: failure
  })
  expect(calls[0]?.msg).toBe('GET /boom - unhandled error')
})

test('on a downstream error, no success line is logged afterward', async () => {
  const { instance, calls } = fakeLogger()
  const middleware = logger({ instance })
  const ctx = makeCtx(new Request('http://localhost/boom'))

  try {
    await middleware(ctx, async () => {
      throw new Error('boom')
    })
  } catch {
    // expected — asserted by the previous test
  }

  expect(calls).toHaveLength(1)
})
