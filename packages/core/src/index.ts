import { bunAdapter } from '@arcton/adapter-bun'
import type {
  Context,
  HttpMethod,
  Middleware,
  ProvideFn,
  QueryParams,
  ReservedKeys,
  RouteHandler,
  RouteParams,
  RuntimeAdapter,
  RuntimeServer,
  RuntimeWebSocketHandler,
  RuntimeWebSocketRoute,
  StandardSchemaV1
} from '@arcton/contracts'
import figlet from 'figlet'
import pkg from '../package.json' with { type: 'json' }
import { runPipeline, type Step } from './middleware/pipeline'
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

// `Route` infers as the literal passed for `path`, so `ctx.params` comes
// back typed via `ExtractParams<Route>` (e.g. `{ id: string }`). `TProvided`
// flows through so route-level middleware and the handler see whatever's
// been provided so far, flat on `ctx` (no `ctx.state` namespace).
//
// Two call shapes, disambiguated by the second argument's runtime type
// (see isRouteOptions below): a function starts the middleware+handler
// variadic tuple (trailing handler makes middleware optional); a plain
// object is a RouteOptions — params/query/body schemas (a Standard Schema,
// https://standardschema.dev/) plus middleware/handler, for request
// validation beyond what `ExtractParams<Route>` gives for free.
//
// Shared by all seven HTTP-method shorthands (`get`/`post`/...) — they're
// identical other than the method name itself.
interface RouteMethod<TProvided> {
  <Route extends string>(
    path: Route,
    ...args: [
      ...Middleware<ExtractParams<Route>, QueryParams, {}, TProvided>[],
      RouteHandler<ExtractParams<Route>, QueryParams, {}, TProvided>
    ]
  ): ArctonApp<TProvided>
  <
    Route extends string,
    PSchema extends StandardSchemaV1 | undefined = undefined,
    QSchema extends StandardSchemaV1 | undefined = undefined,
    BSchema extends StandardSchemaV1 | undefined = undefined
  >(
    path: Route,
    options: RouteOptions<Route, TProvided, PSchema, QSchema, BSchema>
  ): ArctonApp<TProvided>
}

export interface ArctonApp<TProvided = {}> {
  config: ArctonConfig
  get: RouteMethod<TProvided>
  post: RouteMethod<TProvided>
  put: RouteMethod<TProvided>
  delete: RouteMethod<TProvided>
  patch: RouteMethod<TProvided>
  head: RouteMethod<TProvided>
  options: RouteMethod<TProvided>
  ws(path: string, handler: RuntimeWebSocketHandler): ArctonApp<TProvided>
  /** Global middleware — composes behavior. Doesn't grow `TProvided`; see `provide()`. */
  use(
    middleware: Middleware<RouteParams, QueryParams, {}, TProvided>
  ): ArctonApp<TProvided>
  /**
   * Composes typed context — adds `R` flat onto `ctx` for every
   * middleware/handler registered after this call. Rejects re-providing a
   * key that's already on `TProvided` or on the base `Context` fields
   * (`request`/`params`/`query`/`response`) or a key already provided.
   */
  provide<
    R extends Partial<Record<ReservedKeys<TProvided>, never>> &
      Record<string, unknown>
  >(fn: ProvideFn<TProvided, R>): ArctonApp<TProvided & R>
  listen(options?: ArctonListenOptions): RuntimeServer
}

// ── RouteOptions field types ─────────────────────────────────────────────

// params/query fall back to the defaults (ExtractParams<Route>, QueryParams)
// when no schema is given; with one, the schema's Output wins — coerced/
// transformed, never the raw pre-validation value.
type ParamsFor<
  Route extends string,
  PSchema extends StandardSchemaV1 | undefined
> = PSchema extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<PSchema>
  : ExtractParams<Route>

type QueryFor<QSchema extends StandardSchemaV1 | undefined> =
  QSchema extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<QSchema>
    : QueryParams

// {} (no `body` key at all) unless a body schema is declared, not a fixed
// field defaulting to undefined — accessing ctx.body without a schema is a
// compile error.
type BodyFor<BSchema extends StandardSchemaV1 | undefined> =
  BSchema extends StandardSchemaV1
    ? { body: StandardSchemaV1.InferOutput<BSchema> }
    : {}

export interface RouteOptions<
  Route extends string,
  TProvided,
  PSchema extends StandardSchemaV1 | undefined = undefined,
  QSchema extends StandardSchemaV1 | undefined = undefined,
  BSchema extends StandardSchemaV1 | undefined = undefined
> {
  params?: PSchema
  query?: QSchema
  body?: BSchema
  middleware?: Middleware<
    ParamsFor<Route, PSchema>,
    QueryFor<QSchema>,
    BodyFor<BSchema>,
    TProvided
  >[]
  handler: RouteHandler<
    ParamsFor<Route, PSchema>,
    QueryFor<QSchema>,
    BodyFor<BSchema>,
    TProvided
  >
}

