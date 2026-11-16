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

test('nodeAdapter: calling stop() again after it already resolved is a no-op, not a rejection', async () => {
  const server = nodeAdapter.serve({
    port: 0,
    fetch: () => new Response('ok')
  })

  await server.stop()
  await expect(server.stop()).resolves.toBeUndefined()
})

test('nodeAdapter: overlapping concurrent stop() calls both resolve instead of one rejecting', async () => {
  const server = nodeAdapter.serve({
    port: 0,
    fetch: () => new Response('ok')
  })

  await expect(Promise.all([server.stop(), server.stop()])).resolves.toEqual([
    undefined,
    undefined
  ])
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

test('nodeAdapter: a "//" request-target is a path, never an authority', async () => {
  const server = nodeAdapter.serve({
    port: 0,
    fetch: request => {
      const url = new URL(request.url)
      return new Response(`${url.host}|${url.pathname}`)
    }
  })
  const { hostname, port } = new URL(server.url)

  const raw = (target: string) =>
    new Promise<string>(resolve => {
      let out = ''
      Bun.connect({
        hostname,
        port: Number(port),
        socket: {
          open(s) {
            s.write(
              `GET ${target} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nConnection: close\r\n\r\n`
            )
          },
          data(_s, d) {
            out += d.toString()
          },
          close() {
            resolve(out)
          }
        }
      })
    })

  const res = await raw('//x/secret/stats')
  expect(res).toContain(`${hostname}:${port}|//x/secret/stats`)

  await server.stop()
})

test('nodeAdapter: a Host header cannot contribute path or query to the routed URL', async () => {
  const server = nodeAdapter.serve({
    port: 0,
    fetch: request => new Response(new URL(request.url).pathname)
  })
  const { hostname, port } = new URL(server.url)

  const status = await new Promise<string>(resolve => {
    let out = ''
    Bun.connect({
      hostname,
      port: Number(port),
      socket: {
        open(s) {
          s.write(
            'GET /public HTTP/1.1\r\nHost: x/admin?\r\nConnection: close\r\n\r\n'
          )
        },
        data(_s, d) {
          out += d.toString()
        },
        close() {
          resolve(out)
        }
      }
    })
  })
  expect(status).not.toContain('/admin')
  expect(status).not.toContain('200 OK')

  await server.stop()
})

test('nodeAdapter: an upgrade with a malformed Host header is dropped and the server keeps serving', async () => {
  let reached = false
  const server = nodeAdapter.serve({
    port: 0,
    fetch: () => new Response('still up'),
    websocket: [
      {
        path: '/chat',
        handler: {
          upgrade: () => {
            reached = true
          },
          message: () => {}
        }
      }
    ]
  })
  const { hostname, port } = new URL(server.url)

  const reply = await new Promise<string>(resolve => {
    let out = ''
    Bun.connect({
      hostname,
      port: Number(port),
      socket: {
        open(s) {
          s.write(
            'GET /chat HTTP/1.1\r\nHost: x/admin?\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
          )
        },
        data(_s, d) {
          out += d.toString()
        },
        close() {
          resolve(out)
        }
      }
    })
  })

  expect(reply).not.toContain('101')
  expect(reached).toBe(false)
  expect(await (await fetch(server.url)).text()).toBe('still up')

  await server.stop()
})
