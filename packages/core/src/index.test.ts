import { expect, test } from 'bun:test'
import type {
  Body,
  RuntimeAdapter,
  RuntimeHandler,
  RuntimeRequestContext,
  StandardSchemaV1
} from '@arcton/contracts'
import { Arcton, Http, HttpError, ValidationError } from './index'

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
  const app = Arcton({ prefix: '/api' })
  expect(app.config.prefix).toBe('/api')
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

test('.ws() bypasses the HTTP pipeline entirely — global use()/provide() never run for it', async () => {
  const app = Arcton().provide(() => ({ user: { id: 'u1' } }))
  let middlewareRan = false

  app.use(async (_ctx, next) => {
    middlewareRan = true
    await next()
  })
  app.ws('/chat', {
    open(ws) {
      ws.send('connected')
    },
    message() {}
  })

  const server = app.listen({ port: 0 })
  const wsUrl = new URL('/chat', server.url)
  wsUrl.protocol = 'ws:'
  const ws = new WebSocket(wsUrl)

  const opened = new Promise<string>(resolve => {
    ws.addEventListener('message', event => resolve(event.data as string))
  })
  expect(await opened).toBe('connected')
  expect(middlewareRan).toBe(false)

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
  const app = Arcton()

  app.get('/users/:id', ctx => ({ id: ctx.params.id }))
  app.post('/users/:id', ctx => ({ updated: ctx.params.id }))

  app.listen({ port: 0, adapter })

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

// ── app.all() ────────────────────────────────────────────────────────────

test('app.all(): a single registration answers every HTTP method Arcton supports', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()

  app.all('/api/auth/*path', ctx => ({ path: ctx.params.path }))
  app.listen({ port: 0, adapter })

  for (const method of [
    'GET',
    'POST',
    'PUT',
    'DELETE',
    'PATCH',
    'OPTIONS'
  ] as const) {
    const res = await call(
      handler,
      new Request('http://localhost/api/auth/session', { method })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ path: 'session' })
  }

  // HEAD mirrors GET but Bun/undici strip the body — only the status is
  // meaningful here.
  const head = await call(
    handler,
    new Request('http://localhost/api/auth/session', { method: 'HEAD' })
  )
  expect(head.status).toBe(200)
})

test('app.all(): a wildcard needs a segment — the bare prefix alone still 404s unless registered separately', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()

  app.all('/api/auth/*path', () => ({ ok: true }))
  app.listen({ port: 0, adapter })

  const bare = await call(handler, new Request('http://localhost/api/auth'))
  expect(bare.status).toBe(404)
})

test('app.all(): registering a specific method on the same path afterwards throws, same as registering that method twice', () => {
  const app = Arcton()
  app.all('/webhook', () => ({ ok: true }))

  expect(() => app.post('/webhook', () => ({ ok: true }))).toThrow(
    'Duplicate route: POST /webhook is already registered'
  )
})

test('app.all(): registering it on a path that already has a specific method throws without partially registering the rest', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()

  app.put('/webhook', () => ({ updated: true }))
  expect(() => app.all('/webhook', () => ({ ok: true }))).toThrow(
    'Duplicate route: PUT /webhook is already registered'
  )

  app.listen({ port: 0, adapter })

  // GET/POST/etc. were earlier in ALL_METHODS than the conflicting PUT —
  // none of them should have been registered by the failed app.all() call,
  // so the node still only knows about the original PUT (405, not matched).
  const get = await call(handler, new Request('http://localhost/webhook'))
  expect(get.status).toBe(405)
  expect(get.headers.get('Allow')).toBe('PUT')

  const put = await call(
    handler,
    new Request('http://localhost/webhook', { method: 'PUT' })
  )
  expect(put.status).toBe(200)
  expect(await put.json()).toEqual({ updated: true })
})

test('app.all(): composes with provide()/route-level middleware exactly like get()/post() — the better-auth mount pattern', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton().provide(ctx => ({
    user:
      ctx.request.headers.get('authorization') === 'secret' ? { id: 1 } : null
  }))

  app.all(
    '/api/auth/*path',
    async (ctx, next) => {
      if (!ctx.user) return new Response('Unauthorized', { status: 401 })
      await next()
    },
    ctx => ({ userId: ctx.user!.id, path: ctx.params.path })
  )
  app.listen({ port: 0, adapter })

  const unauthorized = await call(
    handler,
    new Request('http://localhost/api/auth/session', { method: 'POST' })
  )
  expect(unauthorized.status).toBe(401)

  const authorized = await call(
    handler,
    new Request('http://localhost/api/auth/session', {
      method: 'POST',
      headers: { authorization: 'secret' }
    })
  )
  expect(authorized.status).toBe(200)
  expect(await authorized.json()).toEqual({ userId: 1, path: 'session' })
})

test('mapResponse: null/undefined/void → empty body, status 200', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/undefined', () => undefined)
  app.get('/null', () => null as unknown as Body)
  app.get('/void', () => {})
  app.listen({ port: 0, adapter })

  for (const path of ['/undefined', '/null', '/void']) {
    const res = await call(handler, new Request(`http://localhost${path}`))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  }
})

test('mapResponse: Response result is returned as-is, ctx.response fully ignored', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/', ctx => {
    ctx.response.status = 500
    ctx.response.headers.set('X-Should-Not-Appear', 'yes')
    return new Response('escape hatch', {
      status: 201,
      headers: { 'X-Custom': 'ok' }
    })
  })
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.status).toBe(201)
  expect(res.headers.get('X-Custom')).toBe('ok')
  expect(res.headers.get('X-Should-Not-Appear')).toBeNull()
  expect(await res.text()).toBe('escape hatch')
})

test('mapResponse: string without explicit Content-Type → text/plain; charset=UTF-8', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/', () => 'hello')
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.headers.get('Content-Type')).toBe('text/plain; charset=UTF-8')
  expect(await res.text()).toBe('hello')
})

test('mapResponse: string with explicit Content-Type is respected', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/', ctx => {
    ctx.response.headers.set('Content-Type', 'text/csv')
    return 'a,b,c'
  })
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.headers.get('Content-Type')).toBe('text/csv')
  expect(await res.text()).toBe('a,b,c')
})

test('mapResponse: Blob with .type set → uses blob.type', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/', () => new Blob(['hi'], { type: 'image/png' }))
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.headers.get('Content-Type')).toBe('image/png')
})

test('mapResponse: Blob without .type (and no explicit Content-Type) → application/octet-stream', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/', () => new Blob(['hi']))
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
})

test('mapResponse: FormData → multipart/form-data; boundary=..., ignores explicit Content-Type', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/', ctx => {
    ctx.response.headers.set('Content-Type', 'application/json')
    const form = new FormData()
    form.set('a', 'b')
    return form
  })
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.headers.get('Content-Type')).toMatch(
    /^multipart\/form-data; boundary=/
  )

  const body = await res.formData()
  expect(body.get('a')).toBe('b')
})

test('mapResponse: URLSearchParams → application/x-www-form-urlencoded;charset=UTF-8', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/', () => new URLSearchParams({ a: 'b' }))
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.headers.get('Content-Type')).toBe(
    'application/x-www-form-urlencoded;charset=UTF-8'
  )
  expect(await res.text()).toBe('a=b')
})

test('mapResponse: Uint8Array → application/octet-stream', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/', () => new Uint8Array([1, 2, 3]))
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(
    new Uint8Array([1, 2, 3])
  )
})

test('mapResponse: Int32Array (any ArrayBufferView, not just Uint8Array) → application/octet-stream', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/', () => new Int32Array([1, 2, 3]))
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
})

test('mapResponse: object/array → application/json; charset=UTF-8', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/object', () => ({ ok: true }))
  app.get('/array', () => [1, 2, 3])
  app.listen({ port: 0, adapter })

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
  const app = Arcton()
  app.get('/', () => new Map([['a', 1]]))
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.headers.get('Content-Type')).toBe(
    'application/json; charset=UTF-8'
  )
  expect(await res.text()).toBe('{}')
})

test('mapResponse: an unserializable runtime value (e.g. number, no static types) throws', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/', () => 42 as unknown as Body)
  app.listen({ port: 0, adapter })

  await expect(call(handler, new Request('http://localhost/'))).rejects.toThrow(
    /number/
  )
})

test('mapResponse: ctx.response.status outside [200, 599] throws a descriptive error', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/', ctx => {
    ctx.response.status = 700
    return { ok: true }
  })
  app.listen({ port: 0, adapter })

  await expect(call(handler, new Request('http://localhost/'))).rejects.toThrow(
    /700/
  )
})

