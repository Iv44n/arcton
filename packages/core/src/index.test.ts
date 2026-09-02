import { expect, test } from 'bun:test'
import type {
  Body,
  RuntimeAdapter,
  RuntimeHandler,
  RuntimeRequestContext,
  StandardSchemaV1
} from '@arcton/contracts'
import { Arcton } from './index'

function fakeSchema<Input, Output>(
  fn: (v: Input) => Output
): StandardSchemaV1<Input, Output> {
  return {
    '~standard': {
      version: 1,
      vendor: 'fake',
      validate: (v: unknown) => {
        try {
          return { value: fn(v as Input) }
        } catch (err) {
          return { issues: [{ message: (err as Error).message }] }
        }
      }
    }
  }
}

function createTestAdapter(): {
  adapter: RuntimeAdapter
  fetch: RuntimeHandler
} {
  let captured: RuntimeHandler | undefined
  const adapter: RuntimeAdapter = {
    name: 'test',
    version: '0.0.0',
    capabilities: { websocket: true },
    serve(options) {
      captured = options.fetch
      return {
        port: options.port,
        url: new URL(`http://localhost:${options.port}`),
        stop() {}
      }
    }
  }

  const fetch: RuntimeHandler = (request, context) => {
    if (!captured) throw new Error('app.listen() was not called')
    return captured(request, context)
  }
  return { adapter, fetch }
}

const noopContext: RuntimeRequestContext = { upgrade: () => false }

async function call(handler: RuntimeHandler, request: Request) {
  const res = await handler(request, noopContext)
  if (!res) throw new Error('expected a Response, got undefined')
  return res
}

test('Arcton returns an app with listen()', () => {
  const app = Arcton()
  expect(typeof app.listen).toBe('function')
})

test('Arcton stores the given config', () => {
  const app = Arcton({ port: 4000 })
  expect(app.config.port).toBe(4000)
})

test('app.get/app.ws register routes served by listen()', async () => {
  const app = Arcton()

  app.get('/health', () => ({ status: 'ok' }))

  app.ws('/chat', {
    message(ws, message) {
      ws.send(message)
    }
  })

  const server = app.listen({ port: 0 })

  const res = await fetch(new URL('/health', server.url))
  expect(await res.json()).toEqual({ status: 'ok' })

  const missing = await fetch(new URL('/missing', server.url))
  expect(missing.status).toBe(404)

  const wsUrl = new URL('/chat', server.url)
  wsUrl.protocol = 'ws:'
  const ws = new WebSocket(wsUrl)
  await new Promise<void>(resolve =>
    ws.addEventListener('open', () => resolve())
  )

  const reply = new Promise<string>(resolve => {
    ws.addEventListener('message', event => resolve(event.data as string))
  })
  ws.send('hello')
  expect(await reply).toBe('hello')

  ws.close()
  server.stop()
})

test('a handler returning a plain value is auto-mapped to JSON, a Response is passed through', async () => {
  const app = Arcton()

  app.get('/users', () => [{ id: 1 }])
  app.get(
    '/plain',
    () => new Response('hi', { headers: { 'content-type': 'text/plain' } })
  )
  app.get('/empty', () => undefined)

  const server = app.listen({ port: 0 })

  const users = await fetch(new URL('/users', server.url))
  expect(users.headers.get('content-type')).toStartWith('application/json')
  expect(await users.json()).toEqual([{ id: 1 }])

  const plain = await fetch(new URL('/plain', server.url))
  expect(plain.headers.get('content-type')).toBe('text/plain')
  expect(await plain.text()).toBe('hi')

  const empty = await fetch(new URL('/empty', server.url))
  expect(empty.status).toBe(200)
  expect(await empty.text()).toBe('')

  server.stop()
})

test('end-to-end: dynamic route params + 405 with Allow', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })

  app.get('/users/:id', ctx => ({ id: ctx.params.id }))
  app.post('/users/:id', ctx => ({ updated: ctx.params.id }))

  app.listen({ port: 0 })

  const get = await call(handler, new Request('http://localhost/users/42'))
  expect(get.status).toBe(200)
  expect(await get.json()).toEqual({ id: '42' })

  const del = await call(
    handler,
    new Request('http://localhost/users/42', { method: 'DELETE' })
  )
  expect(del.status).toBe(405)
  expect(del.headers.get('Allow')).toBe('GET, POST')
})

