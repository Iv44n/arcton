import { expect, test } from 'bun:test'
import type { RouteRecord, StandardSchemaV1 } from '@arcton/contracts'
import * as z from 'zod'
import { buildDocument } from './document'

const info = { title: 'Test API', version: '1.0.0' }

function build(records: RouteRecord[]) {
  return buildDocument(records, { info })
}

// A Standard Schema that validates but has no JSON Schema — Valibot behaves
// this way until wrapped with `toStandardJsonSchema`.
const opaque: StandardSchemaV1 = {
  '~standard': {
    version: 1,
    vendor: 'opaque',
    validate: (value: unknown) => ({ value })
  }
}

function operation(
  document: Record<string, unknown>,
  path: string,
  method = 'get'
) {
  const paths = document.paths as Record<string, Record<string, unknown>>
  return paths[path]?.[method] as Record<string, unknown> | undefined
}

type Operation = Record<string, unknown> | undefined

// The `content` → media type → `schema` walk both a requestBody and a
// response share.
function mediaSchema(container: unknown): Record<string, unknown> | undefined {
  const content = (
    container as
      | { content?: Record<string, { schema?: Record<string, unknown> }> }
      | undefined
  )?.content
  return content?.['application/json']?.schema
}

function requestSchema(target: Operation) {
  return mediaSchema(target?.requestBody)
}

function responseSchema(target: Operation, status: string) {
  const responses = target?.responses as Record<string, unknown> | undefined
  return mediaSchema(responses?.[status])
}

test('emits an OpenAPI 3.1 document with the given info', () => {
  const document = build([{ method: 'GET', path: '/health' }])

  expect(document.openapi).toBe('3.1.0')
  expect(document.info).toEqual(info)
  expect(document.paths).toEqual({ '/health': { get: {} } })
})

test('converts :param to {param} and marks it required', () => {
  const document = build([
    {
      method: 'GET',
      path: '/users/:id',
      params: z.object({ id: z.uuid() })
    }
  ])

  const parameters = operation(document, '/users/{id}')?.parameters as
    | Record<string, unknown>[]
    | undefined

  expect(parameters).toHaveLength(1)
  expect(parameters?.[0]).toMatchObject({
    name: 'id',
    in: 'path',
    required: true,
    schema: { type: 'string', format: 'uuid' }
  })
})

test('converts every dynamic segment of a nested path', () => {
  const document = build([
    { method: 'GET', path: '/users/:userId/posts/:postId' }
  ])

  const parameters = operation(document, '/users/{userId}/posts/{postId}')
    ?.parameters as Record<string, unknown>[] | undefined

  expect(parameters?.map(parameter => parameter.name)).toEqual([
    'userId',
    'postId'
  ])
  expect(parameters?.every(parameter => parameter.required === true)).toBe(true)
})

test('a path parameter with no schema still appears, with an empty schema', () => {
  const document = build([{ method: 'GET', path: '/users/:id' }])

  const parameters = operation(document, '/users/{id}')?.parameters as
    | Record<string, unknown>[]
    | undefined

  expect(parameters?.[0]).toEqual({
    name: 'id',
    in: 'path',
    required: true,
    schema: {}
  })
})

test('query properties become query parameters, required only when required', () => {
  const document = build([
    {
      method: 'GET',
      path: '/users',
      query: z.object({ q: z.string(), limit: z.string().optional() })
    }
  ])

  const parameters = operation(document, '/users')?.parameters as
    | Record<string, unknown>[]
    | undefined

  expect(parameters).toEqual([
    { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
    { name: 'limit', in: 'query', schema: { type: 'string' } }
  ])
})

test('a body becomes a JSON requestBody built from the input schema', () => {
  const document = build([
    {
      method: 'POST',
      path: '/users',
      body: z.object({ name: z.string(), age: z.number().optional() })
    }
  ])

  expect(operation(document, '/users', 'post')?.requestBody).toEqual({
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: { name: { type: 'string' }, age: { type: 'number' } },
          required: ['name']
        }
      }
    }
  })
})

test('responses are keyed by status, with a description and JSON content', () => {
  const document = build([
    {
      method: 'GET',
      path: '/users',
      response: { 200: z.object({ ok: z.boolean() }) }
    }
  ])

  expect(operation(document, '/users')?.responses).toEqual({
    '200': {
      description: 'Successful response',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
            additionalProperties: false
          }
        }
      }
    }
  })
})

test('every declared status is emitted, and 204 carries no content', () => {
  const schema = z.object({ ok: z.boolean() })
  const document = build([
    {
      method: 'POST',
      path: '/users',
      response: {
        200: schema,
        201: schema,
        204: schema,
        400: schema,
        404: schema,
        409: schema,
        500: schema
      }
    }
  ])

  const responses = operation(document, '/users', 'post')?.responses as Record<
    string,
    Record<string, unknown>
  >

  expect(Object.keys(responses)).toEqual([
    '200',
    '201',
    '204',
    '400',
    '404',
    '409',
    '500'
  ])
  expect(responses['204']).toEqual({ description: 'No content' })
  expect(responses['404']?.description).toBe('Not found')
  expect(responses['500']?.content).toBeDefined()
})

test('an uncommon status gets a generic description', () => {
  const document = build([
    { method: 'GET', path: '/teapot', response: { 418: z.string() } }
  ])

  const responses = operation(document, '/teapot')?.responses as Record<
    string,
    Record<string, unknown>
  >
  expect(responses['418']?.description).toBe('Response 418')
})

