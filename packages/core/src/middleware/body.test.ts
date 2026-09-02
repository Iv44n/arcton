import { expect, test } from 'bun:test'
import type { BodyParser } from '@arcton/contracts'
import { parseBody } from './body'

test('application/json is parsed', async () => {
  const request = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Ivan' })
  })

  const result = await parseBody(request)

  expect(result).toEqual({ ok: true, value: { name: 'Ivan' } })
})

test('application/*+json (RFC 6839 suffix) is parsed as JSON', async () => {
  const request = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'application/vnd.api+json' },
    body: JSON.stringify({ name: 'Ivan' })
  })

  const result = await parseBody(request)

  expect(result).toEqual({ ok: true, value: { name: 'Ivan' } })
})

test('a charset suffix on the content-type does not break the match', async () => {
  const request = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ name: 'Ivan' })
  })

  const result = await parseBody(request)

  expect(result).toEqual({ ok: true, value: { name: 'Ivan' } })
})

test('a genuinely unsupported content-type is not parsed', async () => {
  const request = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'application/xml' },
    body: 'irrelevant'
  })

  const result = await parseBody(request)

  expect(result).toEqual({ ok: false, reason: 'unsupported-media-type' })
})

test('no content-type at all is not parsed', async () => {
  const request = new Request('http://localhost/', {
    method: 'POST',
    body: 'irrelevant'
  })

  const result = await parseBody(request)

  expect(result).toEqual({ ok: false, reason: 'unsupported-media-type' })
})

test('a case-varied content-type (e.g. application/JSON) is still parsed', async () => {
  const request = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'Application/JSON' },
    body: JSON.stringify({ name: 'Ivan' })
  })

  const result = await parseBody(request)

  expect(result).toEqual({ ok: true, value: { name: 'Ivan' } })
})

test('malformed JSON with a JSON content-type is reported, not thrown', async () => {
  const request = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json'
  })

  const result = await parseBody(request)

  expect(result).toEqual({ ok: false, reason: 'invalid-body' })
})

test('text/plain is parsed as a string', async () => {
  const request = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'hello'
  })

  const result = await parseBody(request)

  expect(result).toEqual({ ok: true, value: 'hello' })
})

test('application/x-www-form-urlencoded is parsed as FormData', async () => {
  const request = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'a=1&b=2'
  })

  const result = await parseBody(request)

  expect(result.ok).toBe(true)
  const value = (result as { ok: true; value: FormData }).value
  expect(value).toBeInstanceOf(FormData)
  expect(value.get('a')).toBe('1')
  expect(value.get('b')).toBe('2')
})

test('multipart/form-data is parsed as FormData', async () => {
  const form = new FormData()
  form.set('name', 'Ivan')
  const request = new Request('http://localhost/', { method: 'POST', body: form })

  const result = await parseBody(request)

  expect(result.ok).toBe(true)
  const value = (result as { ok: true; value: FormData }).value
  expect(value).toBeInstanceOf(FormData)
  expect(value.get('name')).toBe('Ivan')
})

test('malformed multipart is reported, not thrown', async () => {
  const request = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=x' },
    body: 'not actually multipart'
  })

  const result = await parseBody(request)

  expect(result).toEqual({ ok: false, reason: 'invalid-body' })
})

test('application/octet-stream is parsed as ArrayBuffer', async () => {
  const bytes = new Uint8Array([1, 2, 3])
  const request = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes
  })

  const result = await parseBody(request)

  expect(result.ok).toBe(true)
  const value = (result as { ok: true; value: ArrayBuffer }).value
  expect(value).toBeInstanceOf(ArrayBuffer)
  expect(new Uint8Array(value)).toEqual(bytes)
})

// ── custom parsers ───────────────────────────────────────────────────────

test('a registered custom parser handles its exact media type', async () => {
  const request = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'application/vnd.foo' },
    body: 'FOO:42'
  })
  const parsers = new Map<string, BodyParser>([
    ['application/vnd.foo', async r => ({ n: Number((await r.text()).split(':')[1]) })]
  ])

  const result = await parseBody(request, parsers)

  expect(result).toEqual({ ok: true, value: { n: 42 } })
})

test('a custom parser overrides a built-in for the same media type', async () => {
  const request = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'irrelevant'
  })
  const parsers = new Map<string, BodyParser>([
    ['application/json', async () => ({ overridden: true })]
  ])

  const result = await parseBody(request, parsers)

  expect(result).toEqual({ ok: true, value: { overridden: true } })
})

test('a custom parser returning undefined means "not handled" → unsupported-media-type', async () => {
  const request = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'application/vnd.foo' },
    body: 'irrelevant'
  })
  const parsers = new Map<string, BodyParser>([
    ['application/vnd.foo', () => undefined]
  ])

  const result = await parseBody(request, parsers)

  expect(result).toEqual({ ok: false, reason: 'unsupported-media-type' })
})

test.each([
  ['false', false],
  ['0', 0],
  ['empty string', ''],
  ['null', null],
  ['empty object', {}]
])('a custom parser returning falsy-but-not-undefined (%s) counts as handled', async (_label, value) => {
  const request = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'application/vnd.foo' },
    body: 'irrelevant'
  })
  const parsers = new Map<string, BodyParser>([['application/vnd.foo', () => value]])

  const result = await parseBody(request, parsers)

  expect(result).toEqual({ ok: true, value })
})

test('a throwing custom parser propagates uncaught, unlike a built-in', async () => {
  const request = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'application/vnd.foo' },
    body: 'irrelevant'
  })
  const parsers = new Map<string, BodyParser>([
    [
      'application/vnd.foo',
      () => {
        throw new Error('custom parser boom')
      }
    ]
  ])

  await expect(parseBody(request, parsers)).rejects.toThrow('custom parser boom')
})
