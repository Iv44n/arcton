import type {
  RuntimeAdapter,
  RuntimeRequestContext,
  RuntimeServeOptions,
  RuntimeServer,
  RuntimeWebSocket,
  RuntimeWebSocketHandler
} from '@arcton/contracts'

interface WsConnectionData {
  handler: RuntimeWebSocketHandler
  data: unknown
}

function toRuntimeWebSocket(
  ws: Bun.ServerWebSocket<WsConnectionData>
): RuntimeWebSocket {
  return {
    data: ws.data.data,
    send: message => {
      ws.send(message as Parameters<typeof ws.send>[0])
    },
    close: (code, reason) => ws.close(code, reason)
  }
}

function toArrayBuffer(message: string | Buffer): string | ArrayBuffer {
  if (typeof message === 'string') return message
  return message.buffer.slice(
    message.byteOffset,
    message.byteOffset + message.byteLength
  ) as ArrayBuffer
}

const bunWebSocketHandler: Bun.WebSocketHandler<WsConnectionData> = {
  message: (ws, message) =>
    ws.data.handler.message(toRuntimeWebSocket(ws), toArrayBuffer(message)),
  open: ws => ws.data.handler.open?.(toRuntimeWebSocket(ws)),
  close: (ws, code, reason) =>
    ws.data.handler.close?.(toRuntimeWebSocket(ws), code, reason),
  drain: ws => ws.data.handler.drain?.(toRuntimeWebSocket(ws))
}

export const bunAdapter: RuntimeAdapter = {
  name: 'bun',
  version: Bun.version,
  capabilities: { websocket: true },
  serve(options: RuntimeServeOptions): RuntimeServer {
    const wsRoutes = new Map<string, RuntimeWebSocketHandler>()
    for (const route of options.websocket ?? []) {
      wsRoutes.set(route.path, route.handler)
    }

    const handleRequest = (
      request: Request,
      bunServer: Bun.Server<WsConnectionData>
    ) => {
      // A fixed base guards against a relative request.url — Bun's own
      // requests are always absolute, but this keeps the adapter as
      // defensive about it as the router's own URL parsing.
      const pathname = new URL(request.url, 'http://localhost').pathname

      const context: RuntimeRequestContext = {
        upgrade: (req, upgradeOptions) => {
          const handler = wsRoutes.get(
            new URL(req.url, 'http://localhost').pathname
          )
          if (!handler) return false

          return bunServer.upgrade(req, {
            headers: upgradeOptions?.headers,
            data: { handler, data: upgradeOptions?.data }
          })
        }
      }

      const wsHandler = wsRoutes.get(pathname)
      if (wsHandler) {
        return context.upgrade(request)
          ? undefined
          : new Response('Upgrade failed', { status: 400 })
      }

      return options.fetch(request, context)
    }

    const server =
      wsRoutes.size > 0
        ? Bun.serve<WsConnectionData>({
            port: options.port,
            hostname: options.hostname,
            fetch: handleRequest,
            websocket: bunWebSocketHandler,
            error(error) {
              console.error(error)
              return new Response('Internal Server Error', { status: 500 })
            }
          })
        : Bun.serve({
            port: options.port,
            hostname: options.hostname,
            fetch: handleRequest as (
              request: Request
            ) => Response | Promise<Response>,
            error(error) {
              console.error(error)
              return new Response('Internal Server Error', { status: 500 })
            }
          })

    return {
      get port() {
        // undefined only applies to Bun's unix-socket mode, which this adapter never uses
        return server.port ?? options.port
      },
      get url() {
        return server.url
      },
      stop(closeActiveConnections) {
        return server.stop(closeActiveConnections)
      }
    }
  }
}
