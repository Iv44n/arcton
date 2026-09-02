import { expect, test } from 'bun:test'
import type { Context } from '@arcton/contracts'
import { cors } from './cors'

function makeCtx(request: Request): Context {
  return {
    request,
    params: {},
    query: {},
    response: { headers: new Headers() }
  }
}

function req(
  url: string,
  init: RequestInit & { headers?: Record<string, string> } = {}
): Request {
  return new Request(url, init)
}

// ── config validation ───────────────────────────────────────────────────

test('throws at setup when origin is "*" and credentials is true', () => {
  expect(() => cors({ origin: '*', credentials: true })).toThrow(TypeError)
})

test('the default origin ("*") with credentials omitted does not throw', () => {
  expect(() => cors()).not.toThrow()
})

// ── no Origin header: not a CORS request ────────────────────────────────

test('no Origin header → next() runs, no CORS headers added', async () => {
  const middleware = cors()
  const ctx = makeCtx(req('http://localhost/'))
  let nextCalled = false

  const result = await middleware(ctx, async () => {
    nextCalled = true
  })

  expect(nextCalled).toBe(true)
  expect(result).toBeUndefined()
  expect(ctx.response.headers.get('Access-Control-Allow-Origin')).toBeNull()
})

// ── normal (non-preflight) requests ─────────────────────────────────────

test('wildcard origin: Access-Control-Allow-Origin is "*", no Vary', async () => {
  const middleware = cors()
  const ctx = makeCtx(
    req('http://localhost/', { headers: { origin: 'https://a.com' } })
  )

  await middleware(ctx, async () => {
    ctx.response.headers.set('content-type', 'application/json')
  })

  expect(ctx.response.headers.get('Access-Control-Allow-Origin')).toBe('*')
  expect(ctx.response.headers.get('Vary')).toBeNull()
})

test('a single allowed origin string: echoes it back and sets Vary', async () => {
  const middleware = cors({ origin: 'https://app.example.com' })
  const ctx = makeCtx(
    req('http://localhost/', { headers: { origin: 'https://app.example.com' } })
  )

  await middleware(ctx, async () => {})

  expect(ctx.response.headers.get('Access-Control-Allow-Origin')).toBe(
    'https://app.example.com'
  )
  expect(ctx.response.headers.get('Vary')).toBe('Origin')
})

test('a single disallowed origin: next() runs, no CORS headers', async () => {
  const middleware = cors({ origin: 'https://app.example.com' })
  const ctx = makeCtx(
    req('http://localhost/', {
      headers: { origin: 'https://evil.example.com' }
    })
  )
  let nextCalled = false

  await middleware(ctx, async () => {
    nextCalled = true
  })

  expect(nextCalled).toBe(true)
  expect(ctx.response.headers.get('Access-Control-Allow-Origin')).toBeNull()
})

test('an array of origins: allows a listed one, echoing it back', async () => {
  const middleware = cors({
    origin: ['https://app.example.com', 'https://admin.example.com']
  })
  const ctx = makeCtx(
    req('http://localhost/', {
      headers: { origin: 'https://admin.example.com' }
    })
  )

  await middleware(ctx, async () => {})

  expect(ctx.response.headers.get('Access-Control-Allow-Origin')).toBe(
    'https://admin.example.com'
  )
})

test('an array of origins: rejects one not in the list', async () => {
  const middleware = cors({ origin: ['https://app.example.com'] })
  const ctx = makeCtx(
    req('http://localhost/', { headers: { origin: 'https://other.com' } })
  )

  await middleware(ctx, async () => {})

  expect(ctx.response.headers.get('Access-Control-Allow-Origin')).toBeNull()
})

test('a function origin matcher: receives the origin and the request, decides dynamically', async () => {
  const seen: { origin: string; url: string }[] = []
  const middleware = cors({
    origin: (origin, request) => {
      seen.push({ origin, url: request.url })
      return origin.endsWith('.example.com')
    }
  })
  const ctx = makeCtx(
    req('http://localhost/orders', {
      headers: { origin: 'https://foo.example.com' }
    })
  )

  await middleware(ctx, async () => {})

  expect(seen).toEqual([
    { origin: 'https://foo.example.com', url: 'http://localhost/orders' }
  ])
  expect(ctx.response.headers.get('Access-Control-Allow-Origin')).toBe(
    'https://foo.example.com'
  )
  expect(ctx.response.headers.get('Vary')).toBe('Origin')
})