test('mapResponse: null/undefined/void → empty body, status 200', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  app.get('/undefined', () => undefined)
  app.get('/null', () => null as unknown as Body)
  app.get('/void', () => {})
  app.listen({ port: 0 })

  for (const path of ['/undefined', '/null', '/void']) {
    const res = await call(handler, new Request(`http://localhost${path}`))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  }
})

test('mapResponse: Response result is returned as-is, ctx.response fully ignored', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  app.get('/', ctx => {
    ctx.response.status = 500
    ctx.response.headers.set('X-Should-Not-Appear', 'yes')
    return new Response('escape hatch', {
      status: 201,
      headers: { 'X-Custom': 'ok' }
    })
  })
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.status).toBe(201)
  expect(res.headers.get('X-Custom')).toBe('ok')
  expect(res.headers.get('X-Should-Not-Appear')).toBeNull()
  expect(await res.text()).toBe('escape hatch')
})

test('mapResponse: string without explicit Content-Type → text/plain; charset=UTF-8', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  app.get('/', () => 'hello')
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.headers.get('Content-Type')).toBe('text/plain; charset=UTF-8')
  expect(await res.text()).toBe('hello')
})

test('mapResponse: string with explicit Content-Type is respected', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  app.get('/', ctx => {
    ctx.response.headers.set('Content-Type', 'text/csv')
    return 'a,b,c'
  })
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.headers.get('Content-Type')).toBe('text/csv')
  expect(await res.text()).toBe('a,b,c')
})

test('mapResponse: Blob with .type set → uses blob.type', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  app.get('/', () => new Blob(['hi'], { type: 'image/png' }))
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.headers.get('Content-Type')).toBe('image/png')
})

test('mapResponse: Blob without .type (and no explicit Content-Type) → application/octet-stream', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  app.get('/', () => new Blob(['hi']))
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
})

test('mapResponse: FormData → multipart/form-data; boundary=..., ignores explicit Content-Type', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  app.get('/', ctx => {
    ctx.response.headers.set('Content-Type', 'application/json')
    const form = new FormData()
    form.set('a', 'b')
    return form
  })
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.headers.get('Content-Type')).toMatch(
    /^multipart\/form-data; boundary=/
  )

  const body = await res.formData()
  expect(body.get('a')).toBe('b')
})

test('mapResponse: URLSearchParams → application/x-www-form-urlencoded;charset=UTF-8', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  app.get('/', () => new URLSearchParams({ a: 'b' }))
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.headers.get('Content-Type')).toBe(
    'application/x-www-form-urlencoded;charset=UTF-8'
  )
  expect(await res.text()).toBe('a=b')
})

test('mapResponse: Uint8Array → application/octet-stream', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  app.get('/', () => new Uint8Array([1, 2, 3]))
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(
    new Uint8Array([1, 2, 3])
  )
})

test('mapResponse: Int32Array (any ArrayBufferView, not just Uint8Array) → application/octet-stream', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  app.get('/', () => new Int32Array([1, 2, 3]))
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
})

test('mapResponse: object/array → application/json; charset=UTF-8', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  app.get('/object', () => ({ ok: true }))
  app.get('/array', () => [1, 2, 3])
  app.listen({ port: 0 })

  const objectRes = await call(handler, new Request('http://localhost/object'))
  expect(objectRes.headers.get('Content-Type')).toBe(
    'application/json; charset=UTF-8'
  )
  expect(await objectRes.json()).toEqual({ ok: true })

  const arrayRes = await call(handler, new Request('http://localhost/array'))
  expect(arrayRes.headers.get('Content-Type')).toBe(
    'application/json; charset=UTF-8'
  )
  expect(await arrayRes.json()).toEqual([1, 2, 3])
})

test('mapResponse: Map/Set fall into the object branch — silent JSON loss, declared', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  app.get('/', () => new Map([['a', 1]]))
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.headers.get('Content-Type')).toBe(
    'application/json; charset=UTF-8'
  )
  expect(await res.text()).toBe('{}')
})

test('mapResponse: an unserializable runtime value (e.g. number, no static types) throws', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  app.get('/', () => 42 as unknown as Body)
  app.listen({ port: 0 })

  await expect(call(handler, new Request('http://localhost/'))).rejects.toThrow(
    /number/
  )
})