test('responses use the output schema, requests the input schema', () => {
  // `.default()` makes `a` optional on the way in and guaranteed on the way
  // out — the same schema, two shapes.
  const schema = z.object({ a: z.string().default('x'), b: z.string() })
  const document = build([
    { method: 'POST', path: '/things', body: schema, response: { 200: schema } }
  ])

  const target = operation(document, '/things', 'post')

  expect(requestSchema(target)?.required).toEqual(['b'])
  expect(responseSchema(target, '200')?.required).toEqual(['a', 'b'])
})

test('a schema with no JSON Schema representation degrades to an empty schema', () => {
  const document = build([
    { method: 'POST', path: '/things', body: opaque, response: { 200: opaque } }
  ])

  const target = operation(document, '/things', 'post')
  expect(target?.requestBody).toEqual({
    required: true,
    content: { 'application/json': { schema: {} } }
  })
  expect(target?.responses).toEqual({
    '200': {
      description: 'Successful response',
      content: { 'application/json': { schema: {} } }
    }
  })
})

test('a schema that cannot be represented on the way out degrades too', () => {
  // A transform has no output JSON Schema, but its input side is fine.
  const schema = z.object({ n: z.string().transform(Number) })
  const document = build([
    { method: 'POST', path: '/things', body: schema, response: { 200: schema } }
  ])

  const target = operation(document, '/things', 'post')

  expect(requestSchema(target)).toMatchObject({
    properties: { n: { type: 'string' } }
  })
  expect(responseSchema(target, '200')).toEqual({})
})

test('$defs are hoisted into components.schemas and $refs rewritten', () => {
  const user = z.object({ id: z.string() }).meta({ id: 'User' })
  const document = build([
    {
      method: 'GET',
      path: '/users',
      response: { 200: z.object({ owner: user, editor: user }) }
    }
  ])

  const components = document.components as {
    schemas: Record<string, Record<string, unknown>>
  }
  expect(Object.keys(components.schemas)).toEqual(['User'])
  expect(components.schemas.User).toMatchObject({
    type: 'object',
    properties: { id: { type: 'string' } }
  })

  const schema = responseSchema(operation(document, '/users'), '200')
  expect(schema).toMatchObject({
    properties: {
      owner: { $ref: '#/components/schemas/User' },
      editor: { $ref: '#/components/schemas/User' }
    }
  })
})

test('a schema shared by two routes is defined once', () => {
  const user = z.object({ id: z.string() }).meta({ id: 'User' })
  const document = build([
    { method: 'GET', path: '/users', response: { 200: user } },
    { method: 'GET', path: '/admins', response: { 200: user } }
  ])

  const components = document.components as {
    schemas: Record<string, unknown>
  }
  expect(Object.keys(components.schemas)).toEqual(['User'])
})

test('two different schemas sharing a name are kept apart', () => {
  const first = z.object({ id: z.string() }).meta({ id: 'Item' })
  const second = z.object({ label: z.number() }).meta({ id: 'Item' })
  const document = build([
    { method: 'GET', path: '/first', response: { 200: first } },
    { method: 'GET', path: '/second', response: { 200: second } }
  ])

  const components = document.components as {
    schemas: Record<string, unknown>
  }
  expect(Object.keys(components.schemas)).toEqual(['Item', 'Item2'])
})

test('the JSON Schema dialect marker is not repeated inside the document', () => {
  const document = build([
    { method: 'POST', path: '/things', body: z.object({ a: z.string() }) }
  ])

  expect(JSON.stringify(document)).not.toContain('$schema')
})

test('a wildcard route is left out of the document', () => {
  const document = build([
    { method: 'GET', path: '/health' },
    { method: 'GET', path: '/files/*rest' }
  ])

  expect(Object.keys(document.paths as object)).toEqual(['/health'])
})

test('records sharing a path collapse into one path item', () => {
  const document = build([
    { method: 'GET', path: '/users' },
    { method: 'POST', path: '/users' },
    { method: 'DELETE', path: '/users' }
  ])

  const paths = document.paths as Record<string, Record<string, unknown>>
  expect(Object.keys(paths)).toEqual(['/users'])
  expect(Object.keys(paths['/users'] ?? {})).toEqual(['get', 'post', 'delete'])
})

test('detail maps onto the operation', () => {
  const document = build([
    {
      method: 'GET',
      path: '/users/:id',
      detail: {
        operationId: 'getUser',
        summary: 'Get user',
        description: 'Returns a user',
        tags: ['Users'],
        deprecated: true
      }
    }
  ])

  expect(operation(document, '/users/{id}')).toMatchObject({
    operationId: 'getUser',
    summary: 'Get user',
    description: 'Returns a user',
    tags: ['Users'],
    deprecated: true
  })
})

test('a route with nothing declared produces a bare operation', () => {
  const document = build([{ method: 'GET', path: '/health' }])

  expect(operation(document, '/health')).toEqual({})
})

test('servers, tags and security pass through', () => {
  const document = buildDocument([{ method: 'GET', path: '/health' }], {
    info,
    servers: [{ url: 'https://api.example.com' }],
    tags: [{ name: 'Users' }],
    security: [{ bearer: [] }]
  })

  expect(document.servers).toEqual([{ url: 'https://api.example.com' }])
  expect(document.tags).toEqual([{ name: 'Users' }])
  expect(document.security).toEqual([{ bearer: [] }])
})

test('components is omitted when no schema defines one', () => {
  const document = build([
    { method: 'POST', path: '/things', body: z.object({ a: z.string() }) }
  ])

  expect(document.components).toBeUndefined()
})
