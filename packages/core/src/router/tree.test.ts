import { expect, test } from 'bun:test'
import type { RouteHandler } from '@arcton/contracts'
import { parse } from './parse'
import { createRouteNode, insert } from './tree'

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
