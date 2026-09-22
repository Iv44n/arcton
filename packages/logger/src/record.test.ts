import { expect, test } from 'bun:test'
import { serializeRecord } from './record'

test('serializes a plain record as JSON', () => {
  const line = serializeRecord({ level: 'info', time: 't', msg: 'hello' })
  expect(JSON.parse(line)).toEqual({ level: 'info', time: 't', msg: 'hello' })
})

test('extra fields pass through untouched', () => {
  const line = serializeRecord({
    level: 'info',
    time: 't',
    msg: 'hello',
    userId: '123',
    count: 2
  })
  expect(JSON.parse(line)).toMatchObject({ userId: '123', count: 2 })
})

test('an Error value serializes to name/message/stack, not {}', () => {
  const err = new Error('boom')
  const line = serializeRecord({
    level: 'error',
    time: 't',
    msg: 'failed',
    err
  })
  const parsed = JSON.parse(line)

  expect(parsed.err.name).toBe('Error')
  expect(parsed.err.message).toBe('boom')
  expect(typeof parsed.err.stack).toBe('string')
})

test('a subclassed Error keeps its own name', () => {
  class NotFoundError extends Error {}
  const err = new NotFoundError('missing')
  const line = serializeRecord({ level: 'error', time: 't', msg: 'x', err })

  expect(JSON.parse(line).err.name).toBe('NotFoundError')
})

test('a circular reference does not throw and is marked instead', () => {
  const circular: Record<string, unknown> = { a: 1 }
  circular.self = circular

  expect(() =>
    serializeRecord({ level: 'info', time: 't', msg: 'x', circular })
  ).not.toThrow()

  const parsed = JSON.parse(
    serializeRecord({ level: 'info', time: 't', msg: 'x', circular })
  )
  expect(parsed.circular.self).toBe('[Circular]')
})
