import { expect, test } from 'bun:test'
import type {
  OpenAPIIntegration,
  RuntimeAdapter,
  RuntimeHandler,
  StandardSchemaV1
} from '@arcton/contracts'
import { Arcton, routesOf } from './index'

function schema(name: string): StandardSchemaV1 {
  return {
    '~standard': {
      version: 1,
      vendor: name,
      validate: (value: unknown) => ({ value })
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

test('routesOf records method and path for a plain handler route', () => {
  const app = Arcton()

  app.get('/health', () => ({ ok: true }))

  expect(routesOf(app)).toEqual([{ method: 'GET', path: '/health' }])
})

test('routesOf keeps the original schemas, not a converted form', () => {
  const app = Arcton()
  const params = schema('params')
  const query = schema('query')
  const body = schema('body')

  app.post('/users/:id', { params, query, body, handler: () => ({}) })

  const [record] = routesOf(app)
  expect(record?.params).toBe(params)
  expect(record?.query).toBe(query)
  expect(record?.body).toBe(body)
})

test('a bare response schema is normalized to status 200', () => {
  const app = Arcton()
  const user = schema('user')

  app.get('/users/:id', { response: user, handler: () => ({}) })

  expect(routesOf(app)[0]?.response).toEqual({ 200: user })
})

test('an explicit response map is kept as given', () => {
  const app = Arcton()
  const ok = schema('ok')
  const missing = schema('missing')

  app.get('/users/:id', {
    response: { 200: ok, 404: missing },
    handler: () => ({})
  })

  expect(routesOf(app)[0]?.response).toEqual({ 200: ok, 404: missing })
})

test('response is documentation only — a handler returning anything else still responds', async () => {
  const app = Arcton()
  const { adapter, fetch } = createTestAdapter()

  app.get('/users', {
    response: schema('never matches'),
    handler: () => ({ unexpected: true })
  })
  app.listen({ adapter })

  const response = await fetch(new Request('http://localhost/users'), {
    upgrade: () => false
  })
  expect(response?.status).toBe(200)
  expect(await response?.json()).toEqual({ unexpected: true })
})

test('routesOf carries route detail through', () => {
  const app = Arcton()

  app.get('/users/:id', {
    detail: {
      operationId: 'getUser',
      summary: 'Get user',
      tags: ['Users'],
      deprecated: true
    },
    handler: () => ({})
  })

  expect(routesOf(app)[0]?.detail).toEqual({
    operationId: 'getUser',
    summary: 'Get user',
    tags: ['Users'],
    deprecated: true
  })
})

test('app.all() records one route per concrete method', () => {
  const app = Arcton()

  app.all('/any', () => 'ok')

  expect(routesOf(app).map(record => record.method)).toEqual([
    'GET',
    'POST',
    'PUT',
    'DELETE',
    'PATCH',
    'HEAD',
    'OPTIONS'
  ])
  expect(new Set(routesOf(app).map(record => record.path))).toEqual(
    new Set(['/any'])
  )
})

test("a record's path includes the app's own prefix", () => {
  const app = Arcton({ prefix: '/api' })

  app.get('/users', () => [])

  expect(routesOf(app)[0]?.path).toBe('/api/users')
})

test('mounting a module merges its records under the parent prefix', () => {
  const users = Arcton({ prefix: '/users' })
  users.get('/:id', () => ({}))
  users.post('/', () => ({}))

  const app = Arcton({ prefix: '/api' })
  app.use(users)

  expect(routesOf(app)).toEqual([
    { method: 'GET', path: '/api/users/:id' },
    { method: 'POST', path: '/api/users' }
  ])
})

test('nested modules compose prefixes in the records', () => {
  const posts = Arcton({ prefix: '/posts' })
  posts.get('/:postId', () => ({}))

  const users = Arcton({ prefix: '/users' })
  users.use(posts)

  const app = Arcton({ prefix: '/api' })
  app.use(users)

  expect(routesOf(app)[0]?.path).toBe('/api/users/posts/:postId')
})

test('a mounted module keeps its own records unchanged', () => {
  const users = Arcton({ prefix: '/users' })
  users.get('/:id', () => ({}))

  const app = Arcton({ prefix: '/api' })
  app.use(users)

  expect(routesOf(users)[0]?.path).toBe('/users/:id')
})

test('ws() routes produce no record', () => {
  const app = Arcton()

  app.ws('/chat', { message: () => {} })

  expect(routesOf(app)).toEqual([])
})

test('a rejected registration leaves no record behind', () => {
  const app = Arcton()

  app.get('/users', () => ({}))
  expect(() => app.get('/users', () => ({}))).toThrow(/Duplicate route/)

  expect(routesOf(app)).toHaveLength(1)
})

test('routesOf rejects anything that is not an Arcton app', () => {
  expect(() => routesOf({} as never)).toThrow(/expects an Arcton app/)
})

test('listen({ openapi }) hands the integration the final records', () => {
  const users = Arcton({ prefix: '/users' })
  users.get('/:id', () => ({}))

  const app = Arcton()
  const { adapter } = createTestAdapter()
  let seen: readonly { method: string; path: string }[] = []

  const integration: OpenAPIIntegration = {
    routes(records) {
      seen = records.map(record => ({
        method: record.method,
        path: record.path
      }))
      return []
    }
  }

  app.get('/health', () => ({}))
  app.use(users)
  app.listen({ adapter, openapi: integration })

  expect(seen).toEqual([
    { method: 'GET', path: '/health' },
    { method: 'GET', path: '/users/:id' }
  ])
})

test('listen({ openapi }) serves the routes the integration returns', async () => {
  const app = Arcton()
  const { adapter, fetch } = createTestAdapter()

  const integration: OpenAPIIntegration = {
    routes: () => [
      { path: '/openapi.json', handler: () => ({ openapi: true }) }
    ]
  }

  app.get('/health', () => ({}))
  app.listen({ adapter, openapi: integration })

  const response = await fetch(new Request('http://localhost/openapi.json'), {
    upgrade: () => false
  })
  expect(await response?.json()).toEqual({ openapi: true })
})

test('routes an integration registers are not documented themselves', () => {
  const app = Arcton()
  const { adapter } = createTestAdapter()

  app.get('/health', () => ({}))
  app.listen({
    adapter,
    openapi: {
      routes: () => [{ path: '/openapi.json', handler: () => ({}) }]
    }
  })

  expect(routesOf(app)).toEqual([{ method: 'GET', path: '/health' }])
})

test('an integration path colliding with a route throws', () => {
  const app = Arcton()
  const { adapter } = createTestAdapter()

  app.get('/docs', () => 'mine')

  expect(() =>
    app.listen({
      adapter,
      openapi: { routes: () => [{ path: '/docs', handler: () => ({}) }] }
    })
  ).toThrow(/Duplicate route/)
})
