import { bunAdapter } from '@arcton/adapter-bun'
import type {
  Context,
  HttpMethod,
  Middleware,
  RouteHandler,
  RuntimeAdapter,
  RuntimeServer,
  RuntimeWebSocketHandler,
  RuntimeWebSocketRoute
} from '@arcton/contracts'
import figlet from 'figlet'
import pkg from '../package.json' with { type: 'json' }
import { compose } from './middleware/compose'
import { createRouter } from './router/router'
import { mapResponse } from './router/serialize'
import type { ExtractParams } from './router/types'

export interface ArctonConfig {
  port?: number
  hostname?: string
  adapter?: RuntimeAdapter
  /** Defaults to `process.env.NODE_ENV`, falling back to `'development'`. */
  env?: string
}

export interface ArctonListenOptions {
  port?: number
  hostname?: string
}

const banner = figlet.textSync('Arcton')

// One generic signature per method: `Route` infers as the
// literal passed for `path`, and `ctx.params` comes back typed via
// `ExtractParams<Route>` (e.g. `{ id: string }`). A non-literal `path`
// (built at runtime, held in a `string` variable) makes `Route` infer as
// the wide `string` type itself — `ExtractParams` special-cases that back
// to plain `Record<string, string>` (see types.ts), so there's no need for
// a second, non-generic overload here: TS's overload resolution always
// picks the first matching signature, and a second `(path: string, ...)`
// overload would in fact never be reached (the generic one above already
// matches every `string` argument), so it'd be dead code, not a fallback.
export interface ArctonApp {
  config: ArctonConfig
  get<Route extends string>(
    path: Route,
    handler: RouteHandler<ExtractParams<Route>>
  ): ArctonApp
  post<Route extends string>(
    path: Route,
    handler: RouteHandler<ExtractParams<Route>>
  ): ArctonApp
  put<Route extends string>(
    path: Route,
    handler: RouteHandler<ExtractParams<Route>>
  ): ArctonApp
  delete<Route extends string>(
    path: Route,
    handler: RouteHandler<ExtractParams<Route>>
  ): ArctonApp
  patch<Route extends string>(
    path: Route,
    handler: RouteHandler<ExtractParams<Route>>
  ): ArctonApp
  head<Route extends string>(
    path: Route,
    handler: RouteHandler<ExtractParams<Route>>
  ): ArctonApp
  options<Route extends string>(
    path: Route,
    handler: RouteHandler<ExtractParams<Route>>
  ): ArctonApp
  ws(path: string, handler: RuntimeWebSocketHandler): ArctonApp
  use(middleware: Middleware): ArctonApp
  listen(options?: ArctonListenOptions): RuntimeServer
}

export function Arcton(config: ArctonConfig = {}): ArctonApp {
  const adapter = config.adapter ?? bunAdapter
  const environment = config.env ?? process.env.NODE_ENV ?? 'development'
  const router = createRouter()
  const websocketRoutes: RuntimeWebSocketRoute[] = []
  const middleware: Middleware[] = []

  // `handler` typechecks as `RouteHandler<ExtractParams<Route>>` (specific
  // to whatever literal each call site passed), but the tree stores plain
  // `RouteHandler`s — it matches by string, oblivious to which literal
  // route a handler came from. The cast is the seam between the two: sound
  // because `router.insert`'s own `path` (unwidened, same `Route`) is what
  // makes `match()` hand that handler back `params` shaped exactly like
  // `ExtractParams<Route>`, just erased to `Record<string, string>` on the
  // way through the tree. TS can't see that coupling through the generic
  // `Route`, so it can't verify it — verified instead by the type tests in
  // router/types.test-d.ts.
  function route<Route extends string>(
    method: HttpMethod,
    path: Route,
    handler: RouteHandler<ExtractParams<Route>>
  ): ArctonApp {
    router.insert(method, path, handler as RouteHandler)
    return app
  }

  const app: ArctonApp = {
    config,
    get<Route extends string>(
      path: Route,
      handler: RouteHandler<ExtractParams<Route>>
    ) {
      return route('GET', path, handler)
    },
    post<Route extends string>(
      path: Route,
      handler: RouteHandler<ExtractParams<Route>>
    ) {
      return route('POST', path, handler)
    },
    put<Route extends string>(
      path: Route,
      handler: RouteHandler<ExtractParams<Route>>
    ) {
      return route('PUT', path, handler)
    },
    delete<Route extends string>(
      path: Route,
      handler: RouteHandler<ExtractParams<Route>>
    ) {
      return route('DELETE', path, handler)
    },
    patch<Route extends string>(
      path: Route,
      handler: RouteHandler<ExtractParams<Route>>
    ) {
      return route('PATCH', path, handler)
    },
    head<Route extends string>(
      path: Route,
      handler: RouteHandler<ExtractParams<Route>>
    ) {
      return route('HEAD', path, handler)
    },
    options<Route extends string>(
      path: Route,
      handler: RouteHandler<ExtractParams<Route>>
    ) {
      return route('OPTIONS', path, handler)
    },
    ws(path: string, handler: RuntimeWebSocketHandler) {
      if (!adapter.capabilities.websocket) {
        throw new Error(
          `Runtime "${adapter.name}" does not support WebSocket routes.`
        )
      }

      websocketRoutes.push({ path, handler })
      return app
    },
    use(mw: Middleware) {
      middleware.push(mw)
      return app
    },
    listen(options = {}) {
      const server = adapter.serve({
        port: options.port ?? config.port ?? 3000,
        hostname: options.hostname ?? config.hostname,
        websocket: websocketRoutes,
        async fetch(request) {
          const method = request.method as HttpMethod
          // Parsed once and reused for both matching (pathname) and query
          // (searchParams) — router.matchPathname skips the URL parse
          // router.match does internally, since we already have one here.
          const url = new URL(request.url, 'http://localhost')
          const result = router.matchPathname(method, url.pathname)

          if ('notFound' in result) {
            return new Response(null, { status: 404 })
          }

          if ('methodNotAllowed' in result) {
            return new Response(null, {
              status: 405,
              headers: { Allow: result.allowed.join(', ') }
            })
          }

          const ctx: Context = {
            request,
            params: result.params,
            query: Object.fromEntries(url.searchParams),
            response: { headers: new Headers() },
            state: {}
          }

          const body = await compose(middleware, result.handler, ctx)
          return mapResponse(body, ctx.response)
        }
      })

      console.log(banner)
      console.log(`  Arcton       v${pkg.version}`)
      console.log(`  Runtime      ${adapter.name} v${adapter.version}`)
      console.log(`  Environment  ${environment}`)
      console.log(`  Listening    ${server.url}`)
      console.log()

      return server
    }
  }

  return app
}
