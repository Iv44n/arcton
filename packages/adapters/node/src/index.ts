import {
  createServer,
  type IncomingMessage,
  STATUS_CODES,
  type ServerResponse
} from 'node:http'
import { Readable, type Duplex } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type {
  RuntimeAdapter,
  RuntimeRequestContext,
  RuntimeServeOptions,
  RuntimeServer,
  RuntimeWebSocket,
  RuntimeWebSocketHandler
} from '@arcton/contracts'
import {
  type RawData,
  WebSocketServer,
  type WebSocket as WsWebSocket
} from 'ws'

function toWebHeaders(raw: IncomingMessage['headers']): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v)
    } else {
      headers.append(key, value)
    }
  }
  return headers
}

function announcesBody(req: IncomingMessage): boolean {
  return (
    req.headers['transfer-encoding'] !== undefined ||
    Number(req.headers['content-length']) > 0
  )
}

// GET/HEAD can't carry a body — the Request constructor throws if one is
// passed. Any other method only gets one if the request announces it, so an
// absent body is `null` here just as it is on Bun.
// Only path and query are taken from the request-target — resolving it
// against a base with `new URL(target, base)` would read `//x/path` as
// authority `x` and drop the first segment.
const AUTHORITY = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d+)?$/

function toRequestUrl(req: IncomingMessage, fallbackHost: string): URL {
  const host = req.headers.host ?? fallbackHost
  if (!AUTHORITY.test(host)) throw new Error('Invalid Host header')
  const target = req.url ?? '/'
  return new URL(`http://${host}${target.startsWith('/') ? '' : '/'}${target}`)
}

function toWebRequest(req: IncomingMessage, fallbackHost: string): Request {
  const url = toRequestUrl(req, fallbackHost)
  const method = req.method ?? 'GET'
  const hasBody = method !== 'GET' && method !== 'HEAD' && announcesBody(req)

  return new Request(url.toString(), {
    method,
    headers: toWebHeaders(req.headers),
    ...(hasBody
      ? { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' }
      : {})
  } as RequestInit)
}

// Set-Cookie can't be comma-joined like other repeated headers, so it's handled separately.
function writeWebHeaders(headers: Headers, res: ServerResponse): void {
  for (const [key, value] of headers) {
    if (key.toLowerCase() === 'set-cookie') continue
    res.setHeader(key, value)
  }
  const cookies = headers.getSetCookie()
  if (cookies.length > 0) res.setHeader('Set-Cookie', cookies)
}

async function sendWebResponse(
  response: Response,
  res: ServerResponse
): Promise<void> {
  res.statusCode = response.status
  writeWebHeaders(response.headers, res)

  if (response.body === null) {
    res.end()
    return
  }

  await pipeline(Readable.fromWeb(response.body), res)
}

// `ws` hands back Buffers + isBinary, not a string for text frames like Bun does.
function toMessage(data: RawData, isBinary: boolean): string | ArrayBuffer {
  const buffer = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data)
  if (!isBinary) return buffer.toString('utf8')
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer
}

// The 'upgrade' event hands over a raw socket, so a rejection is written as
// a plain HTTP/1.1 response by hand.
async function rejectUpgrade(socket: Duplex, response: Response) {
  try {
    const body = Buffer.from(await response.arrayBuffer())
    const reason = response.statusText || STATUS_CODES[response.status] || ''
    const lines = [`HTTP/1.1 ${response.status} ${reason}`]
    for (const [key, value] of response.headers) {
      if (
        /^(set-cookie|content-length|connection|transfer-encoding)$/i.test(key)
      )
        continue
      lines.push(`${key}: ${value}`)
    }
    for (const cookie of response.headers.getSetCookie()) {
      lines.push(`set-cookie: ${cookie}`)
    }
    lines.push(`content-length: ${body.length}`, 'connection: close', '', '')
    socket.end(Buffer.concat([Buffer.from(lines.join('\r\n')), body]))
  } catch {
    socket.destroy()
  }
}

