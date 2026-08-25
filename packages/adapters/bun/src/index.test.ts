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

test('bunAdapter has no HTTP routing of its own — every request goes straight to fetch', async () => {
  const server = bunAdapter.serve({
    port: 0,
    fetch: request => new Response(`handled ${new URL(request.url).pathname}`)
  })

  const res = await fetch(new URL('/anything', server.url))
  expect(await res.text()).toBe('handled /anything')

  server.stop()
})

test('bunAdapter (adapter-specific) turns an uncaught fetch error into a 500', async () => {
  const server = bunAdapter.serve({
    port: 0,
    fetch: () => {
      throw new Error('boom')
    }
  })

  const res = await fetch(server.url)
  expect(res.status).toBe(500)

  server.stop()
})

test('bunAdapter auto-upgrades a registered websocket route and exchanges messages', async () => {
  const server = bunAdapter.serve({
    port: 0,
    fetch: () => new Response('not found', { status: 404 }),
    websocket: [
      {
        path: '/chat',
        handler: {
          message: (ws, message) => {
            ws.send(`echo:${message}`)
          }
        }
      }
    ]
  })

  const wsUrl = new URL('/chat', server.url)
  wsUrl.protocol = 'ws:'

  const ws = new WebSocket(wsUrl)
  await new Promise<void>(resolve =>
    ws.addEventListener('open', () => resolve())
  )

  const reply = new Promise<string>(resolve => {
    ws.addEventListener('message', event => resolve(event.data as string))
  })
  ws.send('hello')

  expect(await reply).toBe('echo:hello')

  ws.close()
  server.stop()
})
