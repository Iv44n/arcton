import { bunAdapter } from '@arcton/adapter-bun'
import type {
  BodyParser,
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
import { normalizeMediaType } from './middleware/body'
import { runPipeline, type Step } from './middleware/pipeline'
import { parse, type Segment } from './router/parse'
import { createRouter } from './router/router'
import { mapResponse } from './router/serialize'
import { graftTree, type RouteNode } from './router/tree'
import type { ExtractParams } from './router/types'

export interface ArctonConfig {
  /**
   * Where this instance's routes live within a mounting app's tree, e.g.
   * `/api`. Applied once, to every route/ws route registered directly on
   * this instance (see `insertRoute`/`ws`) — a `use(scope, mw)` scope still
   * compares against the path as written to `.get()`/etc., not against the
   * prefixed one (see `matchesScope`). Must be a static path, same
   * constraint as a `use()` scope. `'/'` is equivalent to no prefix.
   */
  prefix?: string
}

export interface ArctonListenOptions {
  port?: number
  hostname?: string
  adapter?: RuntimeAdapter
  /** Defaults to `process.env.NODE_ENV`, falling back to `'development'`. */
  env?: string
}

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
  /**
   * Global middleware — composes behavior. Doesn't grow `TProvided`; see
   * `provide()`. With a leading `scope` path (must be static — no `:param`/
   * `*wildcard` segments), only selected into routes whose own path is under
   * that scope (`scope` itself, or `${scope}/...`) at the time each route is
   * registered — same snapshot-at-registration-time semantics as unscoped
   * `use()`, just filtered by path first.
   */
  use(
    middleware: Middleware<RouteParams, QueryParams, {}, TProvided>
  ): ArctonApp<TProvided>
  use(
    scope: string,
    middleware: Middleware<RouteParams, QueryParams, {}, TProvided>
  ): ArctonApp<TProvided>
  /**
   * Mounts a module — another `Arcton()` instance — under this app's own
   * `prefix`. Grafts its already-built route tree (and ws routes) into this
   * app's tree, wrapped once with this app's own `use()`/`provide()` steps
   * registered so far — same snapshot-at-registration-time semantics as
   * everything else. Accepts any `ArctonApp<any>` — this app's own
   * `TProvided` is unaffected, and the module's handlers aren't retyped
   * against whatever this app goes on to `provide()`.
   */
  use(app: ArctonApp<any>): ArctonApp<TProvided>
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
  /**
   * Registers a body parser for an exact Content-Type (parameters like
   * "; charset=..." are ignored), overriding a built-in for the same type
   * if there is one. Not a pipeline step — a flat `mediaType → parser`
   * table with no ordering/snapshot semantics; registering the same
   * mediaType again just replaces the previous parser. Only consulted for
   * a route with a `body` schema (see `route()`'s `body` option).
   */
  parser(mediaType: string, parser: BodyParser): ArctonApp<TProvided>
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

// A scope or prefix must be a static path (reusing parse()'s own
// leading-slash/no-"//" validation) — dynamic/wildcard segments would turn
// matchesScope into a second matching system instead of a plain string
// relation between two paths.
function assertStaticPath(value: string, label: string): void {
  const { segments } = parse(value)
  if (segments.some(segment => segment.type !== 'static')) {
    throw new Error(
      `${label} "${value}" must be a static path — dynamic/wildcard segments ` +
        `aren't supported (e.g. app.use('/api', mw), not app.use('/api/:id', mw))`
    )
  }
}

function matchesScope(path: string, scope: string): boolean {
  return path === scope || path.startsWith(`${scope}/`)
}

// `undefined` and `'/'` both collapse to `''` — one case downstream instead
// of two.
function normalizePrefix(prefix?: string): string {
  if (!prefix || prefix === '/') return ''
  assertStaticPath(prefix, 'Prefix')
  return prefix
}

// `prefix` is already normalized (never `undefined`, never just `'/'`), so
// the only case to special-case is `path === '/'` itself — otherwise the
// prefix would grow a trailing slash (`/api` + `/` → `/api/`, not `/api`).
function joinPrefix(prefix: string, path: string): string {
  if (!prefix) return path
  return path === '/' ? prefix : `${prefix}${path}`
}

// Keeps each instance's router/steps/parsers/prefix off the public
// ArctonApp<TProvided> surface — a symbol key instead of a WeakMap, so the
// state lives alongside the object it describes.
const INTERNAL = Symbol('arcton.internal')

interface InternalState {
  root: RouteNode
  websocketRoutes: RuntimeWebSocketRoute[]
  steps: Step[]
  parsers: Map<string, BodyParser>
  prefix: string
}

// Avoids TypeScript's excess-property check on a symbol-keyed field
// against ArctonApp<{}>, and keeps it out of `for...in`/`Object.keys`.
function attachInternal(app: object, state: InternalState): void {
  Object.defineProperty(app, INTERNAL, { value: state, enumerable: false })
}

// `undefined` for any plain object that isn't an Arcton() instance — lets
// use()'s mount branch tell a module apart from anything else.
function getInternal(value: object): InternalState | undefined {
  return (value as Record<symbol, InternalState | undefined>)[INTERNAL]
}

// Defers Object.fromEntries(url.searchParams) until something actually
// reads ctx.query — most requests (every 404/405, plus any handler that
// never touches it) skip it entirely. A get/set pair (not a getter alone)
// so a 'validate' step's `ctx.query = result.value` (see
// middleware/pipeline.ts) still works as a plain assignment.
function lazyQuery(url: URL): {
  get(): QueryParams
  set(next: QueryParams): void
} {
  let value: QueryParams | undefined
  return {
    get: () => (value ??= Object.fromEntries(url.searchParams)),
    set: next => {
      value = next
    }
  }
}

export function Arcton(config: ArctonConfig = {}): ArctonApp<{}> {
  const prefix = normalizePrefix(config.prefix)
  const prefixSegments: Segment[] = prefix ? parse(prefix).segments : []
  const router = createRouter()
  const websocketRoutes: RuntimeWebSocketRoute[] = []
  const steps: Step[] = []
  // Not a pipeline step, so no snapshot semantics — see parser()'s doc
  // comment on ArctonApp. Read live at parse time, not per-route.
  const parsers = new Map<string, BodyParser>()

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
  // A scoped 'use' step (see matchesScope) is selected into the snapshot
  // right here, based on this route's own path — not resolved later at
  // match/request time. The router never learns a step had a scope at all.
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
      ...steps.filter(
        step =>
          step.kind !== 'use' ||
          step.scope === undefined ||
          matchesScope(path, step.scope)
      ),
      ...validateStep,
      ...routeMiddleware.map((fn): Step => ({ kind: 'use', fn }))
    ]

    const composed: RouteHandler =
      routeSteps.length === 0
        ? handler
        : ctx => runPipeline(routeSteps, handler, ctx, parsers)

    // Applied only here — scope matching above still works against `path`
    // as written to `.get()`, unprefixed (see ArctonConfig.prefix).
    router.insert(method, joinPrefix(prefix, path), composed)
    return app as unknown as ArctonApp<never>
  }

  // A scoped 'use' step is dropped here, not carried over: runPipeline
  // never looks at `step.scope` (only insertRoute's own per-route filter
  // does), and a mounted module is grafted whole, with no single path of
  // its own to test a scope against — same reasoning as listen()'s
  // notFoundSteps for 404/405.
  function mountApp(subInternal: InternalState): void {
    const parentSteps = steps.filter(
      step => step.kind !== 'use' || step.scope === undefined
    )
    const wrap = (handler: RouteHandler): RouteHandler =>
      parentSteps.length === 0
        ? handler
        : ctx => runPipeline(parentSteps, handler, ctx, parsers)

    graftTree(router.root, subInternal.root, prefixSegments, wrap)

    for (const route of subInternal.websocketRoutes) {
      websocketRoutes.push({
        path: joinPrefix(prefix, route.path),
        handler: route.handler
      })
    }
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
      websocketRoutes.push({ path: joinPrefix(prefix, path), handler })
      return app
    },
    use(...args: unknown[]) {
      if (
        args.length === 1 &&
        typeof args[0] === 'object' &&
        args[0] !== null
      ) {
        const subInternal = getInternal(args[0])
        if (!subInternal) {
          throw new Error(
            'use() expects a middleware function, a (scope, middleware) ' +
              'pair, or an Arcton app to mount'
          )
        }
        mountApp(subInternal)
        return app
      }

      if (args.length >= 2) {
        const [scope, mw] = args as [string, Middleware]
        assertStaticPath(scope, 'Scope')
        steps.push({ kind: 'use', fn: mw, scope })
      } else {
        steps.push({ kind: 'use', fn: args[0] as Middleware })
      }
      return app
    },
    provide(fn) {
      steps.push({ kind: 'provide', fn: fn as (ctx: Context) => unknown })
      return app as unknown as ArctonApp<never>
    },
    parser(mediaType, parser) {
      parsers.set(normalizeMediaType(mediaType), parser)
      return app
    },
    listen(options = {}) {
      const adapter = options.adapter ?? bunAdapter
      const environment = options.env ?? process.env.NODE_ENV ?? 'development'

      // Checked here, not at ws()/mount time — this is the earliest point
      // the final set of ws routes (including any merged in via mountApp)
      // and the actual serving adapter are both known.
      if (websocketRoutes.length > 0 && !adapter.capabilities.websocket) {
        throw new Error(
          `Runtime "${adapter.name}" does not support WebSocket routes.`
        )
      }

      // 404/405 has no matched route, so no per-route snapshot to attach
      // to — there's nothing for scoped use()/route middleware to be
      // "before or after". Only unscoped use() steps apply, and they apply
      // regardless of their order relative to any route registration
      // (unlike a route's own snapshot). Computed once here, not re-read
      // from `steps` per request — `.listen()` is the one point after which
      // nothing else is expected to register more global middleware.
      const notFoundSteps = steps.filter(
        (step): step is Step & { kind: 'use' } =>
          step.kind === 'use' && step.scope === undefined
      )

      const server = adapter.serve({
        port: options.port ?? 3000,
        hostname: options.hostname,
        websocket: websocketRoutes,
        async fetch(request) {
          const method = request.method as HttpMethod
          // Parsed once and reused for both matching (pathname) and query
          // (searchParams) — router.matchPathname skips the URL parse
          // router.match does internally, since we already have one here.
          const url = new URL(request.url, 'http://localhost')
          const result = router.matchPathname(method, url.pathname)

          if ('notFound' in result || 'methodNotAllowed' in result) {
            const fallback: RouteHandler =
              'notFound' in result
                ? () => new Response(null, { status: 404 })
                : () =>
                    new Response(null, {
                      status: 405,
                      headers: { Allow: result.allowed.join(', ') }
                    })

            const query = lazyQuery(url)
            const ctx: Context = {
              request,
              params: {},
              get query() {
                return query.get()
              },
              set query(next) {
                query.set(next)
              },
              response: { headers: new Headers() }
            }

            const body =
              notFoundSteps.length === 0
                ? await fallback(ctx)
                : await runPipeline(notFoundSteps, fallback, ctx)

            return ctx.response instanceof Response
              ? ctx.response
              : mapResponse(body, ctx.response)
          }

          const query = lazyQuery(url)
          const ctx: Context = {
            request,
            params: result.params,
            get query() {
              return query.get()
            },
            set query(next) {
              query.set(next)
            },
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

      console.log(figlet.textSync('Arcton'))
      console.log(`  Arcton       v${pkg.version}`)
      console.log(`  Runtime      ${adapter.name} v${adapter.version}`)
      console.log(`  Environment  ${environment}`)
      console.log(`  Listening    ${server.url}`)
      console.log()

      return server
    }
  }

  attachInternal(app, {
    root: router.root,
    websocketRoutes,
    steps,
    parsers,
    prefix
  })

  return app
}