test('mapResponse: ctx.response.status outside [200, 599] throws a descriptive error', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  app.get('/', ctx => {
    ctx.response.status = 700
    return { ok: true }
  })
  app.listen({ port: 0 })

  await expect(call(handler, new Request('http://localhost/'))).rejects.toThrow(
    /700/
  )
})

test('mapResponse: ctx.response.headers merge on top of the inferred headers', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  app.get('/', ctx => {
    ctx.response.headers.set('X-Trace', '123')
    return { ok: true }
  })
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.headers.get('Content-Type')).toBe(
    'application/json; charset=UTF-8'
  )
  expect(res.headers.get('X-Trace')).toBe('123')
})

test('mapResponse: status 204 forces a null body — inferred Content-Type dropped, explicit headers pass through', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  app.get('/', ctx => {
    ctx.response.status = 204
    ctx.response.headers.set('X-Explicit', 'yes')
    return { ok: true }
  })
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.status).toBe(204)
  expect(await res.text()).toBe('')
  expect(res.headers.get('Content-Type')).toBeNull()
  expect(res.headers.get('X-Explicit')).toBe('yes')
})

test('mapResponse: status 204 forces a null body — explicit Content-Type survives, unlike the inferred one above', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  app.get('/', ctx => {
    ctx.response.status = 204
    ctx.response.headers.set('Content-Type', 'text/plain; charset=UTF-8')
    return { ok: true }
  })
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.status).toBe(204)
  expect(await res.text()).toBe('')
  expect(res.headers.get('Content-Type')).toBe('text/plain; charset=UTF-8')
})

// ── ctx.query — end-to-end, not part of the router/MatchResult ──────────────

test('ctx.query: no query string → {}', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  app.get('/', ctx => ctx.query)
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/'))
  expect(await res.json()).toEqual({})
})

test('ctx.query: a key with no value → empty string', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  app.get('/', ctx => ctx.query)
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/?q='))
  expect(await res.json()).toEqual({ q: '' })
})

test('ctx.query: repeated key → last value wins', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  app.get('/', ctx => ctx.query)
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/?a=1&a=2'))
  expect(await res.json()).toEqual({ a: '2' })
})

test('ctx.query: "+" decodes as a space', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  app.get('/', ctx => ctx.query)
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/?a=b+c'))
  expect(await res.json()).toEqual({ a: 'b c' })
})

test('error path: a synchronously throwing handler propagates uncaught', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  const err = new Error('handler boom')
  app.get('/', () => {
    throw err
  })
  app.listen({ port: 0 })

  await expect(call(handler, new Request('http://localhost/'))).rejects.toBe(
    err
  )
})

test('error path: a rejecting async handler propagates uncaught', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  const err = new Error('async boom')
  app.get('/', async () => {
    throw err
  })
  app.listen({ port: 0 })

  await expect(call(handler, new Request('http://localhost/'))).rejects.toBe(
    err
  )
})

test('error path: mapResponse throwing propagates uncaught, unnormalized', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  app.get('/', () => 42 as unknown as Body)
  app.listen({ port: 0 })

  await expect(call(handler, new Request('http://localhost/'))).rejects.toThrow(
    /Cannot serialize handler result/
  )
})

test('app.use: a global middleware setting a header on the way out reaches the Response', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })

  app.use(async (ctx, next) => {
    await next()
    ctx.response.headers.set('X-Powered-By', 'arcton')
  })
  app.get('/', () => ({ ok: true }))
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.headers.get('X-Powered-By')).toBe('arcton')
})

test('app.use: replacing the body after next() inherits headers already set on ctx.response', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })

  app.use(async (ctx, next) => {
    await next()
    ctx.response.headers.set('X-Trace', 'outer')
    return { replaced: true }
  })
  app.get('/', () => ({ original: true }))
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.headers.get('X-Trace')).toBe('outer')
  expect(await res.json()).toEqual({ replaced: true })
})

test('app.use: replacing with a raw Response after next() overrides completely, no header inheritance', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })

  app.use(async (ctx, next) => {
    await next()
    ctx.response.headers.set('X-Trace', 'outer')
    return new Response('replaced', { status: 201 })
  })
  app.get('/', () => ({ original: true }))
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.status).toBe(201)
  expect(res.headers.get('X-Trace')).toBeNull()
  expect(await res.text()).toBe('replaced')
})