test("mapResponse: a non-integer status (e.g. NaN) throws Arcton's own descriptive error", async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/', ctx => {
    ctx.response.status = Number.NaN
    return { ok: true }
  })
  app.listen({ port: 0, adapter })

  await expect(call(handler, new Request('http://localhost/'))).rejects.toThrow(
    /Invalid response status NaN/
  )
})

test('mapResponse: ctx.response.headers merge on top of the inferred headers', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/', ctx => {
    ctx.response.headers.set('X-Trace', '123')
    return { ok: true }
  })
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.headers.get('Content-Type')).toBe(
    'application/json; charset=UTF-8'
  )
  expect(res.headers.get('X-Trace')).toBe('123')
})

test('mapResponse: status 204 forces a null body — inferred Content-Type dropped, explicit headers pass through', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/', ctx => {
    ctx.response.status = 204
    ctx.response.headers.set('X-Explicit', 'yes')
    return { ok: true }
  })
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.status).toBe(204)
  expect(await res.text()).toBe('')
  expect(res.headers.get('Content-Type')).toBeNull()
  expect(res.headers.get('X-Explicit')).toBe('yes')
})

test('mapResponse: status 204 forces a null body — explicit Content-Type survives, unlike the inferred one above', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/', ctx => {
    ctx.response.status = 204
    ctx.response.headers.set('Content-Type', 'text/plain; charset=UTF-8')
    return { ok: true }
  })
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.status).toBe(204)
  expect(await res.text()).toBe('')
  expect(res.headers.get('Content-Type')).toBe('text/plain; charset=UTF-8')
})

// ── ctx.query — end-to-end, not part of the router/MatchResult ──────────────

test('ctx.query: no query string → {}', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/', ctx => ctx.query)
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/'))
  expect(await res.json()).toEqual({})
})

test('ctx.query: a key with no value → empty string', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/', ctx => ctx.query)
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/?q='))
  expect(await res.json()).toEqual({ q: '' })
})

test('ctx.query: repeated key → last value wins', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/', ctx => ctx.query)
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/?a=1&a=2'))
  expect(await res.json()).toEqual({ a: '2' })
})

test('ctx.query: "+" decodes as a space', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/', ctx => ctx.query)
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/?a=b+c'))
  expect(await res.json()).toEqual({ a: 'b c' })
})

test('error path: a synchronously throwing handler propagates uncaught', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  const err = new Error('handler boom')
  app.get('/', () => {
    throw err
  })
  app.listen({ port: 0, adapter })

  await expect(call(handler, new Request('http://localhost/'))).rejects.toBe(
    err
  )
})

test('error path: a rejecting async handler propagates uncaught', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  const err = new Error('async boom')
  app.get('/', async () => {
    throw err
  })
  app.listen({ port: 0, adapter })

  await expect(call(handler, new Request('http://localhost/'))).rejects.toBe(
    err
  )
})

test('error path: mapResponse throwing propagates uncaught, unnormalized', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/', () => 42 as unknown as Body)
  app.listen({ port: 0, adapter })

  await expect(call(handler, new Request('http://localhost/'))).rejects.toThrow(
    /Cannot serialize handler result/
  )
})

// ── app.onError() ────────────────────────────────────────────────────────

test('app.onError(): catches an otherwise-uncaught error and answers with the handler’s response', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/', () => {
    throw new Error('boom')
  })
  app.onError((err, ctx) => {
    ctx.response.status = 418
    return { message: (err as Error).message }
  })
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.status).toBe(418)
  expect(await res.json()).toEqual({ message: 'boom' })
})

test("app.onError(): ctx.response.status defaults to 500 when the handler doesn't set one", async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/', () => {
    throw new Error('boom')
  })
  app.onError(() => ({ message: 'failed' }))
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.status).toBe(500)
})

test('app.onError(): a status set before the throw is preserved if the handler leaves it untouched', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/', ctx => {
    ctx.response.status = 202
    throw new Error('boom')
  })
  app.onError(() => ({ message: 'failed' }))
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.status).toBe(202)
})

test('app.onError(): can narrow the error and return a raw Response directly', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/', () => {
    throw Http.Unauthorized('nope')
  })
  app.onError((err, ctx) => {
    if (err instanceof HttpError) {
      ctx.response.status = err.status
      return new Response(err.message, { status: err.status })
    }
    return new Response('Internal Server Error', { status: 500 })
  })
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.status).toBe(401)
  expect(await res.text()).toBe('nope')
})

test('app.onError(): also catches an error thrown by global middleware running on the 404 fallback', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.use(async () => {
    throw new Error('middleware boom')
  })
  app.onError((err, ctx) => {
    ctx.response.status = 500
    return { message: (err as Error).message }
  })
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/missing'))
  expect(res.status).toBe(500)
  expect(await res.json()).toEqual({ message: 'middleware boom' })
})

test('app.onError(): a later call replaces an earlier one', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/', () => {
    throw new Error('boom')
  })
  app.onError(() => ({ from: 'first' }))
  app.onError(() => ({ from: 'second' }))
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/'))
  expect(await res.json()).toEqual({ from: 'second' })
})

test('app.onError(): registered on a module has no effect — only the instance whose listen() runs is consulted', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const users = Arcton()
  users.get('/users', () => {
    throw new Error('module boom')
  })
  users.onError(() => ({ from: 'module' }))

  const app = Arcton()
  app.use(users)
  app.onError((err, ctx) => {
    ctx.response.status = 500
    return { from: 'app', message: (err as Error).message }
  })
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/users'))
  expect(res.status).toBe(500)
  expect(await res.json()).toEqual({ from: 'app', message: 'module boom' })
})

test('app.onError(): if the handler itself throws, that error propagates uncaught rather than being re-handled', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/', () => {
    throw new Error('original boom')
  })
  const onErrorFailure = new Error('onError itself failed')
  app.onError(() => {
    throw onErrorFailure
  })
  app.listen({ port: 0, adapter })

  await expect(call(handler, new Request('http://localhost/'))).rejects.toBe(
    onErrorFailure
  )
})

test('app.onError(): with none registered, an uncaught error still propagates exactly as before', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  const err = new Error('boom')
  app.get('/', () => {
    throw err
  })
  app.listen({ port: 0, adapter })

  await expect(call(handler, new Request('http://localhost/'))).rejects.toBe(
    err
  )
})

test('app.use: a global middleware setting a header on the way out reaches the Response', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()

  app.use(async (ctx, next) => {
    await next()
    ctx.response.headers.set('X-Powered-By', 'arcton')
  })
  app.get('/', () => ({ ok: true }))
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.headers.get('X-Powered-By')).toBe('arcton')
})

test('app.use: replacing the body after next() inherits headers already set on ctx.response', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()

  app.use(async (ctx, next) => {
    await next()
    ctx.response.headers.set('X-Trace', 'outer')
    return { replaced: true }
  })
  app.get('/', () => ({ original: true }))
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.headers.get('X-Trace')).toBe('outer')
  expect(await res.json()).toEqual({ replaced: true })
})

test('app.use: replacing with a raw Response after next() overrides completely, no header inheritance', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()

  app.use(async (ctx, next) => {
    await next()
    ctx.response.headers.set('X-Trace', 'outer')
    return new Response('replaced', { status: 201 })
  })
  app.get('/', () => ({ original: true }))
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.status).toBe(201)
  expect(res.headers.get('X-Trace')).toBeNull()
  expect(await res.text()).toBe('replaced')
})

test('app.use: short-circuit middleware returning an object skips the handler', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  let handlerCalled = false

  app.use(() => ({ blocked: true }))
  app.get('/', () => {
    handlerCalled = true
    return { ok: true }
  })
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/'))
  expect(handlerCalled).toBe(false)
  expect(await res.json()).toEqual({ blocked: true })
})

test('app.use: middleware never calling next() and returning nothing rejects — handler never runs', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  let handlerCalled = false

  app.use(async () => {})
  app.get('/', () => {
    handlerCalled = true
    return { ok: true }
  })
  app.listen({ port: 0, adapter })

  await expect(call(handler, new Request('http://localhost/'))).rejects.toThrow(
    'Middleware completed without calling next() or returning a response'
  )
  expect(handlerCalled).toBe(false)
})

