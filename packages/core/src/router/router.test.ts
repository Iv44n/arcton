// Integration tests for createRouter(), exercised end-to-end (method + url
// string, like real usage). See match.test.ts for a few lower-level cases
// specific to match.ts's own responsibilities.

import { expect, test } from 'bun:test'
import type { MatchResult, RouteHandler } from '@arcton/contracts'
import { createRouter } from './router'

const noop: RouteHandler = () => {}

// MatchResult is a discriminated union; these assert + narrow in one step
// so tests can read `.params`/`.handler`/`.allowed` without a manual guard
// at every call site.
function assertMatched(
  result: MatchResult
): asserts result is Extract<MatchResult, { matched: true }> {
  if (!('matched' in result)) {
    throw new Error(`expected matched, got ${JSON.stringify(result)}`)
  }
}

function assertMethodNotAllowed(
  result: MatchResult
): asserts result is Extract<MatchResult, { methodNotAllowed: true }> {
  if (!('methodNotAllowed' in result)) {
    throw new Error(`expected methodNotAllowed, got ${JSON.stringify(result)}`)
  }
}

// Priority: static > dynamic > wildcard.

test('GET /users/me → wins /users/me (static)', () => {
  const router = createRouter()
  const meHandler: RouteHandler = () => {}
  router.insert('GET', '/users/me', meHandler)
  router.insert('GET', '/users/:id', noop)
  router.insert('GET', '/users/*path', noop)

  const result = router.match('GET', '/users/me')
  assertMatched(result)
  expect(result.handler).toBe(meHandler)
  expect(result.params).toEqual({})
})

test('GET /users/123 → wins /users/:id (dynamic)', () => {
  const router = createRouter()
  const idHandler: RouteHandler = () => {}
  router.insert('GET', '/users/me', noop)
  router.insert('GET', '/users/:id', idHandler)
  router.insert('GET', '/users/*path', noop)

  const result = router.match('GET', '/users/123')
  assertMatched(result)
  expect(result.handler).toBe(idHandler)
  expect(result.params).toEqual({ id: '123' })
})

test('GET /users/123/posts/1 → wins /users/*path (wildcard)', () => {
  const router = createRouter()
  const wildcardHandler: RouteHandler = () => {}
  router.insert('GET', '/users/me', noop)
  router.insert('GET', '/users/:id', noop)
  router.insert('GET', '/users/*path', wildcardHandler)

  const result = router.match('GET', '/users/123/posts/1')
  assertMatched(result)
  expect(result.handler).toBe(wildcardHandler)
  expect(result.params).toEqual({ path: '123/posts/1' })
})

// Registration order is irrelevant.

test('registering in reverse order produces the same matching result', () => {
  const forward = createRouter()
  forward.insert('GET', '/users/:id', noop)
  forward.insert('GET', '/users/me', noop)

  const reverse = createRouter()
  reverse.insert('GET', '/users/me', noop)
  reverse.insert('GET', '/users/:id', noop)

  for (const router of [forward, reverse]) {
    const me = router.match('GET', '/users/me')
    assertMatched(me)
    expect(me.params).toEqual({})

    const dynamic = router.match('GET', '/users/123')
    assertMatched(dynamic)
    expect(dynamic.params).toEqual({ id: '123' })
  }
})

test('DELETE /users/123 with only GET /users/:id → methodNotAllowed with allowed: ["GET"]', () => {
  const router = createRouter()
  router.insert('GET', '/users/:id', noop)

  const result = router.match('DELETE', '/users/123')
  assertMethodNotAllowed(result)
  expect(result.allowed).toEqual(['GET'])
})

test('/users/ivan%20dev → params.id === "ivan dev" (decoded)', () => {
  const router = createRouter()
  router.insert('GET', '/users/:id', noop)

  const result = router.match('GET', '/users/ivan%20dev')
  assertMatched(result)
  expect(result.params.id).toBe('ivan dev')
})

