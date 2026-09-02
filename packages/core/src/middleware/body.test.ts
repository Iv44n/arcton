import { expect, test } from 'bun:test'
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

test('an unsupported content-type is not parsed', async () => {
  const request = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=x' },
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

  expect(result).toEqual({ ok: false, reason: 'invalid-json' })
})
