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

test('bunAdapter dispatches to a matching route and falls back to fetch otherwise', async () => {
  const server = bunAdapter.serve({
    port: 0,
    routes: [
      { method: 'GET', path: '/hello', handler: () => new Response('hi') }
    ],
    fetch: () => new Response('not found', { status: 404 })
  })

  const routed = await fetch(new URL('/hello', server.url))
  expect(await routed.text()).toBe('hi')

  const fallback = await fetch(new URL('/missing', server.url))
  expect(fallback.status).toBe(404)

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
