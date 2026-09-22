import { expect, test } from 'bun:test'
import { isEnabled } from './levels'

test('a level is enabled at or above the minimum', () => {
  expect(isEnabled('info', 'info')).toBe(true)
  expect(isEnabled('warn', 'info')).toBe(true)
  expect(isEnabled('error', 'info')).toBe(true)
})

test('a level below the minimum is not enabled', () => {
  expect(isEnabled('debug', 'info')).toBe(false)
  expect(isEnabled('trace', 'warn')).toBe(false)
})

test('every real level is disabled when the minimum is silent', () => {
  expect(isEnabled('trace', 'silent')).toBe(false)
  expect(isEnabled('fatal', 'silent')).toBe(false)
})

test('trace is the lowest level, fatal the highest', () => {
  expect(isEnabled('trace', 'trace')).toBe(true)
  expect(isEnabled('fatal', 'trace')).toBe(true)
})
