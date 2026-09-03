import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { Readable } from 'node:stream'
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

// GET/HEAD can't carry a body — the Request constructor throws if one is passed.
function toWebRequest(req: IncomingMessage, fallbackHost: string): Request {
  const host = req.headers.host ?? fallbackHost
  const url = new URL(req.url ?? '/', `http://${host}`)
  const method = req.method ?? 'GET'
  const hasBody = method !== 'GET' && method !== 'HEAD'

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

function toRuntimeWebSocket(ws: WsWebSocket): RuntimeWebSocket {
  return {
    data: undefined,
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

    server.on('upgrade', (req, socket, head) => {
      const host = req.headers.host ?? `localhost:${options.port}`
      const pathname = new URL(req.url ?? '/', `http://${host}`).pathname
      const handler = wsRoutes.get(pathname)
      if (!handler) {
        socket.destroy()
        return
      }

      wss.handleUpgrade(req, socket, head, ws => {
        handler.open?.(toRuntimeWebSocket(ws))
        ws.on('message', (data, isBinary) =>
          handler.message(toRuntimeWebSocket(ws), toMessage(data, isBinary))
        )
        ws.on('close', (code, reason) =>
          handler.close?.(toRuntimeWebSocket(ws), code, reason.toString())
        )
        ws.on('drain', () => handler.drain?.(toRuntimeWebSocket(ws)))
      })
    })

    server.listen(options.port, options.hostname)

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
        return new Promise<void>((resolve, reject) => {
          if (closeActiveConnections) {
            for (const client of wss.clients) client.terminate()
            server.closeAllConnections()
          }
          server.close(error => (error ? reject(error) : resolve()))
        })
      }
    }
  }
}
