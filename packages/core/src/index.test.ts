import { expect, test } from 'bun:test'
import { createApp } from './index'

test('createApp returns an app with listen()', () => {
  const app = createApp()
  expect(typeof app.listen).toBe('function')
})

test('createApp stores the given config', () => {
  const app = createApp({ port: 4000 })
  expect(app.config.port).toBe(4000)
})
