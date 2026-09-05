import { expect, test } from 'bun:test'
import type { RouteHandler } from '@arcton/contracts'
import { parse } from './parse'
import { createRouteNode, graftTree, insert } from './tree'

const noop: RouteHandler = () => {}

test('duplicate GET /users/:id → throws (#13)', () => {
  const root = createRouteNode()
  insert(root, parse('/users/:id'), 'GET', noop)
  expect(() => insert(root, parse('/users/:id'), 'GET', noop)).toThrow()
})

test('GET /users/:id + POST /users/:id → OK (two handlers on the same node)', () => {
  const root = createRouteNode()
  const getHandler: RouteHandler = () => {}
  const postHandler: RouteHandler = () => {}
  insert(root, parse('/users/:id'), 'GET', getHandler)
  insert(root, parse('/users/:id'), 'POST', postHandler)

  const idNode = root.static.get('users')?.dynamic?.node
  expect(idNode).toBeDefined()
  expect(idNode?.handlers.get('GET')).toBe(getHandler)
  expect(idNode?.handlers.get('POST')).toBe(postHandler)
  expect(idNode?.handlers.size).toBe(2)
})

test('/users/:id + /users/:name → throw "conflicting parameter name"', () => {
  const root = createRouteNode()
  insert(root, parse('/users/:id'), 'GET', noop)
  expect(() => insert(root, parse('/users/:name'), 'POST', noop)).toThrow(
    'Conflicting parameter name: "name" conflicts with "id" at same position'
  )
})

test('/files/*path + /files/*other → throw', () => {
  const root = createRouteNode()
  insert(root, parse('/files/*path'), 'GET', noop)
  expect(() => insert(root, parse('/files/*other'), 'GET', noop)).toThrow(
    'Conflicting parameter name: "other" conflicts with "path" at same position'
  )
})

test('GET /users/:id + POST /users/:name → throw (method-independent conflict)', () => {
  const root = createRouteNode()
  insert(root, parse('/users/:id'), 'GET', noop)
  expect(() => insert(root, parse('/users/:name'), 'POST', noop)).toThrow(
    'Conflicting parameter name: "name" conflicts with "id" at same position'
  )
})

test("app.get('/', h) inserts the handler at the root node", () => {
  const root = createRouteNode()
  insert(root, parse('/'), 'GET', noop)
  expect(root.handlers.get('GET')).toBe(noop)
  expect(root.static.size).toBe(0)
  expect(root.dynamic).toBeUndefined()
  expect(root.wildcard).toBeUndefined()
})

test('the tree reflects the nested structure', () => {
  const root = createRouteNode()
  insert(root, parse('/users/me'), 'GET', noop)
  insert(root, parse('/users/:id'), 'GET', noop)
  insert(root, parse('/files/*path'), 'GET', noop)

  const usersNode = root.static.get('users')
  expect(usersNode).toBeDefined()
  expect(usersNode?.static.get('me')?.handlers.has('GET')).toBe(true)
  expect(usersNode?.dynamic?.name).toBe('id')
  expect(usersNode?.dynamic?.node.handlers.has('GET')).toBe(true)

  const filesNode = root.static.get('files')
  expect(filesNode).toBeDefined()
  expect(filesNode?.wildcard?.name).toBe('path')
  expect(filesNode?.wildcard?.node.handlers.has('GET')).toBe(true)
})

// Additional cases.

test('inserting two distinct static routes shares the parent node, does not clobber it', () => {
  const root = createRouteNode()
  insert(root, parse('/users/settings'), 'GET', noop)
  insert(root, parse('/users/profile'), 'GET', noop)

  const usersNode = root.static.get('users')
  expect(usersNode?.static.size).toBe(2)
  expect(usersNode?.static.get('settings')?.handlers.has('GET')).toBe(true)
  expect(usersNode?.static.get('profile')?.handlers.has('GET')).toBe(true)
})