test('app.use: middleware calling next() twice surfaces as an uncaught error, not a double-executed handler', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  let handlerCalls = 0

  app.use(async (_ctx, next) => {
    await next()
    await next()
  })
  app.get('/', () => {
    handlerCalls++
    return { ok: true }
  })
  app.listen({ port: 0, adapter })

  await expect(call(handler, new Request('http://localhost/'))).rejects.toThrow(
    'next() was already called by this middleware'
  )
  expect(handlerCalls).toBe(1)
})

test("an unmatched route resolves directly to Http.NotFound()'s shape, without throwing or needing any registered middleware", async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/exists', () => ({ ok: true }))
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/missing'))

  expect(res.status).toBe(404)
  const notFound = Http.NotFound()
  expect(await res.json()).toEqual({
    code: notFound.code,
    message: notFound.message
  })
})

test('app.use: global middleware runs on 404, e.g. to set CORS headers on it', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  let middlewareCalled = false

  app.use(async (ctx, next) => {
    middlewareCalled = true
    await next()
    ctx.response.headers.set('Access-Control-Allow-Origin', '*')
  })
  app.get('/exists', () => ({ ok: true }))
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/missing'))
  expect(res.status).toBe(404)
  expect(middlewareCalled).toBe(true)
  expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
})

test('app.use: global middleware runs on 405, alongside the Allow header', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()

  app.use(async (ctx, next) => {
    await next()
    ctx.response.headers.set('X-Powered-By', 'arcton')
  })
  app.get('/users', () => ({ ok: true }))
  app.listen({ port: 0, adapter })

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
  const app = Arcton()

  app.get('/exists', () => ({ ok: true })) // registered BEFORE the use() below
  app.use(async (ctx, next) => {
    await next()
    ctx.response.headers.set('X-Trace', 'yes')
  })
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/missing'))
  expect(res.status).toBe(404)
  expect(res.headers.get('X-Trace')).toBe('yes')
})

test("use(scope, mw): does NOT run on 404/405 — there's no matched route to belong to", async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  let scopedCalled = false

  app.use('/api', () => {
    scopedCalled = true
  })
  app.get('/api/users', () => ({ ok: true }))
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/api/missing'))
  expect(res.status).toBe(404)
  expect(scopedCalled).toBe(false)
})

test('route-level middleware does NOT run on 404/405', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  let routeMwCalled = false

  app.get(
    '/users',
    async (_ctx, next) => {
      routeMwCalled = true
      await next()
    },
    () => ({ ok: true })
  )
  app.listen({ port: 0, adapter })

  const res = await call(
    handler,
    new Request('http://localhost/users', { method: 'POST' })
  )
  expect(res.status).toBe(405)
  expect(routeMwCalled).toBe(false)
})

test('app.provide: a provided value is flat on ctx for handlers registered after it', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton().provide(async () => ({ user: { id: 'u1' } }))

  app.get('/me', ({ user }) => ({ userId: user.id }))
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/me'))
  expect(await res.json()).toEqual({ userId: 'u1' })
})

test('app.provide: composes — a later provide() reads what an earlier one added', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
    .provide(async () => ({ user: { id: 'u1' } }))
    .provide(async ({ user }) => ({ permissions: [user.id] }))

  app.get('/whoami', ({ user, permissions }) => ({ user, permissions }))
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/whoami'))
  expect(await res.json()).toEqual({ user: { id: 'u1' }, permissions: ['u1'] })
})

test('app.provide: a use() registered after it can read the provided value', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton().provide(() => ({ user: { id: 'u1' } }))
  let sawUser: unknown

  app.use(async (ctx, next) => {
    sawUser = ctx.user
    await next()
  })
  app.get('/', () => ({ ok: true }))
  app.listen({ port: 0, adapter })

  await call(handler, new Request('http://localhost/'))
  expect(sawUser).toEqual({ id: 'u1' })
})

test('route-level middleware: runs only for that route, nested inside global middleware', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
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
  app.listen({ port: 0, adapter })

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
  const app = Arcton().provide(() => ({ user: { id: 'u1' } }))

  app.get(
    '/users/:id/profile',
    async (ctx, next) => {
      expect(ctx.params.id).toBe('42')
      expect(ctx.user).toEqual({ id: 'u1' })
      await next()
    },
    ({ params, user }) => ({ routeId: params.id, userId: user.id })
  )
  app.listen({ port: 0, adapter })

  const res = await call(
    handler,
    new Request('http://localhost/users/42/profile')
  )
  expect(await res.json()).toEqual({ routeId: '42', userId: 'u1' })
})

test('route-level middleware: 405 does not run it', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  let middlewareCalled = false

  app.get(
    '/x',
    (_ctx, next) => {
      middlewareCalled = true
      return next()
    },
    () => ({ ok: true })
  )
  app.listen({ port: 0, adapter })

  const res = await call(
    handler,
    new Request('http://localhost/x', { method: 'POST' })
  )
  expect(res.status).toBe(405)
  expect(middlewareCalled).toBe(false)
})

test('route-level middleware: a global middleware returning a Body after next() overrides the route body', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()

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
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/x'))
  expect(await res.json()).toEqual({ from: 'global' })
})

test('a RouteOptions object with no handler throws at registration, not at request time', () => {
  const app = Arcton()

  expect(() =>
    // @ts-expect-error deliberately missing `handler`
    app.get('/x', {})
  ).toThrow(/requires a "handler" function/)
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
  const app = Arcton()
  let middlewareCalled = false

  app.get('/before', () => ({ ok: true }))
  app.use((_ctx, next) => {
    middlewareCalled = true
    return next()
  })
  app.get('/after', () => ({ ok: true }))
  app.listen({ port: 0, adapter })

  await call(handler, new Request('http://localhost/before'))
  expect(middlewareCalled).toBe(false)

  await call(handler, new Request('http://localhost/after'))
  expect(middlewareCalled).toBe(true)
})

test('registration order: a route registered before app.provide() does not receive it', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()

  app.get('/before', ctx => ({
    user: (ctx as unknown as { user?: unknown }).user
  }))
  const withAuth = app.provide(() => ({ user: { id: 'u1' } }))
  withAuth.get('/after', ({ user }) => ({ user }))
  app.listen({ port: 0, adapter })

  const before = await call(handler, new Request('http://localhost/before'))
  expect(await before.json()).toEqual({})

  const after = await call(handler, new Request('http://localhost/after'))
  expect(await after.json()).toEqual({ user: { id: 'u1' } })
})

test('registration order: interleaving use()/get() runs each route only against what preceded it', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
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
  app.listen({ port: 0, adapter })

  await call(handler, new Request('http://localhost/one'))
  expect(order).toEqual(['A', 'handler-one'])

  order.length = 0
  await call(handler, new Request('http://localhost/two'))
  expect(order).toEqual(['A', 'B', 'handler-two'])
})

// ── use(scope, mw) — path-scoped middleware ─────────────────────────────────

test('use(scope, mw): only runs for routes under that scope', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  let authRan = false

  app.use('/api', (_ctx, next) => {
    authRan = true
    return next()
  })
  app.get('/api/users', () => ({ ok: true }))
  app.get('/health', () => ({ ok: true }))
  app.listen({ port: 0, adapter })

  await call(handler, new Request('http://localhost/health'))
  expect(authRan).toBe(false)

  await call(handler, new Request('http://localhost/api/users'))
  expect(authRan).toBe(true)
})

test('use(scope, mw): matches the scope itself and nested paths, not a mere string prefix', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  const ran: string[] = []

  app.use('/api', (_ctx, next) => {
    ran.push('auth')
    return next()
  })
  app.get('/api', () => ({ ok: true }))
  app.get('/api/users/:id', () => ({ ok: true }))
  app.get('/apiary', () => ({ ok: true }))
  app.listen({ port: 0, adapter })

  await call(handler, new Request('http://localhost/api'))
  await call(handler, new Request('http://localhost/api/users/1'))
  await call(handler, new Request('http://localhost/apiary'))

  expect(ran).toEqual(['auth', 'auth']) // /apiary did not trigger it
})

test('use(scope, mw): registration-order semantics — only applies to routes registered after it', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  let authRan = false

  app.get('/api/users', () => {
    authRan = false
    return { ok: true }
  })
  app.use('/api', (_ctx, next) => {
    authRan = true
    return next()
  })
  app.get('/api/orders', () => {
    return { ok: true }
  })
  app.listen({ port: 0, adapter })

  await call(handler, new Request('http://localhost/api/users'))
  expect(authRan).toBe(false)

  await call(handler, new Request('http://localhost/api/orders'))
  expect(authRan).toBe(true)
})