export function Arcton(config: ArctonConfig = {}): ArctonApp<{}> {
  const adapter = config.adapter ?? bunAdapter
  const environment = config.env ?? process.env.NODE_ENV ?? 'development'
  const router = createRouter()
  const websocketRoutes: RuntimeWebSocketRoute[] = []
  const steps: Step[] = []

  // `handler` typechecks per call site as `RouteHandler<ExtractParams<Route>,
  // TProvided>`, but the tree stores plain `RouteHandler`s and matches by
  // string, oblivious to which route or provided-context shape a handler
  // came from. The cast below is sound because `router.insert`'s own `path`
  // is what makes `match()` hand that handler back `params` shaped exactly
  // like `ExtractParams<Route>` — TS can't see that coupling through the
  // generics, so it's verified instead by the type tests in
  // router/types.test-d.ts and index.test-d.ts.
  //
  // Registration-order semantics: `steps` is snapshotted *here*, at
  // registration time — not read live from the shared array at request
  // time. A route only ever runs the use()/provide() calls that happened
  // before it was registered; anything registered after has no effect on
  // it. Route-level middleware (if any) is appended after the snapshot, so
  // it always runs innermost, closest to the handler.
  //
  // `validation` is undefined for the plain-handler call shape, so no
  // 'validate' step gets added.
  function insertRoute<Route extends string>(
    method: HttpMethod,
    path: Route,
    routeMiddleware: Middleware[],
    handler: RouteHandler,
    validation?: {
      params?: StandardSchemaV1
      query?: StandardSchemaV1
      body?: StandardSchemaV1
    }
  ): ArctonApp<never> {
    const validateStep: Step[] =
      validation && (validation.params || validation.query || validation.body)
        ? [{ kind: 'validate', ...validation }]
        : []

    const routeSteps: Step[] = [
      ...steps,
      ...validateStep,
      ...routeMiddleware.map((fn): Step => ({ kind: 'use', fn }))
    ]

    const composed: RouteHandler =
      routeSteps.length === 0
        ? handler
        : ctx => runPipeline(routeSteps, handler, ctx)

    router.insert(method, path, composed)
    return app as unknown as ArctonApp<never>
  }

  // A RouteOptions object is the only 1-argument call shape that isn't a
  // bare handler — the variadic middleware+handler tuple always ends in a
  // function, so `typeof args[0] === 'function'` is enough to tell the two
  // call shapes apart at runtime.
  function isRouteOptions(value: unknown): value is {
    params?: StandardSchemaV1
    query?: StandardSchemaV1
    body?: StandardSchemaV1
    middleware?: Middleware[]
    handler: RouteHandler
  } {
    return typeof value === 'object' && value !== null
  }

  function registerRoute<Route extends string>(
    method: HttpMethod,
    path: Route,
    args: unknown[]
  ): ArctonApp<never> {
    if (args.length === 1 && isRouteOptions(args[0])) {
      const { params, query, body, middleware, handler } = args[0]
      return insertRoute(method, path, middleware ?? [], handler, {
        params,
        query,
        body
      })
    }

    const handler = args[args.length - 1] as RouteHandler
    const routeMiddleware = args.slice(0, -1) as Middleware[]
    return insertRoute(method, path, routeMiddleware, handler)
  }

  const app: ArctonApp<{}> = {
    config,
    get<Route extends string>(path: Route, ...args: unknown[]) {
      return registerRoute('GET', path, args)
    },
    post<Route extends string>(path: Route, ...args: unknown[]) {
      return registerRoute('POST', path, args)
    },
    put<Route extends string>(path: Route, ...args: unknown[]) {
      return registerRoute('PUT', path, args)
    },
    delete<Route extends string>(path: Route, ...args: unknown[]) {
      return registerRoute('DELETE', path, args)
    },
    patch<Route extends string>(path: Route, ...args: unknown[]) {
      return registerRoute('PATCH', path, args)
    },
    head<Route extends string>(path: Route, ...args: unknown[]) {
      return registerRoute('HEAD', path, args)
    },
    options<Route extends string>(path: Route, ...args: unknown[]) {
      return registerRoute('OPTIONS', path, args)
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
    use(mw) {
      steps.push({ kind: 'use', fn: mw as Middleware })
      return app
    },
    provide(fn) {
      steps.push({ kind: 'provide', fn: fn as (ctx: Context) => unknown })
      return app as unknown as ArctonApp<never>
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
            response: { headers: new Headers() }
          }

          // result.handler already has its global-steps snapshot (as of
          // its own registration) and any route-level middleware baked in.
          // It materializes ctx.response into a real Response internally
          // (see runPipeline) whenever it has middleware/provide/validate
          // steps; the fast path (no steps at all) never touches it, so
          // it's built here instead.
          const body = await result.handler(ctx)
          return ctx.response instanceof Response
            ? ctx.response
            : mapResponse(body, ctx.response)
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
