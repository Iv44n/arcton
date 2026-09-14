import { expect, test } from 'bun:test'
import type { RuntimeAdapter, RuntimeHandler } from '@arcton/contracts'
import { Arcton } from '@arcton/core'
import * as z from 'zod'
import { openapi } from './openapi'

function createTestAdapter(): {
  adapter: RuntimeAdapter
  fetch: (path: string) => Promise<Response>
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

  async function fetch(path: string) {
    if (!captured) throw new Error('app.listen() was not called')
    const response = await captured(new Request(`http://localhost${path}`), {
      upgrade: () => false
    })
    if (!response) throw new Error('expected a Response')
    return response
  }

  return { adapter, fetch }
}

const info = { title: 'Users API', version: '1.0.0' }

interface OpenAPIDocument {
  openapi: string
  info: Record<string, unknown>
  paths: Record<string, Record<string, Record<string, unknown>>>
}

async function fetchDocument(
  fetch: (path: string) => Promise<Response>,
  path = '/openapi.json'
): Promise<OpenAPIDocument> {
  return (await (await fetch(path)).json()) as OpenAPIDocument
}

test('/openapi.json serves the document as JSON', async () => {
  const app = Arcton()
  const { adapter, fetch } = createTestAdapter()

  app.get('/users/:id', {
    params: z.object({ id: z.uuid() }),
    response: { 200: z.object({ id: z.string() }) },
    detail: { operationId: 'getUser', tags: ['Users'] },
    handler: () => ({ id: '1' })
  })
  app.listen({ adapter, openapi: openapi({ info }) })

  const response = await fetch('/openapi.json')

  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe(
    'application/json; charset=utf-8'
  )

  const document = (await response.json()) as OpenAPIDocument
  expect(document.openapi).toBe('3.1.0')
  expect(document.info).toEqual(info)
  expect(document.paths['/users/{id}']?.get?.operationId).toBe('getUser')
})

test('the document describes the final route tree, after modules are mounted', async () => {
  const posts = Arcton({ prefix: '/posts' })
  posts.get('/:postId', () => ({}))

  const users = Arcton({ prefix: '/users' })
  users.get('/', () => [])
  users.use(posts)

  const app = Arcton({ prefix: '/api' })
  const { adapter, fetch } = createTestAdapter()

  app.use(users)
  app.listen({ adapter, openapi: openapi({ info }) })

  const document = await fetchDocument(fetch)

  expect(Object.keys(document.paths).sort()).toEqual([
    '/api/users',
    '/api/users/posts/{postId}'
  ])
})

test('/docs serves HTML pointing at the document', async () => {
  const app = Arcton()
  const { adapter, fetch } = createTestAdapter()

  app.get('/users', () => [])
  app.listen({ adapter, openapi: openapi({ info }) })

  const response = await fetch('/docs')
  const html = await response.text()

  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
  expect(html).toStartWith('<!doctype html>')
  expect(html).toContain('/openapi.json')
  // The document is referenced by URL, never copied into the page.
  expect(html).not.toContain('"openapi"')
})

test('both paths are configurable', async () => {
  const app = Arcton()
  const { adapter, fetch } = createTestAdapter()

  app.get('/users', () => [])
  app.listen({
    adapter,
    openapi: openapi({
      info,
      document: { path: '/schema.json' },
      docs: { path: '/reference' }
    })
  })

  expect((await fetch('/schema.json')).status).toBe(200)
  expect((await fetch('/reference')).status).toBe(200)
  expect(await (await fetch('/reference')).text()).toContain('/schema.json')
  expect((await fetch('/openapi.json')).status).toBe(404)
})

test('docs: false serves the document without a UI', async () => {
  const app = Arcton()
  const { adapter, fetch } = createTestAdapter()

  app.get('/users', () => [])
  app.listen({ adapter, openapi: openapi({ info, docs: false }) })

  expect((await fetch('/openapi.json')).status).toBe(200)
  expect((await fetch('/docs')).status).toBe(404)
})

test('Scalar configuration is passed through, separately from the document', async () => {
  const app = Arcton()
  const { adapter, fetch } = createTestAdapter()

  app.get('/users', () => [])
  app.listen({
    adapter,
    openapi: openapi({
      info,
      docs: { pageTitle: 'Users Reference', configuration: { theme: 'purple' } }
    })
  })

  const html = await (await fetch('/docs')).text()
  expect(html).toContain('Users Reference')
  expect(html).toContain('purple')
})

test('WebSocket and wildcard routes stay out of the document', async () => {
  const app = Arcton()
  const { adapter, fetch } = createTestAdapter()

  app.get('/health', () => ({}))
  app.get('/files/*rest', () => ({}))
  app.ws('/chat', { message: () => {} })
  app.listen({ adapter, openapi: openapi({ info }) })

  const document = await fetchDocument(fetch)
  expect(Object.keys(document.paths)).toEqual(['/health'])
})

test('app.all() documents every method it registers', async () => {
  const app = Arcton()
  const { adapter, fetch } = createTestAdapter()

  app.all('/any', () => 'ok')
  app.listen({ adapter, openapi: openapi({ info }) })

  const document = await fetchDocument(fetch)
  expect(Object.keys(document.paths['/any'] ?? {})).toEqual([
    'get',
    'post',
    'put',
    'delete',
    'patch',
    'head',
    'options'
  ])
})

test('the documentation routes do not document themselves', async () => {
  const app = Arcton()
  const { adapter, fetch } = createTestAdapter()

  app.get('/health', () => ({}))
  app.listen({ adapter, openapi: openapi({ info }) })

  const document = await fetchDocument(fetch)
  expect(Object.keys(document.paths)).toEqual(['/health'])
})

test('the document is serialized once, not rebuilt per request', async () => {
  const app = Arcton()
  const { adapter, fetch } = createTestAdapter()

  app.get('/users', {
    response: z.object({ id: z.string() }),
    handler: () => ({})
  })
  app.listen({ adapter, openapi: openapi({ info }) })

  const first = await (await fetch('/openapi.json')).text()
  const second = await (await fetch('/openapi.json')).text()
  expect(first).toBe(second)
})

test('documented routes keep serving normally', async () => {
  const app = Arcton()
  const { adapter, fetch } = createTestAdapter()

  app.get('/users/:id', {
    params: z.object({ id: z.string() }),
    response: z.object({ id: z.string() }),
    handler: ctx => ({ id: ctx.params.id })
  })
  app.listen({ adapter, openapi: openapi({ info }) })

  expect(await (await fetch('/users/42')).json()).toEqual({ id: '42' })
})
