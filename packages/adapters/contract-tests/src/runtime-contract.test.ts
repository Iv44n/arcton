// Runs the same assertions against every RuntimeAdapter, so a behavioral
// divergence between adapters (like the double-stop() crash this repo once
// had, Node-only) gets caught by CI instead of by someone reading two
// separate test files and noticing they don't quite match.
//
// A genuine, intentional difference between adapters is still asserted
// explicitly (see "KNOWN ADAPTER DIFFERENCE" below) — the point isn't to
// force identical behavior everywhere, it's to make every divergence a
// conscious, visible decision instead of an accident.

import { expect, test } from 'bun:test'
import { bunAdapter } from '@arcton/adapter-bun'
import { nodeAdapter } from '@arcton/adapter-node'
import type { RuntimeAdapter } from '@arcton/contracts'

const adapters: { name: string; adapter: RuntimeAdapter }[] = [
  { name: 'bun', adapter: bunAdapter },
  { name: 'node', adapter: nodeAdapter }
]

for (const { name, adapter } of adapters) {
  test(`${name}: serves the fetch handler, exposes a populated url/port`, async () => {
    const server = adapter.serve({
      port: 0,
      fetch: request => new Response(`hello ${new URL(request.url).pathname}`)
    })

    expect(server.port).toBeGreaterThan(0)
    expect(server.url).toBeInstanceOf(URL)

    const res = await fetch(new URL('/x', server.url))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello /x')

    await server.stop()
  })

  test(`${name}: an uncaught exception from fetch becomes a 500, not a crash`, async () => {
    const server = adapter.serve({
      port: 0,
      fetch: () => {
        throw new Error('contract-test boom')
      }
    })

    const res = await fetch(server.url)
    expect(res.status).toBe(500)

    await server.stop()
  })

  test(`${name}: stop() is idempotent — sequential double-stop resolves both times`, async () => {
    const server = adapter.serve({ port: 0, fetch: () => new Response('ok') })

    await server.stop()
    await expect(server.stop()).resolves.toBeUndefined()
  })

  test(`${name}: stop() is idempotent — concurrent double-stop resolves both times`, async () => {
    const server = adapter.serve({ port: 0, fetch: () => new Response('ok') })

    await expect(Promise.all([server.stop(), server.stop()])).resolves.toEqual([
      undefined,
      undefined
    ])
  })

  test(`${name}: a registered ws route auto-upgrades and exchanges messages`, async () => {
    const server = adapter.serve({
      port: 0,
      fetch: () => new Response('not found', { status: 404 }),
      websocket: [
        {
          path: '/chat',
          handler: {
            message: (ws, message) => ws.send(`echo:${message}`)
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
    ws.send('hi')
    expect(await reply).toBe('echo:hi')

    ws.close()
    await server.stop()
  })

  test(`${name}: RuntimeWebSocket.data is undefined for a statically-registered ws route`, async () => {
    let observedData: unknown = 'not-observed'

    const server = adapter.serve({
      port: 0,
      fetch: () => new Response('not found', { status: 404 }),
      websocket: [
        {
          path: '/chat',
          handler: {
            open: ws => {
              observedData = ws.data
            },
            message: () => {}
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

    expect(observedData).toBeUndefined()

    ws.close()
    await server.stop()
  })
}

// ── KNOWN ADAPTER DIFFERENCE ─────────────────────────────────────────────
//
// RuntimeRequestContext.upgrade() — the ad-hoc, conditional-upgrade
// primitive passed to `fetch` — behaves differently per adapter. Bun can
// actually complete the upgrade for a path with a registered ws route; the
// Node adapter's implementation is a hardcoded `() => false` stub, because
// Node routes upgrade requests through the 'upgrade' server event, not
// through the request handler at all. Asserted explicitly, in both
// directions, so a future change to either adapter has to update this test
// on purpose instead of silently changing the contract.

test('KNOWN ADAPTER DIFFERENCE: context.upgrade() succeeds on Bun for a registered ws route', async () => {
  const server = bunAdapter.serve({
    port: 0,
    fetch: (request, context) => {
      const upgraded = context.upgrade(request)
      return upgraded
        ? undefined
        : new Response('upgrade failed', { status: 400 })
    },
    websocket: [{ path: '/chat', handler: { message: () => {} } }]
  })

  const wsUrl = new URL('/chat', server.url)
  wsUrl.protocol = 'ws:'
  const ws = new WebSocket(wsUrl)
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error('ws failed to open')))
  })

  await expect(opened).resolves.toBeUndefined()

  ws.close()
  await server.stop()
})

test('KNOWN ADAPTER DIFFERENCE: context.upgrade() always returns false on Node, even for a registered ws route', async () => {
  const server = nodeAdapter.serve({
    port: 0,
    fetch: (request, context) => {
      const upgraded = context.upgrade(request)
      return new Response(JSON.stringify({ upgraded }), {
        headers: { 'content-type': 'application/json' }
      })
    },
    websocket: [{ path: '/chat', handler: { message: () => {} } }]
  })

  const res = await fetch(new URL('/chat', server.url))
  expect(await res.json()).toEqual({ upgraded: false })

  await server.stop()
})