function toRuntimeWebSocket(ws: WsWebSocket, data: unknown): RuntimeWebSocket {
  return {
    data,
    send: message => {
      ws.send(message)
    },
    close: (code, reason) => ws.close(code, reason)
  }
}

export const nodeAdapter: RuntimeAdapter = {
  name: 'node',
  // Bare, no leading "v" — matches Bun.version's format.
  get version() {
    return process.version.slice(1)
  },
  capabilities: { websocket: true },
  serve(options: RuntimeServeOptions): RuntimeServer {
    const wsRoutes = new Map<string, RuntimeWebSocketHandler>()
    for (const route of options.websocket ?? []) {
      wsRoutes.set(route.path, route.handler)
    }

    const wss = new WebSocketServer({ noServer: true })

    const server = createServer(async (req, res) => {
      try {
        const request = toWebRequest(req, `localhost:${options.port}`)
        const context: RuntimeRequestContext = {
          // Unreachable here — Node routes Upgrade requests to 'upgrade', not 'request'.
          upgrade: () => false
        }
        const response = await options.fetch(request, context)
        if (!response) {
          res.statusCode = 404
          res.end()
          return
        }
        await sendWebResponse(response, res)
      } catch (error) {
        console.error(error)
        if (!res.headersSent) res.statusCode = 500
        res.end('Internal Server Error')
      }
    })

    server.on('upgrade', async (req, socket, head) => {
      // No listener yet would turn a socket error during the async upgrade()
      // into an uncaught exception; ws adds its own once it takes over.
      socket.on('error', () => socket.destroy())

      let request: Request
      try {
        request = toWebRequest(req, `localhost:${options.port}`)
      } catch {
        socket.destroy()
        return
      }
      const handler = wsRoutes.get(new URL(request.url).pathname)
      if (!handler) {
        socket.destroy()
        return
      }

      let data: unknown
      if (handler.upgrade) {
        try {
          data = await handler.upgrade(request)
        } catch (error) {
          console.error(error)
          await rejectUpgrade(
            socket,
            new Response('Internal Server Error', { status: 500 })
          )
          return
        }
        if (data instanceof Response) {
          await rejectUpgrade(socket, data)
          return
        }
      }

      wss.handleUpgrade(req, socket, head, ws => {
        handler.open?.(toRuntimeWebSocket(ws, data))
        ws.on('message', (message, isBinary) =>
          handler.message(
            toRuntimeWebSocket(ws, data),
            toMessage(message, isBinary)
          )
        )
        ws.on('close', (code, reason) =>
          handler.close?.(toRuntimeWebSocket(ws, data), code, reason.toString())
        )
        ws.on('drain', () => handler.drain?.(toRuntimeWebSocket(ws, data)))
      })
    })

    server.listen(options.port, options.hostname)

    // Memoized on the first call — `server.close()` rejects with
    // ERR_SERVER_NOT_RUNNING if the server is already closed, and an
    // unhandled rejection from a second, uncaught `stop()` call crashes the
    // whole Node process (default `--unhandled-rejections=throw` since
    // Node 15). Returning the same settled promise to every caller makes a
    // repeated `stop()` a safe no-op instead, matching the Bun adapter.
    let stopped: Promise<void> | undefined

    return {
      get port() {
        const address = server.address()
        return typeof address === 'object' && address
          ? address.port
          : options.port
      },
      get url() {
        const address = server.address()
        const port =
          typeof address === 'object' && address ? address.port : options.port
        return new URL(`http://${options.hostname ?? 'localhost'}:${port}/`)
      },
      stop(closeActiveConnections) {
        if (stopped) return stopped
        stopped = new Promise<void>((resolve, reject) => {
          if (closeActiveConnections) {
            for (const client of wss.clients) client.terminate()
            server.closeAllConnections()
          }
          server.close(error => (error ? reject(error) : resolve()))
        })
        return stopped
      }
    }
  }
}
