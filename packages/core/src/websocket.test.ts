import { expect, test } from 'bun:test'
import { Arcton, Http } from './index'
import { toRuntimeWebSocketHandler, type WebSocketHandler } from './websocket'

const noop = () => {}

function handshake(origin?: string): Request {
  return new Request('http://localhost/room', {
    headers: origin === undefined ? {} : { origin }
  })
}

async function runUpgrade(
  handler: WebSocketHandler<unknown>,
  request: Request
): Promise<unknown> {
  const runtime = toRuntimeWebSocketHandler(handler)
  return runtime.upgrade?.(request)
}

test('a handler with neither origins nor upgrade is passed through untouched', () => {
  const handler = { message: noop }
  expect(toRuntimeWebSocketHandler(handler)).toBe(
    handler as ReturnType<typeof toRuntimeWebSocketHandler>
  )
})

test('upgrade receives ctx.request and its return value is what the adapter stores as ws.data', async () => {
  const request = handshake()
  const result = await runUpgrade(
    { upgrade: ctx => ({ same: ctx.request === request }), message: noop },
    request
  )
  expect(result).toEqual({ same: true })
})

test('an Http error thrown in upgrade becomes a Response with that status', async () => {
  const result = await runUpgrade(
    {
      upgrade: () => {
        throw Http.Unauthorized()
      },
      message: noop
    },
    handshake()
  )
  expect(result).toBeInstanceOf(Response)
  expect((result as Response).status).toBe(401)
})

test('a Response returned from upgrade is passed through as the rejection', async () => {
  const rejection = new Response('nope', { status: 418 })
  const result = await runUpgrade(
    { upgrade: () => rejection, message: noop },
    handshake()
  )
  expect(result).toBe(rejection)
})

test('any other error thrown in upgrade is rethrown for the adapter to turn into a 500', async () => {
  await expect(
    runUpgrade(
      {
        upgrade: () => {
          throw new Error('boom')
        },
        message: noop
      },
      handshake()
    )
  ).rejects.toThrow('boom')
})

test('origins: a listed origin is accepted, any other gets a 403 and never reaches upgrade', async () => {
  let reached = false
  const handler: WebSocketHandler<unknown> = {
    origins: ['https://app.example.com'],
    upgrade: () => {
      reached = true
      return 'ok'
    },
    message: noop
  }

  expect(await runUpgrade(handler, handshake('https://app.example.com'))).toBe(
    'ok'
  )

  reached = false
  const rejected = await runUpgrade(handler, handshake('https://evil.example'))
  expect((rejected as Response).status).toBe(403)
  expect(reached).toBe(false)
})

test('origins: a handshake with no Origin header (not a browser) is not rejected', async () => {
  const result = await runUpgrade(
    { origins: ['https://app.example.com'], message: noop },
    handshake()
  )
  expect(result).toBeUndefined()
})

test('origins without an upgrade hook still accept a listed origin', async () => {
  const result = await runUpgrade(
    { origins: ['https://a.example'], message: noop },
    handshake('https://a.example')
  )
  expect(result).toBeUndefined()
})

test('end to end on the default adapter: upgrade data reaches ws.data and a thrown Http error is a real 401', async () => {
  const seen: unknown[] = []
  const app = Arcton()
    .ws('/ok', {
      upgrade: () => ({ user: 'u1' }),
      open: ws => {
        seen.push(ws.data)
      },
      message: noop
    })
    .ws('/denied', {
      upgrade: () => {
        throw Http.Unauthorized()
      },
      message: noop
    })
  const server = app.listen({ port: 0 })

  const wsUrl = new URL('/ok', server.url)
  wsUrl.protocol = 'ws:'
  const socket = new WebSocket(wsUrl)
  await new Promise<void>(resolve =>
    socket.addEventListener('open', () => resolve())
  )
  expect(seen).toEqual([{ user: 'u1' }])
  socket.close()

  const denied = await fetch(new URL('/denied', server.url), {
    headers: {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ=='
    }
  })
  expect(denied.status).toBe(401)

  await server.stop()
})
