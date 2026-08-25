// Low-level tests of match() itself: called directly with a pathname and
// method (skipping the URL/query construction that router.ts owns), to
// isolate behavior that belongs to match.ts specifically. The broader
// end-to-end matching behavior is covered via createRouter() in
// router.test.ts instead — these are additional, lower-level cases.

import { expect, test } from 'bun:test'
import type { RouteHandler } from '@arcton/contracts'
import { match } from './match'
import { parse } from './parse'
import { createRouteNode, insert } from './tree'

const noop: RouteHandler = () => {}

test('match() returns { notFound: true } (not null) when there is no route', () => {
  const root = createRouteNode()
  insert(root, parse('/users'), 'GET', noop)

  const result = match(root, '/nope', 'GET')
  expect(result).toEqual({ notFound: true })
})

test('match() collapses an interior "//" directly on the pathname (does not depend on URL)', () => {
  const root = createRouteNode()
  insert(root, parse('/users/:id'), 'GET', noop)

  const result = match(root, '/users//123', 'GET')
  expect(result).toEqual({
    matched: true,
    handler: noop,
    params: { id: '123' }
  })
})

test('match() normalizes a trailing slash directly on the pathname', () => {
  const root = createRouteNode()
  insert(root, parse('/users'), 'GET', noop)

  const result = match(root, '/users/', 'GET')
  expect(result).toEqual({ matched: true, handler: noop, params: {} })
})

test('allowed respects method insertion order, not alphabetical order', () => {
  const root = createRouteNode()
  insert(root, parse('/users/:id'), 'POST', noop)
  insert(root, parse('/users/:id'), 'DELETE', noop)
  insert(root, parse('/users/:id'), 'GET', noop)

  const result = match(root, '/users/1', 'PATCH')
  expect(result).toEqual({
    methodNotAllowed: true,
    allowed: ['POST', 'DELETE', 'GET']
  })
})

test('the decode fallback applies per segment inside a wildcard, not to the full join', () => {
  const root = createRouteNode()
  insert(root, parse('/files/*path'), 'GET', noop)

  // "%zz" (invalid) and "ok" (valid) are decoded independently before
  // the join — one broken segment doesn't drag the others down with it.
  const result = match(root, '/files/%zz/ok', 'GET')
  expect(result).toEqual({
    matched: true,
    handler: noop,
    params: { path: '%zz/ok' }
  })
})
