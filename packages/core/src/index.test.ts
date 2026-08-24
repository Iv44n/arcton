import { expect, test } from 'bun:test'
import { Arcton } from './index'

test('Arcton returns an app with listen()', () => {
  const app = Arcton()
  expect(typeof app.listen).toBe('function')
})

test('Arcton stores the given config', () => {
  const app = Arcton({ port: 4000 })
  expect(app.config.port).toBe(4000)
})

test('app.get/app.ws register routes served by listen()', async () => {
  const app = Arcton()

  app.get('/health', () => ({ status: 'ok' }))

  app.ws('/chat', {
    message(ws, message) {
      ws.send(message)
    }
  })

  const server = app.listen({ port: 0 })

  const res = await fetch(new URL('/health', server.url))
  expect(await res.json()).toEqual({ status: 'ok' })

  const missing = await fetch(new URL('/missing', server.url))
  expect(missing.status).toBe(404)

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
  expect(await reply).toBe('hello')

  ws.close()
  server.stop()
})

test('a handler returning a plain value is auto-mapped to JSON, a Response is passed through', async () => {
  const app = Arcton()

  app.get('/users', () => [{ id: 1 }])
  app.get(
    '/plain',
    () => new Response('hi', { headers: { 'content-type': 'text/plain' } })
  )
  app.get('/empty', () => undefined)

  const server = app.listen({ port: 0 })

  const users = await fetch(new URL('/users', server.url))
  expect(users.headers.get('content-type')).toStartWith('application/json')
  expect(await users.json()).toEqual([{ id: 1 }])

  const plain = await fetch(new URL('/plain', server.url))
  expect(plain.headers.get('content-type')).toBe('text/plain')
  expect(await plain.text()).toBe('hi')

  const empty = await fetch(new URL('/empty', server.url))
  expect(empty.status).toBe(204)

  server.stop()
})
