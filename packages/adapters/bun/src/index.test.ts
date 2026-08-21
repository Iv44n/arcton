import { expect, test } from 'bun:test'
import { bunAdapter } from './index'

test('bunAdapter serves the fetch handler and exposes url/port', async () => {
  const server = bunAdapter.serve({
    port: 0,
    fetch: () => new Response('ok')
  })

  const res = await fetch(server.url)
  expect(await res.text()).toBe('ok')
  expect(server.port).toBeGreaterThan(0)

  server.stop()
})
