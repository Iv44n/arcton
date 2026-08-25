import { expect, test } from 'bun:test'
import type {
  Body,
  RuntimeAdapter,
  RuntimeHandler,
  RuntimeRequestContext
} from '@arcton/contracts'
import { Arcton } from './index'

function createTestAdapter(): {
  adapter: RuntimeAdapter
  fetch: RuntimeHandler
} {
  let captured: RuntimeHandler | undefined
  const adapter: RuntimeAdapter = {
    name: 'test',
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