test('the same dynamic name in the same slot from different routes does not conflict', () => {
  const root = createRouteNode()
  insert(root, parse('/users/:id'), 'GET', noop)
  insert(root, parse('/users/:id/posts'), 'GET', noop)

  const idNode = root.static.get('users')?.dynamic?.node
  expect(idNode?.handlers.has('GET')).toBe(true)
  expect(idNode?.static.get('posts')?.handlers.has('GET')).toBe(true)
})

test('registering in reverse order produces the same tree (order-independent)', () => {
  const rootA = createRouteNode()
  insert(rootA, parse('/users/:id'), 'GET', noop)
  insert(rootA, parse('/users/me'), 'GET', noop)

  const rootB = createRouteNode()
  insert(rootB, parse('/users/me'), 'GET', noop)
  insert(rootB, parse('/users/:id'), 'GET', noop)

  for (const root of [rootA, rootB]) {
    const usersNode = root.static.get('users')
    expect(usersNode?.static.get('me')?.handlers.has('GET')).toBe(true)
    expect(usersNode?.dynamic?.name).toBe('id')
    expect(usersNode?.dynamic?.node.handlers.has('GET')).toBe(true)
  }
})

test('dynamic vs wildcard in different slots on the same node do not interfere with each other', () => {
  const root = createRouteNode()
  insert(root, parse('/a/:id'), 'GET', noop)
  insert(root, parse('/a/*rest'), 'POST', noop)

  const aNode = root.static.get('a')
  expect(aNode?.dynamic?.name).toBe('id')
  expect(aNode?.wildcard?.name).toBe('rest')
})

test('duplicate at the root: double GET / → throws', () => {
  const root = createRouteNode()
  insert(root, parse('/'), 'GET', noop)
  expect(() => insert(root, parse('/'), 'GET', noop)).toThrow()
})

test('same path, same dynamic name, different methods → OK, no conflict', () => {
  const root = createRouteNode()
  insert(root, parse('/users/:id'), 'GET', noop)
  insert(root, parse('/users/:id'), 'DELETE', noop)
  insert(root, parse('/users/:id'), 'PATCH', noop)

  const idNode = root.static.get('users')?.dynamic?.node
  expect(idNode?.handlers.size).toBe(3)
})

// ── graftTree — module composition ──────────────────────────────────────
//
// `wrap` below is intentionally visible (not the identity function), so
// tests can assert it actually ran on every grafted handler — and only on
// grafted handlers, never on ones already in `target`.
const tag =
  (label: string): ((handler: RouteHandler) => RouteHandler) =>
  handler =>
    Object.assign(() => handler, { label })

test('empty prefix grafts source directly onto target, no intermediate node', () => {
  const target = createRouteNode()
  const source = createRouteNode()
  insert(source, parse('/status'), 'GET', noop)

  graftTree(target, source, [], tag('wrapped'))

  expect(target.static.size).toBe(1)
  const statusHandler = target.static.get('status')?.handlers.get('GET')
  expect(statusHandler).toBeDefined()
  expect((statusHandler as unknown as { label: string }).label).toBe(
    'wrapped'
  )
})

test('multi-segment prefix nests the grafted tree under every segment', () => {
  const target = createRouteNode()
  const source = createRouteNode()
  insert(source, parse('/ping'), 'GET', noop)

  graftTree(target, source, parse('/api/v1').segments, tag('wrapped'))

  const node = target.static.get('api')?.static.get('v1')?.static.get('ping')
  expect(node?.handlers.has('GET')).toBe(true)
})

test('static + static: unrelated existing route in target is untouched by the graft', () => {
  const target = createRouteNode()
  insert(target, parse('/health'), 'GET', noop)
  const source = createRouteNode()
  insert(source, parse('/status'), 'GET', noop)

  graftTree(target, source, parse('/api').segments, tag('wrapped'))

  expect(target.static.get('health')?.handlers.get('GET')).toBe(noop)
  const grafted = target.static.get('api')?.static.get('status')?.handlers.get(
    'GET'
  )
  expect(grafted).toBeDefined()
  expect(grafted).not.toBe(noop)
})