test('/files/foo%2Fbar → params.path === "foo/bar" (fully decoded, without splitting the segment)', () => {
  const router = createRouter()
  router.insert('GET', '/files/*path', noop)

  const result = router.match('GET', '/files/foo%2Fbar')
  assertMatched(result)
  expect(result.params.path).toBe('foo/bar')
})

test('GET / (root) → root handler', () => {
  const router = createRouter()
  const rootHandler: RouteHandler = () => {}
  router.insert('GET', '/', rootHandler)

  const result = router.match('GET', '/')
  assertMatched(result)
  expect(result.handler).toBe(rootHandler)
  expect(result.params).toEqual({})
})

test('POST /users/me with only GET /users/me + GET /users/:id → 405, does not fall through to dynamic', () => {
  const router = createRouter()
  router.insert('GET', '/users/me', noop)
  router.insert('GET', '/users/:id', noop)

  const result = router.match('POST', '/users/me')
  assertMethodNotAllowed(result)
  expect(result.allowed).toEqual(['GET'])
})

test('GET /users/me + POST /users/:id, request POST /users/me → 405 Allow: GET (the discriminating form of shadowing)', () => {
  const router = createRouter()
  router.insert('GET', '/users/me', noop)
  router.insert('POST', '/users/:id', noop)

  const result = router.match('POST', '/users/me')
  assertMethodNotAllowed(result)
  expect(result.allowed).toEqual(['GET'])
})

test('case-sensitivity: /Users does not match /users', () => {
  const router = createRouter()
  router.insert('GET', '/users', noop)

  const result = router.match('GET', '/Users')
  expect(result).toEqual({ notFound: true })
})

test('/files/*path when /files/static also exists → static wins', () => {
  const router = createRouter()
  const staticHandler: RouteHandler = () => {}
  router.insert('GET', '/files/*path', noop)
  router.insert('GET', '/files/static', staticHandler)

  const result = router.match('GET', '/files/static')
  assertMatched(result)
  expect(result.handler).toBe(staticHandler)
})

test('static→dynamic backtracking: /foo/bar/baz + /foo/:id/qux, request /foo/bar/qux → matched with params.id === "bar"', () => {
  const router = createRouter()
  const quxHandler: RouteHandler = () => {}
  router.insert('GET', '/foo/bar/baz', noop)
  router.insert('GET', '/foo/:id/qux', quxHandler)

  const result = router.match('GET', '/foo/bar/qux')
  assertMatched(result)
  expect(result.handler).toBe(quxHandler)
  expect(result.params).toEqual({ id: 'bar' })
})

test('intermediate node with no handlers: /users/me/profile (GET), request GET /users/me → 404', () => {
  const router = createRouter()
  router.insert('GET', '/users/me/profile', noop)

  const result = router.match('GET', '/users/me')
  expect(result).toEqual({ notFound: true })
})

test('wildcard requires ≥1 segment: with only /files/*path, GET /files → 404', () => {
  const router = createRouter()
  router.insert('GET', '/files/*path', noop)

  const result = router.match('GET', '/files')
  expect(result).toEqual({ notFound: true })
})

test('decode with fallback: GET /%zz (route /:id) → params.id === "%zz"', () => {
  const router = createRouter()
  router.insert('GET', '/:id', noop)

  const result = router.match('GET', '/%zz')
  assertMatched(result)
  expect(result.params.id).toBe('%zz')
})

test('405 vs. an ancestor wildcard: GET /a/:id/b + POST /a/*rest, request POST /a/x/b → 405 Allow: GET', () => {
  const router = createRouter()
  router.insert('GET', '/a/:id/b', noop)
  router.insert('POST', '/a/*rest', noop)

  const result = router.match('POST', '/a/x/b')
  assertMethodNotAllowed(result)
  expect(result.allowed).toEqual(['GET'])
})

