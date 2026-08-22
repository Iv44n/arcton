export type RuntimeHttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'DELETE'
  | 'PATCH'
  | 'HEAD'
  | 'OPTIONS'

/** A single HTTP route handler. Always answers — it never upgrades the connection. */
export type RuntimeRouteHandler = (
  request: Request
) => Response | Promise<Response>

export interface RuntimeHttpRoute {
  method: RuntimeHttpMethod
  path: string
  handler: RuntimeRouteHandler
}

export interface RuntimeWebSocket {
  readonly data: unknown
  send(message: string | ArrayBuffer | ArrayBufferView): void
  close(code?: number, reason?: string): void
}

export interface RuntimeWebSocketHandler {
  message(
    ws: RuntimeWebSocket,
    message: string | ArrayBuffer
  ): void | Promise<void>
  open?(ws: RuntimeWebSocket): void | Promise<void>
  close?(
    ws: RuntimeWebSocket,
    code: number,
    reason: string
  ): void | Promise<void>
  drain?(ws: RuntimeWebSocket): void | Promise<void>
}

export interface RuntimeWebSocketRoute {
  path: string
  handler: RuntimeWebSocketHandler
}

export interface RuntimeUpgradeOptions {
  data?: unknown
  headers?: Record<string, string>
}

export interface RuntimeRequestContext {
  /**
   * Low-level WebSocket upgrade primitive.
   *
   * Routes in `RuntimeServeOptions.websocket` are upgraded automatically —
   * this exists for the `fetch` fallback handler, for upgrades that can't
   * be expressed as a static route (e.g. conditional on auth). Only usable
   * when {@link RuntimeAdapter.capabilities}'s `websocket` is `true`. On
   * success, the handler must not return a `Response`.
   *
   * @returns `true` if the upgrade succeeded, `false` otherwise — the
   * handler should return an error `Response` in that case.
   */
  upgrade(request: Request, options?: RuntimeUpgradeOptions): boolean
}

export type RuntimeHandler = (
  request: Request,
  context: RuntimeRequestContext
) => Response | undefined | Promise<Response | undefined>

export interface RuntimeServeOptions {
  /** Fallback handler for requests that don't match a route in {@link routes}. */
  fetch: RuntimeHandler
  port: number
  hostname?: string
  /** Static HTTP routes, matched before falling back to {@link fetch}. */
  routes?: RuntimeHttpRoute[]
  /**
   * WebSocket routes.
   *
   * Requires the underlying runtime to expose a raw socket-upgrade API.
   * Today that's only Bun and Node.js — always check
   * {@link RuntimeAdapter.capabilities}'s `websocket` before registering any.
   */
  websocket?: RuntimeWebSocketRoute[]
}

export interface RuntimeServer {
  readonly port: number
  readonly url: URL
  stop(closeActiveConnections?: boolean): void | Promise<void>
}

export interface RuntimeCapabilities {
  /** Whether the adapter supports `RuntimeServeOptions.websocket` routes. */
  readonly websocket: boolean
}

export interface RuntimeAdapter {
  readonly name: string
  readonly capabilities: RuntimeCapabilities
  serve(options: RuntimeServeOptions): RuntimeServer
}