test('static + dynamic: a dynamic slot in source coexists with a static child already in target', () => {
  const target = createRouteNode()
  insert(target, parse('/api/settings'), 'GET', noop)
  const source = createRouteNode()
  const dynamicHandler: RouteHandler = () => {}
  insert(source, parse('/:id'), 'GET', dynamicHandler)

  graftTree(target, source, parse('/api').segments, tag('wrapped'))

  const apiNode = target.static.get('api')
  expect(apiNode?.static.get('settings')?.handlers.get('GET')).toBe(noop)
  expect(apiNode?.dynamic?.name).toBe('id')
  expect(apiNode?.dynamic?.node.handlers.has('GET')).toBe(true)
})

test('dynamic + dynamic name mismatch on graft → throws, same message as insert()', () => {
  const target = createRouteNode()
  insert(target, parse('/api/:id'), 'GET', noop)
  const source = createRouteNode()
  insert(source, parse('/:userId'), 'GET', noop)

  expect(() =>
    graftTree(target, source, parse('/api').segments, tag('wrapped'))
  ).toThrow(
    'Conflicting parameter name: "userId" conflicts with "id" at same position'
  )
})

test('wildcard name mismatch on graft → throws, same message as insert()', () => {
  const target = createRouteNode()
  insert(target, parse('/files/*path'), 'GET', noop)
  const source = createRouteNode()
  insert(source, parse('/*rest'), 'GET', noop)

  expect(() =>
    graftTree(target, source, parse('/files').segments, tag('wrapped'))
  ).toThrow(
    'Conflicting parameter name: "rest" conflicts with "path" at same position'
  )
})

test('dynamic (target) + wildcard (source) on the same node do not conflict', () => {
  const target = createRouteNode()
  insert(target, parse('/api/:id'), 'GET', noop)
  const source = createRouteNode()
  insert(source, parse('/*rest'), 'POST', noop)

  graftTree(target, source, parse('/api').segments, tag('wrapped'))

  const apiNode = target.static.get('api')
  expect(apiNode?.dynamic?.name).toBe('id')
  expect(apiNode?.wildcard?.name).toBe('rest')
})

test('duplicate (method, path) on graft → throws, same message as insert()', () => {
  const target = createRouteNode()
  insert(target, parse('/api/foo'), 'GET', noop)
  const source = createRouteNode()
  insert(source, parse('/foo'), 'GET', noop)

  expect(() =>
    graftTree(target, source, parse('/api').segments, tag('wrapped'))
  ).toThrow('Duplicate route: GET /api/foo is already registered')
})

test('different methods on the same grafted node do not conflict', () => {
  const target = createRouteNode()
  insert(target, parse('/api/foo'), 'GET', noop)
  const source = createRouteNode()
  insert(source, parse('/foo'), 'POST', noop)

  graftTree(target, source, parse('/api').segments, tag('wrapped'))

  const fooNode = target.static.get('api')?.static.get('foo')
  expect(fooNode?.handlers.get('GET')).toBe(noop)
  expect(fooNode?.handlers.has('POST')).toBe(true)
})

test('source tree is left untouched — grafting the same module twice into different parents works', () => {
  const source = createRouteNode()
  insert(source, parse('/ping'), 'GET', noop)

  const targetA = createRouteNode()
  const targetB = createRouteNode()
  graftTree(targetA, source, parse('/a').segments, tag('a'))
  graftTree(targetB, source, parse('/b').segments, tag('b'))

  expect(source.static.get('ping')?.handlers.get('GET')).toBe(noop)
  expect(targetA.static.get('a')?.static.get('ping')?.handlers.has('GET')).toBe(
    true
  )
  expect(targetB.static.get('b')?.static.get('ping')?.handlers.has('GET')).toBe(
    true
  )
})
