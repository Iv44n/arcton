import { expect, test } from 'bun:test'
import { Http, HttpError } from './errors'

test('HttpError carries status, code, message and an optional body', () => {
  const err = new HttpError(418, 'TEAPOT', "I'm a Teapot", {
    reason: 'short and stout'
  })

  expect(err.status).toBe(418)
  expect(err.code).toBe('TEAPOT')
  expect(err.message).toBe("I'm a Teapot")
  expect(err.body).toEqual({ reason: 'short and stout' })
  expect(err).toBeInstanceOf(Error)
})

test('a status factory needs no "new" and carries its own status, code and a default message', () => {
  const err = Http.NotFound()

  expect(err.status).toBe(404)
  expect(err.code).toBe('NOT_FOUND')
  expect(err.message).toBe('Not Found')
  expect(err).toBeInstanceOf(HttpError)
})

test('a status factory accepts a custom message and body but keeps its own code', () => {
  const err = Http.Conflict('Email already registered', { field: 'email' })

  expect(err.status).toBe(409)
  expect(err.code).toBe('CONFLICT')
  expect(err.message).toBe('Email already registered')
  expect(err.body).toEqual({ field: 'email' })
})
