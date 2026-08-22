import { bunAdapter } from '@arcton/adapter-bun'
import type {
  RuntimeAdapter,
  RuntimeHttpMethod,
  RuntimeHttpRoute,
  RuntimeRouteHandler,
  RuntimeServer,
  RuntimeWebSocketHandler,
  RuntimeWebSocketRoute
} from '@arcton/contracts'
import figlet from 'figlet'

export interface ArctonConfig {
  port?: number
  hostname?: string
  adapter?: RuntimeAdapter
}

export interface ArctonListenOptions {
  port?: number
  hostname?: string
}

/**
 * A route handler returns a plain value — the framework maps it to a JSON
 * response. To send something else (HTML, plain text, a custom status or
 * headers), return a `Response` directly and it's used as-is.
 */
export type Handler = (request: Request) => unknown | Promise<unknown>

export interface ArctonApp {
  config: ArctonConfig
  get(path: string, handler: Handler): ArctonApp
  post(path: string, handler: Handler): ArctonApp
  put(path: string, handler: Handler): ArctonApp
  delete(path: string, handler: Handler): ArctonApp
  patch(path: string, handler: Handler): ArctonApp
  ws(path: string, handler: RuntimeWebSocketHandler): ArctonApp
  listen(options?: ArctonListenOptions): RuntimeServer
}

const notFound: RuntimeRouteHandler = () =>
  new Response('Not Found', { status: 404 })

function toRouteHandler(handler: Handler): RuntimeRouteHandler {
  return async request => {
    const result = await handler(request)
    if (result instanceof Response) return result
    if (result === undefined) return new Response(null, { status: 204 })
    return Response.json(result)
  }
}

export function createApp(config: ArctonConfig = {}): ArctonApp {
  const adapter = config.adapter ?? bunAdapter
  const routes: RuntimeHttpRoute[] = []
  const websocketRoutes: RuntimeWebSocketRoute[] = []

  function route(method: RuntimeHttpMethod, path: string, handler: Handler) {
    routes.push({ method, path, handler: toRouteHandler(handler) })
    return app
  }

  const app: ArctonApp = {
    config,
    get: (path, handler) => route('GET', path, handler),
    post: (path, handler) => route('POST', path, handler),
    put: (path, handler) => route('PUT', path, handler),
    delete: (path, handler) => route('DELETE', path, handler),
    patch: (path, handler) => route('PATCH', path, handler),
    ws(path: string, handler: RuntimeWebSocketHandler) {
      if (!adapter.capabilities.websocket) {
        throw new Error(
          `Runtime "${adapter.name}" does not support WebSocket routes.`
        )
      }

      websocketRoutes.push({ path, handler })
      return app
    },
    listen(options = {}) {
      console.log(figlet.textSync('Arcton'))
      return adapter.serve({
        port: options.port ?? config.port ?? 3000,
        hostname: options.hostname ?? config.hostname,
        routes,
        websocket: websocketRoutes,
        fetch: notFound
      })
    }
  }

  return app
}