test('credentials: true adds Access-Control-Allow-Credentials', async () => {
  const middleware = cors({
    origin: 'https://app.example.com',
    credentials: true
  })
  const ctx = makeCtx(
    req('http://localhost/', { headers: { origin: 'https://app.example.com' } })
  )

  await middleware(ctx, async () => {})

  expect(ctx.response.headers.get('Access-Control-Allow-Credentials')).toBe(
    'true'
  )
})

test('exposedHeaders sets Access-Control-Expose-Headers, joined', async () => {
  const middleware = cors({ exposedHeaders: ['X-Total-Count', 'X-Page'] })
  const ctx = makeCtx(
    req('http://localhost/', { headers: { origin: 'https://a.com' } })
  )

  await middleware(ctx, async () => {})

  expect(ctx.response.headers.get('Access-Control-Expose-Headers')).toBe(
    'X-Total-Count, X-Page'
  )
})

test('no exposedHeaders configured → header is not added', async () => {
  const middleware = cors()
  const ctx = makeCtx(
    req('http://localhost/', { headers: { origin: 'https://a.com' } })
  )

  await middleware(ctx, async () => {})

  expect(ctx.response.headers.get('Access-Control-Expose-Headers')).toBeNull()
})

// ── preflight ────────────────────────────────────────────────────────────

function preflightReq(
  origin: string,
  extra: Record<string, string> = {}
): Request {
  return req('http://localhost/users', {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      ...extra
    }
  })
}

test('a real preflight (OPTIONS + Access-Control-Request-Method) short-circuits with 204', async () => {
  const middleware = cors({ origin: 'https://app.example.com' })
  const ctx = makeCtx(preflightReq('https://app.example.com'))
  let nextCalled = false

  const result = await middleware(ctx, async () => {
    nextCalled = true
  })

  expect(nextCalled).toBe(false)
  expect(result).toBeInstanceOf(Response)
  expect((result as Response).status).toBe(204)
})

test('preflight response carries Allow-Origin/Methods/Headers/Credentials/Max-Age', async () => {
  const middleware = cors({
    origin: 'https://app.example.com',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    maxAge: 600
  })
  const ctx = makeCtx(preflightReq('https://app.example.com'))

  const result = (await middleware(ctx, async () => {})) as Response

  expect(result.headers.get('Access-Control-Allow-Origin')).toBe(
    'https://app.example.com'
  )
  expect(result.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST')
  expect(result.headers.get('Access-Control-Allow-Headers')).toBe(
    'Content-Type, Authorization'
  )
  expect(result.headers.get('Access-Control-Allow-Credentials')).toBe('true')
  expect(result.headers.get('Access-Control-Max-Age')).toBe('600')
})

test("preflight with methods/allowedHeaders omitted echoes the request's own preflight headers", async () => {
  const middleware = cors({ origin: 'https://app.example.com' })
  const ctx = makeCtx(
    preflightReq('https://app.example.com', {
      'access-control-request-headers': 'X-Custom, Content-Type'
    })
  )

  const result = (await middleware(ctx, async () => {})) as Response

  expect(result.headers.get('Access-Control-Allow-Methods')).toBe('POST')
  expect(result.headers.get('Access-Control-Allow-Headers')).toBe(
    'X-Custom, Content-Type'
  )
})

test('preflight from a disallowed origin: 204 with no CORS headers at all', async () => {
  const middleware = cors({ origin: 'https://app.example.com' })
  const ctx = makeCtx(preflightReq('https://evil.example.com'))

  const result = (await middleware(ctx, async () => {})) as Response

  expect(result.status).toBe(204)
  expect(result.headers.get('Access-Control-Allow-Origin')).toBeNull()
})

test('OPTIONS without Access-Control-Request-Method is not a preflight — next() runs normally', async () => {
  const middleware = cors({ origin: 'https://app.example.com' })
  const ctx = makeCtx(
    req('http://localhost/users', {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example.com' }
    })
  )
  let nextCalled = false

  await middleware(ctx, async () => {
    nextCalled = true
  })

  expect(nextCalled).toBe(true)
})

test('preflight: false disables automatic interception — a real preflight still reaches next()', async () => {
  const middleware = cors({
    origin: 'https://app.example.com',
    preflight: false
  })
  const ctx = makeCtx(preflightReq('https://app.example.com'))
  let nextCalled = false

  await middleware(ctx, async () => {
    nextCalled = true
  })

  expect(nextCalled).toBe(true)
})

test('preflight: false still adds CORS headers to whatever the app eventually returns', async () => {
  const middleware = cors({
    origin: 'https://app.example.com',
    preflight: false
  })
  const ctx = makeCtx(preflightReq('https://app.example.com'))

  await middleware(ctx, async () => {})

  expect(ctx.response.headers.get('Access-Control-Allow-Origin')).toBe(
    'https://app.example.com'
  )
})