test('use(scope, mw): 404 does not run it', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  let authRan = false

  app.use('/api', () => {
    authRan = true
  })
  app.get('/api/users', () => ({ ok: true }))
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/api/missing'))
  expect(res.status).toBe(404)
  expect(authRan).toBe(false)
})

test('use(scope, mw): composes with global and route-level middleware in registration order', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
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
  app.listen({ port: 0, adapter })

  await call(handler, new Request('http://localhost/api/users'))
  expect(order).toEqual(['global', 'scoped', 'route', 'handler'])
})

test('use(scope, mw): rejects a scope with a dynamic or wildcard segment', () => {
  const app = Arcton()
  expect(() => app.use('/api/:id', () => {})).toThrow(/must be a static path/)
  expect(() => app.use('/api/*rest', () => {})).toThrow(/must be a static path/)
})

// ── ArctonConfig.prefix ──────────────────────────────────────────────────

test('ArctonConfig.prefix is applied to routes registered directly on this instance', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ prefix: '/api' })

  app.get('/users', () => ({ ok: true }))
  app.listen({ port: 0, adapter })

  const prefixed = await call(
    handler,
    new Request('http://localhost/api/users')
  )
  expect(prefixed.status).toBe(200)

  const unprefixed = await call(handler, new Request('http://localhost/users'))
  expect(unprefixed.status).toBe(404)
})

test('prefix "/" is equivalent to no prefix at all', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ prefix: '/' })

  app.get('/users', () => ({ ok: true }))
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/users'))
  expect(res.status).toBe(200)
})

test('a dynamic/wildcard prefix is rejected at Arcton() construction time', () => {
  expect(() => Arcton({ prefix: '/api/:id' })).toThrow(/must be a static path/)
  expect(() => Arcton({ prefix: '/api/*rest' })).toThrow(
    /must be a static path/
  )
})

test('ws() on a prefixed instance registers the ws route under that prefix', () => {
  let capturedWsRoutes: { path: string }[] = []
  const adapter: RuntimeAdapter = {
    name: 'test',
    version: '0.0.0',
    capabilities: { websocket: true },
    serve(options) {
      capturedWsRoutes = options.websocket ?? []
      return {
        port: options.port,
        url: new URL(`http://localhost:${options.port}`),
        stop() {}
      }
    }
  }
  const app = Arcton({ prefix: '/api' })

  app.ws('/chat', { message() {} })
  app.listen({ port: 0, adapter })

  expect(capturedWsRoutes.map(route => route.path)).toEqual(['/api/chat'])
})

// ── ws() capability check — deferred to listen() ────────────────────────

function createNonWsAdapter(): RuntimeAdapter {
  return {
    name: 'no-ws',
    version: '0.0.0',
    capabilities: { websocket: false },
    serve(options) {
      return {
        port: options.port,
        url: new URL(`http://localhost:${options.port}`),
        stop() {}
      }
    }
  }
}

test('ws() no longer throws immediately on a websocket-incapable adapter — checked at listen() instead', () => {
  const app = Arcton()
  expect(() => app.ws('/chat', { message() {} })).not.toThrow()
})

test('listen() throws if there are ws routes and the adapter does not support websocket', () => {
  const app = Arcton()
  app.ws('/chat', { message() {} })
  expect(() => app.listen({ port: 0, adapter: createNonWsAdapter() })).toThrow(
    /does not support WebSocket/
  )
})

test('listen() does not throw for a websocket-incapable adapter when there are no ws routes at all', () => {
  const app = Arcton()
  app.get('/', () => ({ ok: true }))
  expect(() =>
    app.listen({ port: 0, adapter: createNonWsAdapter() })
  ).not.toThrow()
})

test("listen() catches a ws route that reached this app only through a mounted module, checked against this app's own adapter", () => {
  const chat = Arcton({ prefix: '/chat' })
  chat.ws('/room', { message() {} })

  const app = Arcton({ prefix: '/api' })
  app.use(chat)

  expect(() => app.listen({ port: 0, adapter: createNonWsAdapter() })).toThrow(
    /does not support WebSocket/
  )
})

test('use(scope, mw) inside a prefixed instance compares against the module-local path, not the prefixed one', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ prefix: '/api' })
  let ran = false

  app.use('/users', (_ctx, next) => {
    ran = true
    return next()
  })
  app.get('/users', () => ({ ok: true }))
  app.get('/health', () => ({ ok: true }))
  app.listen({ port: 0, adapter })

  await call(handler, new Request('http://localhost/api/health'))
  expect(ran).toBe(false)

  await call(handler, new Request('http://localhost/api/users'))
  expect(ran).toBe(true)
})

test('use(scope, mw) written with the already-prefixed path does not match — scope stays module-local', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton({ prefix: '/api' })
  let ran = false

  app.use('/api/users', () => {
    ran = true
  })
  app.get('/users', () => ({ ok: true }))
  app.listen({ port: 0, adapter })

  await call(handler, new Request('http://localhost/api/users'))
  expect(ran).toBe(false)
})

// ── use(subApp) — module composition ────────────────────────────────────

test(".use(subApp) mounts a module — its own prefix combines with the mounting app's", async () => {
  const { adapter, fetch: handler } = createTestAdapter()

  const users = Arcton({ prefix: '/users' })
  users.get('/', () => ({ list: true }))
  users.get('/:id', ctx => ({ id: ctx.params.id }))

  const app = Arcton({ prefix: '/api' })
  app.use(users)
  app.listen({ port: 0, adapter })

  const list = await call(handler, new Request('http://localhost/api/users'))
  expect(await list.json()).toEqual({ list: true })

  const one = await call(handler, new Request('http://localhost/api/users/42'))
  expect(await one.json()).toEqual({ id: '42' })
})

test('.use(subApp): use()/provide() registered on the parent before the mount reach the module; after, do not', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const order: string[] = []

  const users = Arcton({ prefix: '/users' })
  users.get('/', ctx => {
    order.push('handler')
    return { db: (ctx as unknown as { db: string }).db }
  })

  const app = Arcton({ prefix: '/api' })
  app.use(async (_ctx, next) => {
    order.push('before')
    await next()
  })
  app.provide(() => ({ db: 'connected' }))
  app.use(users)
  app.use(async (_ctx, next) => {
    order.push('after')
    await next()
  })
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/api/users'))
  expect(await res.json()).toEqual({ db: 'connected' })
  expect(order).toEqual(['before', 'handler'])
})

test('.use(subApp): a scoped use() on the parent does not reach a mounted module', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  let scopedRan = false

  const users = Arcton({ prefix: '/users' })
  users.get('/', () => ({ ok: true }))

  const app = Arcton({ prefix: '/api' })
  app.use('/api/users', () => {
    scopedRan = true
  })
  app.use(users)
  app.listen({ port: 0, adapter })

  await call(handler, new Request('http://localhost/api/users'))
  expect(scopedRan).toBe(false)
})

test("a module's own use(scope, mw) still applies correctly after being mounted", async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  let ran = false

  const users = Arcton({ prefix: '/users' })
  users.use('/settings', (_ctx, next) => {
    ran = true
    return next()
  })
  users.get('/', () => ({ list: true }))
  users.get('/settings', () => ({ settings: true }))

  const app = Arcton({ prefix: '/api' })
  app.use(users)
  app.listen({ port: 0, adapter })

  await call(handler, new Request('http://localhost/api/users'))
  expect(ran).toBe(false)

  await call(handler, new Request('http://localhost/api/users/settings'))
  expect(ran).toBe(true)
})

test('.use(subApp): a ws() route registered inside a module gets both prefixes applied when mounted', () => {
  let capturedWsRoutes: { path: string }[] = []
  const adapter: RuntimeAdapter = {
    name: 'test',
    version: '0.0.0',
    capabilities: { websocket: true },
    serve(options) {
      capturedWsRoutes = options.websocket ?? []
      return {
        port: options.port,
        url: new URL(`http://localhost:${options.port}`),
        stop() {}
      }
    }
  }

  const chat = Arcton({ prefix: '/chat' })
  chat.ws('/room', { message() {} })

  const app = Arcton({ prefix: '/api' })
  app.use(chat)
  app.listen({ port: 0, adapter })

  expect(capturedWsRoutes.map(route => route.path)).toEqual(['/api/chat/room'])
})