test('app.use: short-circuit middleware returning an object skips the handler', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  let handlerCalled = false

  app.use(() => ({ blocked: true }))
  app.get('/', () => {
    handlerCalled = true
    return { ok: true }
  })
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/'))
  expect(handlerCalled).toBe(false)
  expect(await res.json()).toEqual({ blocked: true })
})

test('app.use: global middleware runs on 404, e.g. to set CORS headers on it', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  let middlewareCalled = false

  app.use(async (ctx, next) => {
    middlewareCalled = true
    await next()
    ctx.response.headers.set('Access-Control-Allow-Origin', '*')
  })
  app.get('/exists', () => ({ ok: true }))
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/missing'))
  expect(res.status).toBe(404)
  expect(middlewareCalled).toBe(true)
  expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
})

test('app.use: global middleware runs on 405, alongside the Allow header', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })

  app.use(async (ctx, next) => {
    await next()
    ctx.response.headers.set('X-Powered-By', 'arcton')
  })
  app.get('/users', () => ({ ok: true }))
  app.listen({ port: 0 })

  const res = await call(
    handler,
    new Request('http://localhost/users', { method: 'POST' })
  )
  expect(res.status).toBe(405)
  expect(res.headers.get('Allow')).toBe('GET')
  expect(res.headers.get('X-Powered-By')).toBe('arcton')
})

test("app.use: applies to 404/405 regardless of registration order relative to routes (unlike a route's own snapshot)", async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })

  app.get('/exists', () => ({ ok: true })) // registered BEFORE the use() below
  app.use(async (ctx, next) => {
    await next()
    ctx.response.headers.set('X-Trace', 'yes')
  })
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/missing'))
  expect(res.status).toBe(404)
  expect(res.headers.get('X-Trace')).toBe('yes')
})

test("use(scope, mw): does NOT run on 404/405 — there's no matched route to belong to", async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  let scopedCalled = false

  app.use('/api', () => {
    scopedCalled = true
  })
  app.get('/api/users', () => ({ ok: true }))
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/api/missing'))
  expect(res.status).toBe(404)
  expect(scopedCalled).toBe(false)
})

test('route-level middleware does NOT run on 404/405', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  let routeMwCalled = false

  app.get(
    '/users',
    async (_ctx, next) => {
      routeMwCalled = true
      await next()
    },
    () => ({ ok: true })
  )
  app.listen({ port: 0 })

  const res = await call(
    handler,
    new Request('http://localhost/users', { method: 'POST' })
  )
  expect(res.status).toBe(405)
  expect(routeMwCalled).toBe(false)
})

test('app.provide: a provided value is flat on ctx for handlers registered after it', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter }).provide(async () => ({ user: { id: 'u1' } }))

  app.get('/me', ({ user }) => ({ userId: user.id }))
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/me'))
  expect(await res.json()).toEqual({ userId: 'u1' })
})

test('app.provide: composes — a later provide() reads what an earlier one added', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
    .provide(async () => ({ user: { id: 'u1' } }))
    .provide(async ({ user }) => ({ permissions: [user.id] }))

  app.get('/whoami', ({ user, permissions }) => ({ user, permissions }))
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/whoami'))
  expect(await res.json()).toEqual({ user: { id: 'u1' }, permissions: ['u1'] })
})

test('app.provide: a use() registered after it can read the provided value', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter }).provide(() => ({ user: { id: 'u1' } }))
  let sawUser: unknown

  app.use(async (ctx, next) => {
    sawUser = ctx.user
    await next()
  })
  app.get('/', () => ({ ok: true }))
  app.listen({ port: 0 })

  await call(handler, new Request('http://localhost/'))
  expect(sawUser).toEqual({ id: 'u1' })
})