test('405 shadows the wildcard depending on depth: GET /a/:id + POST /a/*rest, POST /a/b → 405 Allow: GET', () => {
  const router = createRouter()
  router.insert('GET', '/a/:id', noop)
  router.insert('POST', '/a/*rest', noop)

  const result = router.match('POST', '/a/b')
  assertMethodNotAllowed(result)
  expect(result.allowed).toEqual(['GET'])
})

test('same shape, one level deeper: POST /a/b/c → 200, rest: "b/c" (:id never reaches a terminal node)', () => {
  const router = createRouter()
  router.insert('GET', '/a/:id', noop)
  router.insert('POST', '/a/*rest', noop)

  const result = router.match('POST', '/a/b/c')
  assertMatched(result)
  expect(result.params).toEqual({ rest: 'b/c' })
})

test('"//" collapse in the request: GET /users//123 (route /users/:id) → matched with params.id === "123"', () => {
  const router = createRouter()
  router.insert('GET', '/users/:id', noop)

  const result = router.match('GET', '/users//123')
  assertMatched(result)
  expect(result.params).toEqual({ id: '123' })
})

test('"//" collapse in the request: GET /files/a//b (route /files/*path) → params.path === "a/b"', () => {
  const router = createRouter()
  router.insert('GET', '/files/*path', noop)

  const result = router.match('GET', '/files/a//b')
  assertMatched(result)
  expect(result.params).toEqual({ path: 'a/b' })
})

test('Allow from a wildcard node: only GET /a/*rest, request POST /a/b/c → 405 Allow: GET', () => {
  const router = createRouter()
  router.insert('GET', '/a/*rest', noop)

  const result = router.match('POST', '/a/b/c')
  assertMethodNotAllowed(result)
  expect(result.allowed).toEqual(['GET'])
})

test('dot-segments normalized by URL: GET /a/../users (route /users) → matched', () => {
  const router = createRouter()
  const usersHandler: RouteHandler = () => {}
  router.insert('GET', '/users', usersHandler)

  const result = router.match('GET', '/a/../users')
  assertMatched(result)
  expect(result.handler).toBe(usersHandler)
})

// HEAD/OPTIONS without registration — the uniform rule, no special-casing.

test('HEAD /x with only GET /x → 405 Allow: GET', () => {
  const router = createRouter()
  router.insert('GET', '/x', noop)

  const result = router.match('HEAD', '/x')
  assertMethodNotAllowed(result)
  expect(result.allowed).toEqual(['GET'])
})

test('OPTIONS /x with only GET /x → 405 Allow: GET', () => {
  const router = createRouter()
  router.insert('GET', '/x', noop)

  const result = router.match('OPTIONS', '/x')
  assertMethodNotAllowed(result)
  expect(result.allowed).toEqual(['GET'])
})

test('OPTIONS /no-existe → 404', () => {
  const router = createRouter()
  router.insert('GET', '/x', noop)

  const result = router.match('OPTIONS', '/no-existe')
  expect(result).toEqual({ notFound: true })
})

// matchPathname — the pathname-only entry point a caller uses when it has
// already parsed the request URL itself (e.g. to also read searchParams),
// to avoid parsing the same URL twice.

test('matchPathname matches the same route as match(), given the same pathname', () => {
  const router = createRouter()
  const idHandler: RouteHandler = () => {}
  router.insert('GET', '/users/:id', idHandler)

  const result = router.matchPathname('GET', '/users/123')
  assertMatched(result)
  expect(result.handler).toBe(idHandler)
  expect(result.params).toEqual({ id: '123' })
})

test('matchPathname takes the pathname as-is — no URL normalization, unlike match()', () => {
  const router = createRouter()
  router.insert('GET', '/users', noop)

  // match() normalizes "/a/../users" down to "/users" via URL parsing.
  // matchPathname() has no URL parsing step, so the same raw string is
  // matched literally and doesn't collapse — the caller is responsible for
  // passing an already-parsed `pathname`.
  const result = router.matchPathname('GET', '/a/../users')
  expect(result).toEqual({ notFound: true })
})
