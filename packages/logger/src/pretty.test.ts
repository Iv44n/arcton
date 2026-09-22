import { expect, test } from 'bun:test'
import { formatPretty } from './pretty'

test('the header line has the level, a clock, and the message', () => {
  const line = formatPretty({
    level: 'info',
    time: '2026-09-14T16:00:00.000Z',
    msg: 'hello'
  })

  expect(line).toContain('INFO')
  expect(line).toContain('16:00:00.000')
  expect(line).toContain('hello')
})

test('with no extra fields, the output is a single line', () => {
  const line = formatPretty({
    level: 'info',
    time: '2026-09-14T16:00:00.000Z',
    msg: 'hello'
  })
  expect(line.split('\n')).toHaveLength(1)
})

test('extra fields are listed indented below the header', () => {
  const line = formatPretty({
    level: 'info',
    time: '2026-09-14T16:00:00.000Z',
    msg: 'hello',
    userId: '123'
  })

  const lines = line.split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[1]).toBe('    userId: 123')
})

test('an Error field prints as "Name: message", not raw JSON', () => {
  const line = formatPretty({
    level: 'error',
    time: '2026-09-14T16:00:00.000Z',
    msg: 'failed',
    err: new Error('boom')
  })

  expect(line).toContain('err: Error: boom')
})

test('a non-string, non-error field falls back to JSON', () => {
  const line = formatPretty({
    level: 'info',
    time: '2026-09-14T16:00:00.000Z',
    msg: 'hello',
    count: 2
  })

  expect(line).toContain('count: 2')
})
