import { expect, test } from 'bun:test'
import { nodeAdapter } from './index'

test('nodeAdapter serves the fetch handler and exposes url/port', async () => {
  const server = nodeAdapter.serve({
    port: 0,
    fetch: () => new Response('ok')
  })

  const res = await fetch(server.url)
  expect(await res.text()).toBe('ok')
  expect(server.port).toBeGreaterThan(0)

  await server.stop()
})

test('nodeAdapter has no HTTP routing of its own — every request goes straight to fetch', async () => {
  const server = nodeAdapter.serve({
    port: 0,
    fetch: request => new Response(`handled ${new URL(request.url).pathname}`)
  })

  const res = await fetch(new URL('/anything', server.url))
  expect(await res.text()).toBe('handled /anything')

  await server.stop()
})

test('nodeAdapter forwards method, headers and a request body to fetch', async () => {
  const server = nodeAdapter.serve({
    port: 0,
    fetch: async request => {
      const body = await request.text()
      return new Response(
        JSON.stringify({
          method: request.method,
          header: request.headers.get('x-test'),
          body
        })
      )
    }
  })

  const res = await fetch(server.url, {
    method: 'POST',
    headers: { 'x-test': 'yes' },
    body: 'hello'
  })
  expect(await res.json()).toEqual({
    method: 'POST',
    header: 'yes',
    body: 'hello'
  })

  await server.stop()
})

test('nodeAdapter (adapter-specific) turns an uncaught fetch error into a 500', async () => {
  const server = nodeAdapter.serve({
    port: 0,
    fetch: () => {
      throw new Error('boom')
    }
  })

  const res = await fetch(server.url)
  expect(res.status).toBe(500)

  await server.stop()
})

test('nodeAdapter auto-upgrades a registered websocket route and exchanges messages', async () => {
  const server = nodeAdapter.serve({
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
  await server.stop()
})

test('nodeAdapter destroys the socket for an upgrade request on an unregistered path', async () => {
  const server = nodeAdapter.serve({
    port: 0,
    fetch: () => new Response('not found', { status: 404 }),
    websocket: [{ path: '/chat', handler: { message: () => {} } }]
  })

  const wsUrl = new URL('/unknown', server.url)
  wsUrl.protocol = 'ws:'

  const ws = new WebSocket(wsUrl)
  const errored = new Promise<void>(resolve =>
    ws.addEventListener('error', () => resolve())
  )
  await errored

  await server.stop()
})