test('route-level middleware: runs only for that route, nested inside global middleware', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  const order: string[] = []

  app.use(async (_ctx, next) => {
    order.push('global-pre')
    await next()
    order.push('global-post')
  })
  app.get(
    '/protected',
    async (_ctx, next) => {
      order.push('route-mw-pre')
      await next()
      order.push('route-mw-post')
    },
    () => {
      order.push('handler')
      return { ok: true }
    }
  )
  app.get('/public', () => ({ ok: true }))
  app.listen({ port: 0 })

  await call(handler, new Request('http://localhost/protected'))
  expect(order).toEqual([
    'global-pre',
    'route-mw-pre',
    'handler',
    'route-mw-post',
    'global-post'
  ])

  order.length = 0
  await call(handler, new Request('http://localhost/public'))
  expect(order).toEqual(['global-pre', 'global-post'])
})

test('route-level middleware + provide(): both params and provided context are visible together', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter }).provide(() => ({ user: { id: 'u1' } }))

  app.get(
    '/users/:id/profile',
    async (ctx, next) => {
      expect(ctx.params.id).toBe('42')
      expect(ctx.user).toEqual({ id: 'u1' })
      await next()
    },
    ({ params, user }) => ({ routeId: params.id, userId: user.id })
  )
  app.listen({ port: 0 })

  const res = await call(
    handler,
    new Request('http://localhost/users/42/profile')
  )
  expect(await res.json()).toEqual({ routeId: '42', userId: 'u1' })
})

test('route-level middleware: 405 does not run it', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  let middlewareCalled = false

  app.get(
    '/x',
    (_ctx, next) => {
      middlewareCalled = true
      return next()
    },
    () => ({ ok: true })
  )
  app.listen({ port: 0 })

  const res = await call(
    handler,
    new Request('http://localhost/x', { method: 'POST' })
  )
  expect(res.status).toBe(405)
  expect(middlewareCalled).toBe(false)
})

test('route-level middleware: a global middleware returning a Body after next() overrides the route body', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })

  app.use(async (_ctx, next) => {
    await next()
    return { from: 'global' }
  })
  app.get(
    '/x',
    async (_ctx, next) => {
      await next()
      return { from: 'route' }
    },
    () => ({ from: 'handler' })
  )
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/x'))
  expect(await res.json()).toEqual({ from: 'global' })
})

test('route-level middleware: duplicate route registration still throws', () => {
  const app = Arcton()
  app.get(
    '/dup',
    (_ctx, next) => next(),
    () => ({ ok: true })
  )

  expect(() =>
    app.get(
      '/dup',
      (_ctx, next) => next(),
      () => ({ ok: true })
    )
  ).toThrow()
})

test('registration order: a route registered before app.use() is not affected by it', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  let middlewareCalled = false

  app.get('/before', () => ({ ok: true }))
  app.use((_ctx, next) => {
    middlewareCalled = true
    return next()
  })
  app.get('/after', () => ({ ok: true }))
  app.listen({ port: 0 })

  await call(handler, new Request('http://localhost/before'))
  expect(middlewareCalled).toBe(false)

  await call(handler, new Request('http://localhost/after'))
  expect(middlewareCalled).toBe(true)
})

test('registration order: a route registered before app.provide() does not receive it', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })

  app.get('/before', ctx => ({
    user: (ctx as unknown as { user?: unknown }).user
  }))
  const withAuth = app.provide(() => ({ user: { id: 'u1' } }))
  withAuth.get('/after', ({ user }) => ({ user }))
  app.listen({ port: 0 })

  const before = await call(handler, new Request('http://localhost/before'))
  expect(await before.json()).toEqual({})

  const after = await call(handler, new Request('http://localhost/after'))
  expect(await after.json()).toEqual({ user: { id: 'u1' } })
})

test('registration order: interleaving use()/get() runs each route only against what preceded it', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  const order: string[] = []

  app.use(async (_ctx, next) => {
    order.push('A')
    await next()
  })
  app.get('/one', () => {
    order.push('handler-one')
    return { ok: true }
  })
  app.use(async (_ctx, next) => {
    order.push('B')
    await next()
  })
  app.get('/two', () => {
    order.push('handler-two')
    return { ok: true }
  })
  app.listen({ port: 0 })

  await call(handler, new Request('http://localhost/one'))
  expect(order).toEqual(['A', 'handler-one'])

  order.length = 0
  await call(handler, new Request('http://localhost/two'))
  expect(order).toEqual(['A', 'B', 'handler-two'])
})

// ── use(scope, mw) — path-scoped middleware ─────────────────────────────────

