import { expect, test } from 'bun:test'
import { Arcton } from './index'

// Real server, real Content-Length framing — index.test.ts covers the same
// limits through a fake adapter.
test('end to end on the default adapter: a route limit above the global one is honored, and the rest stay capped', async () => {
  const app = Arcton()
    .post('/upload', {
      maxBodySize: 4096,
      handler: async ctx => ({
        bytes: (await ctx.request.arrayBuffer()).byteLength
      })
    })
    .post('/small', async ctx => ({ bytes: (await ctx.request.text()).length }))
  const server = app.listen({
    port: 0,
    maxBodySize: 64,
    gracefulShutdown: false
  })

  const post = (path: string, size: number) =>
    fetch(new URL(path, server.url), { method: 'POST', body: 'x'.repeat(size) })

  expect((await post('/upload', 2048)).status).toBe(200)
  expect((await post('/upload', 8192)).status).toBe(413)
  expect((await post('/small', 32)).status).toBe(200)
  expect((await post('/small', 2048)).status).toBe(413)

  await server.stop()
})

test('end to end: a chunked body over the route limit is a 413, not a 500 or 400', async () => {
  const app = Arcton().post('/json', {
    maxBodySize: 64,
    handler: async ctx => ctx.request.json()
  })
  const server = app.listen({ port: 0, gracefulShutdown: false })

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`{"a":"${'x'.repeat(200)}"}`))
      controller.close()
    }
  })
  const res = await fetch(new URL('/json', server.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    duplex: 'half'
  } as RequestInit)
  expect(res.status).toBe(413)

  await server.stop()
})