test('.use(subApp): modules nest — a module composed of a sub-module mounts correctly', async () => {
  const { adapter, fetch: handler } = createTestAdapter()

  const profile = Arcton({ prefix: '/profile' })
  profile.get('/', () => ({ profile: true }))

  const users = Arcton({ prefix: '/users' })
  users.use(profile)
  users.get('/', () => ({ users: true }))

  const app = Arcton({ prefix: '/api' })
  app.use(users)
  app.listen({ port: 0, adapter })

  const usersRes = await call(
    handler,
    new Request('http://localhost/api/users')
  )
  expect(await usersRes.json()).toEqual({ users: true })

  const profileRes = await call(
    handler,
    new Request('http://localhost/api/users/profile')
  )
  expect(await profileRes.json()).toEqual({ profile: true })
})

test('.use(subApp): a duplicate (method, path) after mounting throws, same as a direct duplicate insert', () => {
  const users = Arcton({ prefix: '/users' })
  users.get('/', () => ({ ok: true }))

  const app = Arcton({ prefix: '/api' })
  app.get('/users', () => ({ ok: true }))

  expect(() => app.use(users)).toThrow(/Duplicate route/)
})

test('use() rejects a value that is neither a middleware function, a (scope, middleware) pair, nor an Arcton app', () => {
  const app = Arcton()
  expect(() =>
    (app.use as (value: unknown) => unknown)({ not: 'an arcton app' })
  ).toThrow(/expects a middleware function/)
})

// ── get/post(path, options) — validation ──────────────────────────────────

test('get(path, options): a params schema coerces params for the handler', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()

  app.get('/users/:id', {
    params: fakeSchema((p: Record<string, string>) => ({ id: Number(p.id) })),
    handler: ctx => ({ id: ctx.params.id, type: typeof ctx.params.id })
  })
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/users/42'))
  expect(await res.json()).toEqual({ id: 42, type: 'number' })
})

test('get(path, options): a failing params schema returns 400 with issues, handler does not run', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
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
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/users/abc'))
  expect(handlerCalled).toBe(false)
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({
    issues: [{ message: 'id must be numeric' }]
  })
})

test('post(path, options): a body schema validates a JSON body into ctx.body', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()

  app.post('/users', {
    body: fakeSchema((b: { name: string }) => ({ name: b.name.trim() })),
    handler: ctx => ({ name: ctx.body.name })
  })
  app.listen({ port: 0, adapter })

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
  const app = Arcton()

  app.post('/users', {
    body: fakeSchema((b: { name: string }) => b),
    handler: ctx => ({ name: ctx.body.name })
  })
  app.listen({ port: 0, adapter })

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
  const app = Arcton().provide(() => ({ user: { id: 'u1' } }))
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
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/users/9'))
  expect(sawInMiddleware).toEqual({ id: 9, user: { id: 'u1' } })
  expect(await res.json()).toEqual({ id: 9, user: { id: 'u1' } })
})

test('get(path, options): global middleware still sees raw, un-coerced params/query', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  let sawInGlobal: unknown

  app.use(async (ctx, next) => {
    sawInGlobal = ctx.params
    await next()
  })
  app.get('/users/:id', {
    params: fakeSchema((p: Record<string, string>) => ({ id: Number(p.id) })),
    handler: ctx => ({ id: ctx.params.id })
  })
  app.listen({ port: 0, adapter })

  await call(handler, new Request('http://localhost/users/9'))
  expect(sawInGlobal).toEqual({ id: '9' }) // raw string, not coerced
})

test('get(path, handler): plain-handler shape is unaffected — no validate step, no schema', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()

  app.get('/users/:id', ctx => ({
    id: ctx.params.id,
    type: typeof ctx.params.id
  }))
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/users/42'))
  expect(await res.json()).toEqual({ id: '42', type: 'string' })
})

// ── app.parser() — body parsers ─────────────────────────────────────────────

test('body content: multipart/form-data must be declared — it accepts multipart, validates the FormData and rejects JSON', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()

  app.post('/upload', {
    body: {
      content: {
        'multipart/form-data': fakeSchema((f: FormData) => ({
          name: f.get('name')
        }))
      }
    },
    handler: ctx => ctx.body
  })
  app.listen({ port: 0, adapter })

  const form = new FormData()
  form.set('name', 'Ivan')
  const res = await call(
    handler,
    new Request('http://localhost/upload', { method: 'POST', body: form })
  )
  expect(await res.json()).toEqual({ name: 'Ivan' })

  const asJson = await call(
    handler,
    new Request('http://localhost/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
  )
  expect(asJson.status).toBe(415)
})

test('app.parser(): a custom parser handles its registered media type', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()

  app.parser('application/vnd.foo', async request => {
    const text = await request.text()
    return { n: Number(text.split(':')[1]) }
  })
  app.post('/foo', {
    body: {
      content: { 'application/vnd.foo': fakeSchema((v: { n: number }) => v) }
    },
    handler: ctx => ctx.body
  })
  app.listen({ port: 0, adapter })

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
  const app = Arcton()

  app.parser('application/json', async () => ({ from: 'first' }))
  app.parser('application/json', async () => ({ from: 'second' }))
  app.post('/echo', {
    body: fakeSchema((v: { from: string }) => v),
    handler: ctx => ctx.body
  })
  app.listen({ port: 0, adapter })

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
  const app = Arcton()
  const err = new Error('custom parser boom')

  app.parser('application/vnd.foo', () => {
    throw err
  })
  app.post('/foo', {
    body: {
      content: { 'application/vnd.foo': fakeSchema((v: unknown) => ({ v })) }
    },
    handler: ctx => ctx.body
  })
  app.listen({ port: 0, adapter })

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

// ── optional body ────────────────────────────────────────────────────────

const postDismiss = (init: RequestInit = {}) =>
  new Request('http://localhost/dismiss', { method: 'POST', ...init })

test('body optional: a request with no body reaches the handler with ctx.body undefined, without running the schema', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  let schemaCalls = 0
  let seenInMiddleware: unknown = 'unset'
  app.post('/dismiss', {
    body: {
      schema: fakeSchema((b: unknown) => {
        schemaCalls++
        return b
      }),
      optional: true
    },
    middleware: [
      (ctx, next) => {
        seenInMiddleware = ctx.body
        return next()
      }
    ],
    handler: ctx => ({ absent: ctx.body === undefined })
  })
  app.listen({ port: 0, adapter })

  const res = await call(handler, postDismiss())
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ absent: true })
  expect(seenInMiddleware).toBeUndefined()
  expect(schemaCalls).toBe(0)
})

test('body optional: a Content-Type header alone, with no body, still counts as absent', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.post('/dismiss', {
    body: { schema: rejecting(), optional: true },
    handler: ctx => ({ absent: ctx.body === undefined })
  })
  app.listen({ port: 0, adapter })

  const res = await call(
    handler,
    postDismiss({ headers: { 'content-type': 'application/json' } })
  )
  expect(await res.json()).toEqual({ absent: true })
})

test('body optional: a present {} body is validated by the schema like any other', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.post('/dismiss', {
    body: {
      schema: fakeSchema((b: { reason?: string }) => ({
        reason: b.reason ?? 'none'
      })),
      optional: true
    },
    handler: ctx => ({ body: ctx.body ?? null })
  })
  app.listen({ port: 0, adapter })

  const res = await call(
    handler,
    postDismiss({
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
  )
  expect(await res.json()).toEqual({ body: { reason: 'none' } })
})

test('body optional: a present body that fails the schema is still a 400 with the issues', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.post('/dismiss', {
    body: { schema: rejecting(), optional: true },
    handler: () => 'ok'
  })
  app.listen({ port: 0, adapter })

  const res = await call(
    handler,
    postDismiss({
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
  )
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ issues: [{ message: 'nope' }] })
})

test('body optional: malformed JSON is still a 400, and an unsupported Content-Type still a 415', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.post('/dismiss', {
    body: { schema: rejecting(), optional: true },
    handler: () => 'ok'
  })
  app.listen({ port: 0, adapter })

  const malformed = await call(
    handler,
    postDismiss({
      headers: { 'content-type': 'application/json' },
      body: 'not json'
    })
  )
  expect(malformed.status).toBe(400)
  expect(await malformed.json()).toEqual({
    issues: [{ message: 'Invalid request body' }]
  })

  const unsupported = await call(
    handler,
    postDismiss({
      headers: { 'content-type': 'application/xml' },
      body: '<x/>'
    })
  )
  expect(unsupported.status).toBe(415)
})