test('use(scope, mw): only runs for routes under that scope', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  let authRan = false

  app.use('/api', () => {
    authRan = true
  })
  app.get('/api/users', () => ({ ok: true }))
  app.get('/health', () => ({ ok: true }))
  app.listen({ port: 0 })

  await call(handler, new Request('http://localhost/health'))
  expect(authRan).toBe(false)

  await call(handler, new Request('http://localhost/api/users'))
  expect(authRan).toBe(true)
})

test('use(scope, mw): matches the scope itself and nested paths, not a mere string prefix', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  const ran: string[] = []

  app.use('/api', () => {
    ran.push('auth')
  })
  app.get('/api', () => ({ ok: true }))
  app.get('/api/users/:id', () => ({ ok: true }))
  app.get('/apiary', () => ({ ok: true }))
  app.listen({ port: 0 })

  await call(handler, new Request('http://localhost/api'))
  await call(handler, new Request('http://localhost/api/users/1'))
  await call(handler, new Request('http://localhost/apiary'))

  expect(ran).toEqual(['auth', 'auth']) // /apiary did not trigger it
})

test('use(scope, mw): registration-order semantics — only applies to routes registered after it', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  let authRan = false

  app.get('/api/users', () => {
    authRan = false
    return { ok: true }
  })
  app.use('/api', () => {
    authRan = true
  })
  app.get('/api/orders', () => {
    return { ok: true }
  })
  app.listen({ port: 0 })

  await call(handler, new Request('http://localhost/api/users'))
  expect(authRan).toBe(false)

  await call(handler, new Request('http://localhost/api/orders'))
  expect(authRan).toBe(true)
})

test('use(scope, mw): 404 does not run it', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  let authRan = false

  app.use('/api', () => {
    authRan = true
  })
  app.get('/api/users', () => ({ ok: true }))
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/api/missing'))
  expect(res.status).toBe(404)
  expect(authRan).toBe(false)
})

test('use(scope, mw): composes with global and route-level middleware in registration order', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  const order: string[] = []

  app.use(async (_ctx, next) => {
    order.push('global')
    await next()
  })
  app.use('/api', async (_ctx, next) => {
    order.push('scoped')
    await next()
  })
  app.get(
    '/api/users',
    async (_ctx, next) => {
      order.push('route')
      await next()
    },
    () => {
      order.push('handler')
      return { ok: true }
    }
  )
  app.listen({ port: 0 })

  await call(handler, new Request('http://localhost/api/users'))
  expect(order).toEqual(['global', 'scoped', 'route', 'handler'])
})

test('use(scope, mw): rejects a scope with a dynamic or wildcard segment', () => {
  const app = Arcton()
  expect(() => app.use('/api/:id', () => {})).toThrow(/must be a static path/)
  expect(() => app.use('/api/*rest', () => {})).toThrow(/must be a static path/)
})

// ── get/post(path, options) — validation ──────────────────────────────────

test('get(path, options): a params schema coerces params for the handler', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })

  app.get('/users/:id', {
    params: fakeSchema((p: Record<string, string>) => ({ id: Number(p.id) })),
    handler: ctx => ({ id: ctx.params.id, type: typeof ctx.params.id })
  })
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/users/42'))
  expect(await res.json()).toEqual({ id: 42, type: 'number' })
})

test('get(path, options): a failing params schema returns 400 with issues, handler does not run', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  let handlerCalled = false

  app.get('/users/:id', {
    params: fakeSchema((p: Record<string, string>) => {
      if (Number.isNaN(Number(p.id))) throw new Error('id must be numeric')
      return { id: Number(p.id) }
    }),
    handler: () => {
      handlerCalled = true
      return { ok: true }
    }
  })
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/users/abc'))
  expect(handlerCalled).toBe(false)
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({
    issues: [{ message: 'id must be numeric' }]
  })
})

test('post(path, options): a body schema validates a JSON body into ctx.body', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })

  app.post('/users', {
    body: fakeSchema((b: { name: string }) => ({ name: b.name.trim() })),
    handler: ctx => ({ name: ctx.body.name })
  })
  app.listen({ port: 0 })

  const res = await call(
    handler,
    new Request('http://localhost/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  Ivan  ' })
    })
  )
  expect(await res.json()).toEqual({ name: 'Ivan' })
})

