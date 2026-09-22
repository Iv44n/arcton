import { expect, test } from 'bun:test'
import { parse } from './parse'

test('/users/:id/posts/:postId → 4 segments', () => {
  const { segments } = parse('/users/:id/posts/:postId')
  expect(segments).toEqual([
    { type: 'static', value: 'users' },
    { type: 'dynamic', name: 'id' },
    { type: 'static', value: 'posts' },
    { type: 'dynamic', name: 'postId' }
  ])
})

test('/users/:post_id → 2 segments, name = "post_id" (regex allows _)', () => {
  const { segments } = parse('/users/:post_id')
  expect(segments).toEqual([
    { type: 'static', value: 'users' },
    { type: 'dynamic', name: 'post_id' }
  ])
})

test('/files/*path → wildcard terminal', () => {
  const { segments } = parse('/files/*path')
  expect(segments).toEqual([
    { type: 'static', value: 'files' },
    { type: 'wildcard', name: 'path' }
  ])
})

test('/users/:id/posts/:id → throws (repeated param)', () => {
  expect(() => parse('/users/:id/posts/:id')).toThrow()
})

test('/files/*path/extra → throws (wildcard not terminal)', () => {
  expect(() => parse('/files/*path/extra')).toThrow()
})

test('/users//x → throws (empty segment in pattern)', () => {
  expect(() => parse('/users//x')).toThrow()
})

test('/café → throws (does not round-trip)', () => {
  expect(() => parse('/café')).toThrow()
})

test('/us ers → throws (space, does not round-trip)', () => {
  expect(() => parse('/us ers')).toThrow()
})

test('/a?b → throws (? is parsed as query)', () => {
  expect(() => parse('/a?b')).toThrow()
})

test('/a#b → throws (# is parsed as fragment)', () => {
  expect(() => parse('/a#b')).toThrow()
})

test('/a\\b → throws (\\ normalizes to /)', () => {
  expect(() => parse('/a\\b')).toThrow()
})

test('/a/.. → throws (dot-segment as static)', () => {
  expect(() => parse('/a/..')).toThrow()
})

test('/. → throws (dot-segment as static)', () => {
  expect(() => parse('/.')).toThrow()
})

test('/: → throws (anonymous param, no name)', () => {
  expect(() => parse('/:')).toThrow()
})

test('/* → throws (anonymous wildcard, no name)', () => {
  expect(() => parse('/*')).toThrow()
})

test('/:123 → throws (does not start with a letter)', () => {
  expect(() => parse('/:123')).toThrow()
})

test('/:_x → throws (does not start with a letter)', () => {
  expect(() => parse('/:_x')).toThrow()
})

test('users (no leading /) → throws', () => {
  expect(() => parse('users')).toThrow()
})

test('"" (empty string) → throws', () => {
  expect(() => parse('')).toThrow()
})

test('/ (root) → 0 segments', () => {
  const { segments } = parse('/')
  expect(segments).toEqual([])
})

// Additional cases beyond the ones above, covered by the parse-time rules.

test('a:b and a*b are static segments (a param must occupy the whole segment)', () => {
  const { segments } = parse('/a:b/a*b')
  expect(segments).toEqual([
    { type: 'static', value: 'a:b' },
    { type: 'static', value: 'a*b' }
  ])
})

test('*path does not require a preceding segment — a wildcard right at the root is syntactically valid too', () => {
  const { segments } = parse('/*all')
  expect(segments).toEqual([{ type: 'wildcard', name: 'all' }])
})

test('%zz (invalid percent-encoding) in a static segment passes the round-trip check', () => {
  const { segments } = parse('/%zz')
  expect(segments).toEqual([{ type: 'static', value: '%zz' }])
})

test('%2f (hex case preserved) in a static segment passes the round-trip check', () => {
  const { segments } = parse('/%2f')
  expect(segments).toEqual([{ type: 'static', value: '%2f' }])
})

test('/*a/*b → throws (a second * after a wildcard, not terminal)', () => {
  expect(() => parse('/*a/*b')).toThrow()
})

test('a dynamic and a wildcard sharing the same name in one route → throws', () => {
  expect(() => parse('/users/:id/*id')).toThrow()
})

test('multiple valid static segments, no params', () => {
  const { segments } = parse('/users/settings/profile')
  expect(segments).toEqual([
    { type: 'static', value: 'users' },
    { type: 'static', value: 'settings' },
    { type: 'static', value: 'profile' }
  ])
})
