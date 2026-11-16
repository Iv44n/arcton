import type {
  RuntimeWebSocket,
  RuntimeWebSocketHandler
} from '@arcton/contracts'
import { HttpError } from './errors'

export interface WebSocketContext {
  readonly request: Request
}

export interface WebSocketConnection<
  Data = undefined
> extends RuntimeWebSocket {
  readonly data: Data
}

export interface WebSocketHandler<Data = undefined> {
  /**
   * Browser origins allowed to open the socket; any other gets a 403. A
   * handshake with no `Origin` header (not a browser) is not checked.
   */
  origins?: readonly string[]
  /**
   * Runs on the handshake. The returned value becomes `ws.data`; throw an
   * `Http.*` error or return a `Response` to reject the connection.
   */
  upgrade?(ctx: WebSocketContext): Data | Response | Promise<Data | Response>
  open?(ws: WebSocketConnection<Data>): void | Promise<void>
  message(
    ws: WebSocketConnection<Data>,
    message: string | ArrayBuffer
  ): void | Promise<void>
  close?(
    ws: WebSocketConnection<Data>,
    code: number,
    reason: string
  ): void | Promise<void>
  drain?(ws: WebSocketConnection<Data>): void | Promise<void>
}

// Adapters only know `upgrade(request)`: a Response rejects, anything else
// is `ws.data`. `origins` and HttpError → Response live here, once.
export function toRuntimeWebSocketHandler<Data>(
  handler: WebSocketHandler<Data>
): RuntimeWebSocketHandler {
  const { origins, upgrade } = handler
  const runtime = handler as unknown as RuntimeWebSocketHandler
  if (!origins && !upgrade) return runtime

  return Object.create(runtime, {
    upgrade: {
      async value(request: Request): Promise<unknown> {
        if (origins) {
          const origin = request.headers.get('origin')
          if (origin !== null && !origins.includes(origin)) {
            return new Response('Forbidden', { status: 403 })
          }
        }
        try {
          return await upgrade?.call(handler, { request })
        } catch (error) {
          if (error instanceof HttpError) {
            return new Response(error.message, { status: error.status })
          }
          throw error
        }
      }
    }
  })
}