test('post(path, options): an unsupported body content-type returns 415', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })

  app.post('/users', {
    body: fakeSchema((b: { name: string }) => b),
    handler: ctx => ({ name: ctx.body.name })
  })
  app.listen({ port: 0 })

  const res = await call(
    handler,
    new Request('http://localhost/users', {
      method: 'POST',
      headers: { 'content-type': 'application/xml' },
      body: 'not json'
    })
  )
  expect(res.status).toBe(415)
})

test('get(path, options): combined with provide() and route-level middleware', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter }).provide(() => ({ user: { id: 'u1' } }))
  let sawInMiddleware: unknown

  app.get('/users/:id', {
    params: fakeSchema((p: Record<string, string>) => ({ id: Number(p.id) })),
    middleware: [
      async (ctx, next) => {
        sawInMiddleware = { id: ctx.params.id, user: ctx.user }
        await next()
      }
    ],
    handler: ctx => ({ id: ctx.params.id, user: ctx.user })
  })
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/users/9'))
  expect(sawInMiddleware).toEqual({ id: 9, user: { id: 'u1' } })
  expect(await res.json()).toEqual({ id: 9, user: { id: 'u1' } })
})

test('get(path, options): global middleware still sees raw, un-coerced params/query', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  let sawInGlobal: unknown

  app.use(async (ctx, next) => {
    sawInGlobal = ctx.params
    await next()
  })
  app.get('/users/:id', {
    params: fakeSchema((p: Record<string, string>) => ({ id: Number(p.id) })),
    handler: ctx => ({ id: ctx.params.id })
  })
  app.listen({ port: 0 })

  await call(handler, new Request('http://localhost/users/9'))
  expect(sawInGlobal).toEqual({ id: '9' }) // raw string, not coerced
})

test('get(path, handler): plain-handler shape is unaffected — no validate step, no schema', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })

  app.get('/users/:id', ctx => ({
    id: ctx.params.id,
    type: typeof ctx.params.id
  }))
  app.listen({ port: 0 })

  const res = await call(handler, new Request('http://localhost/users/42'))
  expect(await res.json()).toEqual({ id: '42', type: 'string' })
})

// ── app.parser() — body parsers ─────────────────────────────────────────────

test('a body schema against multipart/form-data validates the parsed FormData', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })

  app.post('/upload', {
    body: fakeSchema((f: FormData) => ({ name: f.get('name') })),
    handler: ctx => ctx.body
  })
  app.listen({ port: 0 })

  const form = new FormData()
  form.set('name', 'Ivan')
  const res = await call(
    handler,
    new Request('http://localhost/upload', { method: 'POST', body: form })
  )
  expect(await res.json()).toEqual({ name: 'Ivan' })
})

test('app.parser(): a custom parser handles its registered media type', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })

  app.parser('application/vnd.foo', async request => {
    const text = await request.text()
    return { n: Number(text.split(':')[1]) }
  })
  app.post('/foo', {
    body: fakeSchema((v: { n: number }) => v),
    handler: ctx => ctx.body
  })
  app.listen({ port: 0 })

  const res = await call(
    handler,
    new Request('http://localhost/foo', {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.foo' },
      body: 'FOO:42'
    })
  )
  expect(await res.json()).toEqual({ n: 42 })
})

test('app.parser(): registering the same media type again replaces the previous parser', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })

  app.parser('application/json', async () => ({ from: 'first' }))
  app.parser('application/json', async () => ({ from: 'second' }))
  app.post('/echo', {
    body: fakeSchema((v: { from: string }) => v),
    handler: ctx => ctx.body
  })
  app.listen({ port: 0 })

  const res = await call(
    handler,
    new Request('http://localhost/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
  )
  expect(await res.json()).toEqual({ from: 'second' })
})

test('app.parser(): a throwing custom parser propagates uncaught', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ adapter })
  const err = new Error('custom parser boom')

  app.parser('application/vnd.foo', () => {
    throw err
  })
  app.post('/foo', {
    body: fakeSchema((v: unknown) => ({ v })),
    handler: ctx => ctx.body
  })
  app.listen({ port: 0 })

  await expect(
    call(
      handler,
      new Request('http://localhost/foo', {
        method: 'POST',
        headers: { 'content-type': 'application/vnd.foo' },
        body: 'irrelevant'
      })
    )
  ).rejects.toBe(err)
})