test.each([
  ['a bare schema', (schema: StandardSchemaV1) => schema],
  ['{ schema }', (schema: StandardSchemaV1) => ({ schema })],
  [
    '{ schema, optional: false }',
    (schema: StandardSchemaV1) => ({ schema, optional: false })
  ]
])(
  'body %s stays required: no body is a 415, or a 400 when Content-Type says JSON',
  async (_label, toOption) => {
    const { adapter, fetch: handler } = createTestAdapter()
    const app = Arcton()
    let handlerCalled = false
    app.post('/dismiss', {
      body: toOption(rejecting()) as never,
      handler: () => {
        handlerCalled = true
      }
    })
    app.listen({ port: 0, adapter })

    expect((await call(handler, postDismiss())).status).toBe(415)
    expect(
      (
        await call(
          handler,
          postDismiss({ headers: { 'content-type': 'application/json' } })
        )
      ).status
    ).toBe(400)
    expect(handlerCalled).toBe(false)
  }
)

// ── body content — explicit media types ──────────────────────────────────

const json = { 'content-type': 'application/json' }

const postTo = (path: string, init: RequestInit) =>
  new Request(`http://localhost${path}`, { method: 'POST', ...init })

test('body content: only the listed media types are accepted, everything else is a 415 before parsing', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  let schemaCalls = 0
  let handlerCalls = 0
  app.post('/hook', {
    body: {
      content: {
        'application/json': fakeSchema((b: unknown) => {
          schemaCalls++
          return b
        })
      }
    },
    handler: ctx => {
      handlerCalls++
      return { got: ctx.body, contentType: ctx.contentType }
    }
  })
  app.listen({ port: 0, adapter })

  const ok = await call(
    handler,
    postTo('/hook', { headers: json, body: '{"a":1}' })
  )
  expect(ok.status).toBe(200)
  expect(await ok.json()).toEqual({
    got: { a: 1 },
    contentType: 'application/json'
  })

  const form = new FormData()
  form.set('a', '1')
  for (const init of [
    { headers: { 'content-type': 'text/plain' }, body: 'hi' },
    { body: form },
    {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=1'
    },
    { body: 'no content-type at all' }
  ] satisfies RequestInit[]) {
    const res = await call(handler, postTo('/hook', init))
    expect(res.status).toBe(415)
    expect(await res.text()).toBe('')
  }
  expect(schemaCalls).toBe(1)
  expect(handlerCalls).toBe(1)
})

test('body content: each media type is validated by its own schema, and ctx.contentType says which one ran', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.post('/hook', {
    body: {
      content: {
        'application/json': fakeSchema((b: { n: number }) => ({
          from: 'json',
          n: b.n
        })),
        'text/plain': fakeSchema((b: string) => ({ from: 'text', n: b.length }))
      }
    },
    handler: ctx => ({ body: ctx.body, contentType: ctx.contentType })
  })
  app.listen({ port: 0, adapter })

  const asJson = await call(
    handler,
    postTo('/hook', { headers: json, body: '{"n":7}' })
  )
  expect(await asJson.json()).toEqual({
    body: { from: 'json', n: 7 },
    contentType: 'application/json'
  })

  const asText = await call(
    handler,
    postTo('/hook', { headers: { 'content-type': 'text/plain' }, body: 'four' })
  )
  expect(await asText.json()).toEqual({
    body: { from: 'text', n: 4 },
    contentType: 'text/plain'
  })
})

test('body content: matching ignores case and parameters, and declared keys are normalized too', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.post('/hook', {
    body: { content: { 'Application/JSON': fakeSchema((b: unknown) => b) } },
    handler: ctx => ({ contentType: ctx.contentType })
  })
  app.listen({ port: 0, adapter })

  const res = await call(
    handler,
    postTo('/hook', {
      headers: { 'content-type': 'APPLICATION/json; charset=utf-8' },
      body: '{}'
    })
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ contentType: 'application/json' })
})

test('body content: matching is exact — a +json subtype is not application/json', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.post('/hook', {
    body: { content: { 'application/json': fakeSchema((b: unknown) => b) } },
    handler: () => 'ok'
  })
  app.listen({ port: 0, adapter })

  const res = await call(
    handler,
    postTo('/hook', {
      headers: { 'content-type': 'application/vnd.api+json' },
      body: '{}'
    })
  )
  expect(res.status).toBe(415)
})

test('body content: a Content-Type that resolves to an object property name is a 415, not a schema lookup', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.post('/hook', {
    body: { content: { 'application/json': fakeSchema((b: unknown) => b) } },
    handler: () => 'ok'
  })
  app.listen({ port: 0, adapter })

  for (const contentType of ['__proto__', 'constructor', 'toString']) {
    const res = await call(
      handler,
      postTo('/hook', { headers: { 'content-type': contentType }, body: 'x' })
    )
    expect(res.status).toBe(415)
  }
})

test('body content: a listed media type still needs a parser — .parser() is what teaches Arcton to read it', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  const csv = { 'content-type': 'text/csv' }
  app.post('/import', {
    body: {
      content: { 'text/csv': fakeSchema((rows: string[][]) => rows.length) }
    },
    handler: ctx => ({ rows: ctx.body, contentType: ctx.contentType })
  })
  app.listen({ port: 0, adapter })

  const before = await call(
    handler,
    postTo('/import', { headers: csv, body: 'a,b\n1,2' })
  )
  expect(before.status).toBe(415)

  app.parser('text/csv', async request =>
    (await request.text()).split('\n').map(line => line.split(','))
  )
  const after = await call(
    handler,
    postTo('/import', { headers: csv, body: 'a,b\n1,2' })
  )
  expect(await after.json()).toEqual({ rows: 2, contentType: 'text/csv' })
})

test('body content: a body failing the matched schema is a 400 with that schema’s issues', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.post('/hook', {
    body: {
      content: {
        'application/json': rejecting([{ message: 'bad json' }]),
        'text/plain': rejecting([{ message: 'bad text' }])
      }
    },
    handler: () => 'ok'
  })
  app.listen({ port: 0, adapter })

  const res = await call(
    handler,
    postTo('/hook', { headers: { 'content-type': 'text/plain' }, body: 'x' })
  )
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ issues: [{ message: 'bad text' }] })
})

test('body content: an unlisted media type reaches onError() as a 415 HttpError', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  let received: unknown
  app.post('/hook', {
    body: { content: { 'application/json': rejecting() } },
    handler: () => 'ok'
  })
  app.onError(err => {
    received = err
  })
  app.listen({ port: 0, adapter })

  const res = await call(
    handler,
    postTo('/hook', { headers: { 'content-type': 'text/plain' }, body: 'x' })
  )
  expect(received).toBeInstanceOf(HttpError)
  expect((received as HttpError).status).toBe(415)
  expect(res.status).toBe(415)
})

test('body content: optional — no body leaves ctx.body and ctx.contentType undefined, a present body is handled as usual', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.post('/hook', {
    body: {
      content: { 'application/json': fakeSchema((b: unknown) => b) },
      optional: true
    },
    handler: ctx => ({
      body: ctx.body ?? null,
      contentType: ctx.contentType ?? null
    })
  })
  app.listen({ port: 0, adapter })

  const absent = await call(handler, postTo('/hook', {}))
  expect(await absent.json()).toEqual({ body: null, contentType: null })

  const present = await call(
    handler,
    postTo('/hook', { headers: json, body: '{"a":1}' })
  )
  expect(await present.json()).toEqual({
    body: { a: 1 },
    contentType: 'application/json'
  })

  const unlisted = await call(
    handler,
    postTo('/hook', { headers: { 'content-type': 'text/plain' }, body: 'x' })
  )
  expect(unlisted.status).toBe(415)
})

const jsonOnlyForms: [string, (schema: StandardSchemaV1) => unknown][] = [
  ['body: schema', schema => schema],
  ['body: { schema, optional: true }', schema => ({ schema, optional: true })]
]

