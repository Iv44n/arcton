// ── Router v1 types ─────────────────────────────────────────────────────────

export type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'DELETE'
  | 'PATCH'
  | 'HEAD'
  | 'OPTIONS'

export type RouteParams = Record<string, string>
export type QueryParams = Record<string, string>

export interface ResponseContext {
  status?: number
  headers: Headers
}

export interface Context<P extends RouteParams = RouteParams> {
  request: Request
  params: P
  query: QueryParams
  response: ResponseContext
  state: Record<string, unknown>
}

export type Body =
  | object
  | string
  | ArrayBufferView // Uint8Array, TypedArrays, DataView, Buffer (Node)
  | ArrayBuffer
  | Blob
  | FormData
  | URLSearchParams
  | ReadableStream
  | Response // escape hatch

export type RouteHandler<P extends RouteParams = RouteParams> = (
  ctx: Context<P>
) => (Body | void) | Promise<Body | void>

export type MatchResult =
  | { matched: true; handler: RouteHandler; params: RouteParams }
  | { notFound: true }
  | { methodNotAllowed: true; allowed: HttpMethod[] }

export interface Router {
  match(method: HttpMethod, url: string): MatchResult
}

// ── Middleware types ─────────────────────────────────────────────────────

export type NextFunction = () => Promise<void>

export type Middleware = (
  ctx: Context,
  next: NextFunction
) => Promise<Body | void> | Body | void

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
  /** HTTP request handler. */
  fetch: RuntimeHandler
  port: number
  hostname?: string
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
  /** Version of the underlying runtime (e.g. Bun's `Bun.version`). */
  readonly version: string
  readonly capabilities: RuntimeCapabilities
  serve(options: RuntimeServeOptions): RuntimeServer
}
