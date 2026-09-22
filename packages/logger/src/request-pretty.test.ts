import { expect, test } from 'bun:test'
import {
  formatRequestEnd,
  formatRequestError,
  formatRequestStart
} from './request-pretty'

// Strips ANSI escapes so assertions read the actual text, not raw codes.
function plain(line: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the escapes this regex targets
  return line.replace(/\x1b\[\d+m/g, '')
}

const CLOCK = /\d{2}:\d{2}:\d{2}\.\d{3}/

test('the start line opens with a blank line, a → arrow, an INFO label, and a clock', () => {
  const line = formatRequestStart('GET', '/users/1')
  expect(line.startsWith('\n')).toBe(true)
  expect(plain(line)).toMatch(
    new RegExp(`^\\n→ INFO {2}${CLOCK.source} GET    /users/1$`)
  )
})

test('the end line shows the given level as text, not just a color', () => {
  expect(plain(formatRequestEnd('GET', '/x', 200, 1, 'info'))).toContain(
    'INFO '
  )
  expect(plain(formatRequestEnd('GET', '/x', 404, 1, 'warn'))).toContain(
    'WARN '
  )
  expect(plain(formatRequestEnd('GET', '/x', 500, 1, 'error'))).toContain(
    'ERROR'
  )
})

test('the end line closes with a ← arrow, level, clock, status, method, path, duration', () => {
  const line = formatRequestEnd('GET', '/users/1', 200, 12.34, 'info')
  expect(plain(line)).toMatch(
    new RegExp(`^← INFO {2}${CLOCK.source} 200 GET    /users/1 12\\.3ms$`)
  )
})

test('the error line is labeled ERROR, with no status and the message appended', () => {
  const line = formatRequestError('GET', '/boom', 1.2, new Error('kaboom'))
  expect(plain(line)).toMatch(
    new RegExp(`^← ERROR ${CLOCK.source} GET    /boom 1\\.2ms kaboom$`)
  )
})

test('the clock reflects the moment each line is formatted', () => {
  const start = formatRequestStart('GET', '/x')
  const clock = plain(start).match(CLOCK)?.[0]
  expect(clock).toBeDefined()
  expect(new Date(`1970-01-01T${clock}Z`).toString()).not.toBe('Invalid Date')
})

test('a non-Error thrown value still formats, via String()', () => {
  const line = formatRequestError('GET', '/boom', 1.2, 'plain string failure')
  expect(plain(line)).toContain('plain string failure')
})

test('method is padded to a fixed width so paths line up', () => {
  expect(plain(formatRequestStart('GET', '/x'))).toContain('GET    /x')
  expect(plain(formatRequestStart('DELETE', '/x'))).toContain('DELETE /x')
})