test.each(jsonOnlyForms)(
  '%s accepts only application/json — every other media type is a 415',
  async (_label, toOption) => {
    const { adapter, fetch: handler } = createTestAdapter()
    const app = Arcton()
    let schemaCalls = 0
    let handlerCalls = 0
    app.post('/hook', {
      body: toOption(
        fakeSchema((b: unknown) => {
          schemaCalls++
          return b
        })
      ) as never,
      handler: () => {
        handlerCalls++
        return { ok: true }
      }
    })
    app.listen({ port: 0, adapter })

    for (const contentType of [
      'application/json',
      'application/json; charset=utf-8',
      'APPLICATION/JSON'
    ]) {
      const res = await call(
        handler,
        postTo('/hook', {
          headers: { 'content-type': contentType },
          body: '{"a":1}'
        })
      )
      expect([contentType, res.status]).toEqual([contentType, 200])
    }
    expect(schemaCalls).toBe(3)
    expect(handlerCalls).toBe(3)

    const form = new FormData()
    form.set('a', '1')
    const noContentType = { body: new Uint8Array([1]) }
    expect(postTo('/hook', noContentType).headers.has('content-type')).toBe(
      false
    )

    const rejected: [string, RequestInit][] = [
      ...[
        'TEXT/PLAIN',
        'text/plain',
        'application/x-www-form-urlencoded',
        'application/octet-stream',
        'application/vnd.api+json',
        'text/csv'
      ].map((contentType): [string, RequestInit] => [
        contentType,
        { headers: { 'content-type': contentType }, body: 'x' }
      ]),
      ['multipart/form-data', { body: form }],
      ['(no Content-Type)', noContentType]
    ]
    for (const [label, init] of rejected) {
      const res = await call(handler, postTo('/hook', init))
      expect([label, res.status, await res.text()]).toEqual([label, 415, ''])
    }
    expect(schemaCalls).toBe(3)
    expect(handlerCalls).toBe(3)
  }
)

test('body: schema and { schema, optional } expose no ctx.contentType — only content does', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  const seen = (ctx: object) => ({ hasContentType: 'contentType' in ctx })
  app.post('/bare', { body: fakeSchema((b: unknown) => b), handler: seen })
  app.post('/optional', {
    body: { schema: fakeSchema((b: unknown) => b), optional: true },
    handler: seen
  })
  app.listen({ port: 0, adapter })

  for (const path of ['/bare', '/optional']) {
    const res = await call(handler, postTo(path, { headers: json, body: '{}' }))
    expect(await res.json()).toEqual({ hasContentType: false })
  }
})

test('.parser() teaches Arcton how to parse a media type but does not make a bare body schema accept it', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.parser('text/csv', async request => (await request.text()).split('\n'))
  app.parser('text/plain', async request => [
    'overridden',
    await request.text()
  ])
  app.post('/bare', {
    body: fakeSchema((b: unknown) => b),
    handler: () => 'ok'
  })
  app.post('/optional', {
    body: { schema: fakeSchema((b: unknown) => b), optional: true },
    handler: () => 'ok'
  })
  app.post('/csv', {
    body: {
      content: { 'text/csv': fakeSchema((rows: string[]) => rows.length) }
    },
    handler: ctx => ({ rows: ctx.body })
  })
  app.listen({ port: 0, adapter })

  for (const path of ['/bare', '/optional']) {
    for (const contentType of ['text/csv', 'text/plain']) {
      const res = await call(
        handler,
        postTo(path, {
          headers: { 'content-type': contentType },
          body: 'a\nb'
        })
      )
      expect([path, contentType, res.status]).toEqual([path, contentType, 415])
    }
  }

  const csv = await call(
    handler,
    postTo('/csv', { headers: { 'content-type': 'text/csv' }, body: 'a\nb' })
  )
  expect(await csv.json()).toEqual({ rows: 2 })
})

test('body: a media type a bare schema does not accept is refused before any parser runs', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  const parsed: string[] = []
  for (const mediaType of ['text/plain', 'text/csv']) {
    app.parser(mediaType, async request => {
      parsed.push(mediaType)
      return request.text()
    })
  }
  app.post('/bare', {
    body: fakeSchema((b: unknown) => b),
    handler: () => 'ok'
  })
  app.listen({ port: 0, adapter })

  // Built-in parsers would throw on these — a 400 here would mean the parser
  // ran before the media type was checked.
  for (const init of [
    { headers: { 'content-type': 'text/plain' }, body: 'x' },
    { headers: { 'content-type': 'text/csv' }, body: 'x' },
    {
      headers: { 'content-type': 'application/vnd.api+json' },
      body: 'not json'
    },
    {
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body: 'garbage'
    }
  ] satisfies RequestInit[]) {
    const res = await call(handler, postTo('/bare', init))
    expect([init.headers['content-type'], res.status]).toEqual([
      init.headers['content-type'],
      415
    ])
  }
  expect(parsed).toEqual([])
})

test('body content: an empty content map is rejected at registration', () => {
  const app = Arcton()
  expect(() =>
    app.post('/hook', { body: { content: {} }, handler: () => 'ok' })
  ).toThrow(/at least one media type/)
})

// ── unified error lifecycle — request errors go through onError() ────────

function rejecting(
  issues: StandardSchemaV1.Issue[] = [{ message: 'nope' }]
): StandardSchemaV1 {
  return {
    '~standard': { version: 1, vendor: 'fake', validate: () => ({ issues }) }
  }
}

function postJson(path: string, body: string): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body
  })
}

test('validation errors: without onError(), the default is a 400 with the schema issues', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/search', { query: rejecting(), handler: () => 'ok' })
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/search'))
  expect(res.status).toBe(400)
  expect(res.headers.get('content-type')).toBe('application/json')
  expect(await res.json()).toEqual({ issues: [{ message: 'nope' }] })
})

test('validation errors: onError() can answer with a custom Response', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  let handlerCalled = false
  let middlewareCalled = false
  app.get('/users/:id', {
    params: rejecting(),
    middleware: [
      (_ctx, next) => {
        middlewareCalled = true
        return next()
      }
    ],
    handler: () => {
      handlerCalled = true
    }
  })
  app.onError(() => new Response('custom', { status: 422 }))
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/users/1'))
  expect(res.status).toBe(422)
  expect(await res.text()).toBe('custom')
  expect(handlerCalled).toBe(false)
  expect(middlewareCalled).toBe(false)
})

test('validation errors: onError() receives a ValidationError carrying the schema’s original issues', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  const issues: StandardSchemaV1.Issue[] = [
    { message: 'too short', path: ['name'], code: 'too_small' } as never
  ]
  let received: unknown
  app.get('/search', { query: rejecting(issues), handler: () => 'ok' })
  app.onError(err => {
    received = err
    return { handled: true }
  })
  app.listen({ port: 0, adapter })

  await call(handler, new Request('http://localhost/search'))
  expect(received).toBeInstanceOf(ValidationError)
  expect(received).toBeInstanceOf(HttpError)
  expect((received as ValidationError).issues).toBe(issues)
  expect((received as ValidationError).status).toBe(400)
})

test('validation errors: params, query and body failures all reach onError()', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  const seen: unknown[] = []
  app.get('/p/:id', { params: rejecting(), handler: () => 'ok' })
  app.get('/q', { query: rejecting(), handler: () => 'ok' })
  app.post('/b', { body: rejecting(), handler: () => 'ok' })
  app.onError(err => {
    seen.push(err)
    return new Response('handled', { status: 422 })
  })
  app.listen({ port: 0, adapter })

  for (const request of [
    new Request('http://localhost/p/1'),
    new Request('http://localhost/q'),
    postJson('/b', '{}')
  ]) {
    expect((await call(handler, request)).status).toBe(422)
  }
  expect(seen).toHaveLength(3)
  for (const err of seen) expect(err).toBeInstanceOf(ValidationError)
})

test('validation errors: onError() declining (returning nothing) falls back to the default 400', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  let called = false
  app.get('/search', { query: rejecting(), handler: () => 'ok' })
  app.onError(() => {
    called = true
  })
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/search'))
  expect(called).toBe(true)
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ issues: [{ message: 'nope' }] })
})

test('validation errors: a body returned from onError() defaults to 400, not 500, unless it sets a status', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/search', { query: rejecting(), handler: () => 'ok' })
  app.get('/other', { query: rejecting(), handler: () => 'ok' })
  app.onError((_err, ctx) => {
    if (ctx.request.url.endsWith('/other')) ctx.response.status = 422
    return { error: 'invalid' }
  })
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/search'))
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'invalid' })
  expect(
    (await call(handler, new Request('http://localhost/other'))).status
  ).toBe(422)
})

test('validation errors: a malformed JSON body reaches onError() as a ValidationError', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  let received: unknown
  app.post('/users', { body: rejecting(), handler: () => 'ok' })
  app.onError(err => {
    received = err
  })
  app.listen({ port: 0, adapter })

  const res = await call(handler, postJson('/users', 'not json'))
  expect(received).toBeInstanceOf(ValidationError)
  expect((received as ValidationError).issues).toEqual([
    { message: 'Invalid request body' }
  ])
  expect(res.status).toBe(400)
})

test('request errors: an unsupported body Content-Type reaches onError() as a 415 HttpError', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  let received: unknown
  app.post('/users', { body: rejecting(), handler: () => 'ok' })
  app.onError((err, ctx) => {
    received = err
    if (err instanceof HttpError) ctx.response.status = err.status
    return { code: (err as HttpError).code }
  })
  app.listen({ port: 0, adapter })

  const res = await call(
    handler,
    new Request('http://localhost/users', {
      method: 'POST',
      headers: { 'content-type': 'application/xml' },
      body: '<x/>'
    })
  )
  expect(received).toBeInstanceOf(HttpError)
  expect(received).not.toBeInstanceOf(ValidationError)
  expect(res.status).toBe(415)
  expect(await res.json()).toEqual({ code: 'UNSUPPORTED_MEDIA_TYPE' })
})

test('request errors: an unsupported Content-Type declined by onError() still answers with the default empty 415', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.post('/users', { body: rejecting(), handler: () => 'ok' })
  app.onError(() => {})
  app.listen({ port: 0, adapter })

  const res = await call(
    handler,
    new Request('http://localhost/users', {
      method: 'POST',
      headers: { 'content-type': 'application/xml' },
      body: '<x/>'
    })
  )
  expect(res.status).toBe(415)
  expect(await res.text()).toBe('')
})

test.each([
  ['with onError() handling it', true],
  ['with the default response', false]
])(
  'validation errors: enclosing middleware still sees a response, not a rejected next() (%s)',
  async (_label, withOnError) => {
    const { adapter, fetch: handler } = createTestAdapter()
    const app = Arcton()
    let nextRejected = false
    app.use(async (ctx, next) => {
      try {
        await next()
      } catch (err) {
        nextRejected = true
        throw err
      }
      ctx.response.headers.set('X-After-Next', 'yes')
    })
    app.get('/search', { query: rejecting(), handler: () => 'ok' })
    if (withOnError) app.onError(() => ({ error: 'invalid' }))
    app.listen({ port: 0, adapter })

    const res = await call(handler, new Request('http://localhost/search'))
    expect(res.status).toBe(400)
    expect(nextRejected).toBe(false)
    expect(res.headers.get('X-After-Next')).toBe('yes')
  }
)

test('validation errors: if onError() throws, that error propagates uncaught and onError() is not called again', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  const failure = new Error('onError itself failed')
  let calls = 0
  app.get('/search', { query: rejecting(), handler: () => 'ok' })
  app.onError(() => {
    calls++
    throw failure
  })
  app.listen({ port: 0, adapter })

  await expect(
    call(handler, new Request('http://localhost/search'))
  ).rejects.toBe(failure)
  expect(calls).toBe(1)
})

test('validation errors: a mounted module’s route is answered by the mounting app’s onError(), not its own', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const users = Arcton()
  users.get('/users/:id', { params: rejecting(), handler: () => 'ok' })
  users.onError(() => ({ from: 'module' }))

  const app = Arcton()
  app.use(users)
  app.onError(() => ({ from: 'app' }))
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/users/1'))
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ from: 'app' })
})

test('validation errors: a module’s own onError() does not apply once mounted — the default 400 does', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const users = Arcton()
  users.get('/users/:id', { params: rejecting(), handler: () => 'ok' })
  users.onError(() => ({ from: 'module' }))

  const app = Arcton()
  app.use(users)
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/users/1'))
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ issues: [{ message: 'nope' }] })
})

test('app.onError(): returning nothing for a thrown error falls back to the default — it propagates to the adapter', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  const err = new Error('boom')
  let received: unknown
  app.get('/', () => {
    throw err
  })
  app.onError(e => {
    received = e
  })
  app.listen({ port: 0, adapter })

  await expect(call(handler, new Request('http://localhost/'))).rejects.toBe(
    err
  )
  expect(received).toBe(err)
})

test('app.onError(): catches an error thrown by global middleware on a matched route', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  let handlerCalled = false
  app.use(async () => {
    throw new Error('middleware boom')
  })
  app.get('/', () => {
    handlerCalled = true
  })
  app.onError((err, ctx) => {
    ctx.response.status = 503
    return { message: (err as Error).message }
  })
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.status).toBe(503)
  expect(await res.json()).toEqual({ message: 'middleware boom' })
  expect(handlerCalled).toBe(false)
})

test('app.onError(): catches an error thrown by route-level middleware', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get(
    '/',
    async () => {
      throw new Error('route middleware boom')
    },
    () => 'ok'
  )
  app.onError((err, ctx) => {
    ctx.response.status = 503
    return { message: (err as Error).message }
  })
  app.listen({ port: 0, adapter })

  const res = await call(handler, new Request('http://localhost/'))
  expect(res.status).toBe(503)
  expect(await res.json()).toEqual({ message: 'route middleware boom' })
})

test('app.onError(): catches an error thrown by a custom body parser', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  const err = new Error('custom parser boom')
  let received: unknown
  app.parser('application/vnd.foo', () => {
    throw err
  })
  app.post('/foo', {
    body: { content: { 'application/vnd.foo': rejecting() } },
    handler: () => 'ok'
  })
  app.onError((e, ctx) => {
    received = e
    ctx.response.status = 502
    return { parser: 'failed' }
  })
  app.listen({ port: 0, adapter })

  const res = await call(
    handler,
    new Request('http://localhost/foo', {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.foo' },
      body: 'irrelevant'
    })
  )
  expect(received).toBe(err)
  expect(res.status).toBe(502)
  expect(await res.json()).toEqual({ parser: 'failed' })
})

// ── maxBodySize ──────────────────────────────────────────────────────────

test('maxBodySize: a declared Content-Length over the limit is rejected with 413, handler never runs', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  let handlerCalled = false
  app.post('/upload', () => {
    handlerCalled = true
  })
  app.listen({ port: 0, adapter, maxBodySize: 10 })

  const res = await call(
    handler,
    new Request('http://localhost/upload', {
      method: 'POST',
      headers: { 'content-length': '20' },
      body: 'x'.repeat(20)
    })
  )

  expect(res.status).toBe(413)
  expect(handlerCalled).toBe(false)
})

test('maxBodySize: a streamed body with no Content-Length exceeding the limit fails once read', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.post('/upload', async ctx => {
    await ctx.request.text()
    return { ok: true }
  })
  app.listen({ port: 0, adapter, maxBodySize: 10 })

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('x'.repeat(20)))
      controller.close()
    }
  })

  await expect(
    call(
      handler,
      new Request('http://localhost/upload', {
        method: 'POST',
        body: stream,
        duplex: 'half'
      } as RequestInit)
    )
  ).rejects.toThrow(/exceeds the configured limit/)
})

test('maxBodySize: a body under the default limit is unaffected', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.post('/upload', async ctx => ({ received: await ctx.request.text() }))
  app.listen({ port: 0, adapter })

  const res = await call(
    handler,
    new Request('http://localhost/upload', { method: 'POST', body: 'hello' })
  )

  expect(await res.json()).toEqual({ received: 'hello' })
})

// Signal-listener lifecycle itself is covered in shutdown.test.ts.

test('gracefulShutdown: false is accepted and the server still listens/stops normally', async () => {
  const { adapter, fetch: handler } = createTestAdapter()
  const app = Arcton()
  app.get('/health', () => ({ status: 'ok' }))
  const server = app.listen({ port: 0, adapter, gracefulShutdown: false })

  const res = await call(handler, new Request('http://localhost/health'))
  expect(await res.json()).toEqual({ status: 'ok' })

  expect(() => server.stop()).not.toThrow()
})

test('shutdownTimeout rejects non-positive or non-finite values', () => {
  const { adapter } = createTestAdapter()

  for (const shutdownTimeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() =>
      Arcton().listen({ port: 0, adapter, shutdownTimeout })
    ).toThrow(/shutdownTimeout must be a positive, finite number/)
  }
})

test('shutdownTimeout accepts a positive finite value', () => {
  const { adapter } = createTestAdapter()

  expect(() =>
    Arcton().listen({ port: 0, adapter, shutdownTimeout: 5000 })
  ).not.toThrow()
})
