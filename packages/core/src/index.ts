import { bunAdapter } from '@arcton/adapter-bun'
import type {
  BodyParser,
  Context,
  ErrorHandler,
  HttpMethod,
  Middleware,
  OpenAPIIntegration,
  ProvideFn,
  QueryParams,
  ReservedKeys,
  RouteDetail,
  RouteHandler,
  RouteParams,
  RouteRecord,
  RuntimeAdapter,
  RuntimeServer,
  RuntimeWebSocketHandler,
  RuntimeWebSocketRoute,
  StandardSchemaV1
} from '@arcton/contracts'
import pkg from '../package.json' with { type: 'json' }
import { Http } from './errors'
import {
  contentLengthExceeds,
  DEFAULT_MAX_BODY_SIZE,
  limitBodySize,
  normalizeMediaType
} from './middleware/body'
import { runPipeline, type Step } from './middleware/pipeline'
import { parse, type Segment } from './router/parse'
import { createRouter } from './router/router'
import { mapResponse } from './router/serialize'
import { graftTree, type RouteNode } from './router/tree'
import type { ExtractParams } from './router/types'

export { Http, HttpError } from './errors'

// Built once at module load, not per request — an unmatched route needs no
// per-request state, so there's nothing to gain from constructing a fresh
// HttpError for every 404. The fetch handler below reads its status/code/
// message directly to build the Response, the same way a compiled/AOT
// router would resolve a "not found" branch — no throw, so it never depends
// on notFoundSteps propagating an exception through a middleware chain to
// resolve into a response.
const notFoundError = Http.NotFound()

// Single source of truth for what app.all() expands to — every HttpMethod
// Arcton's router knows about, not a distinct "ANY" concept in the tree
// itself (see insertRoute/tree.insert: a plain list of concrete methods).
const ALL_METHODS: readonly HttpMethod[] = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS'
]

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
  /** Max request body size in bytes. Defaults to 128MB (Bun.serve's own default). */
  maxBodySize?: number
  /**
   * Serves an OpenAPI document and its UI, from `openapi()` in
   * `@arcton/openapi`. Configured here rather than at `Arcton()` because
   * `listen()` is the first point at which every module has been mounted —
   * the route set it documents is the one about to be served.
   *
   * The routes it registers are plain routes: global `use()`/`provide()`
   * steps do not apply to them.
   */
  openapi?: OpenAPIIntegration
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
  /**
   * Registers a route matched by every HTTP method Arcton supports — the
   * same seven as `get`/`post`/etc., not a wildcard for arbitrary/non-
   * standard verbs. Useful for delegating a whole path (or wildcard
   * subtree) to an external Request/Response handler, e.g. mounting a
   * library like better-auth: `app.all('/api/auth/*path', ctx =>
   * auth.handler(ctx.request))`. Registering `all()` and then a specific
   * method on the same path (in either order) throws the same "Duplicate
   * route" error as registering that method twice.
   */
  all: RouteMethod<TProvided>
  /**
   * Registers a WebSocket route. Bypasses the HTTP pipeline entirely —
   * `use()`/`provide()`/validation never run for it, so auth, logging or
   * rate-limiting registered globally do not apply here; handle it inside
   * this handler (typically in `open`).
   */
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
   * everything else. Accepts an `ArctonApp<M>` for any `M` — this app's own
   * `TProvided` is unaffected, and the module's handlers aren't retyped
   * against whatever this app goes on to `provide()`.
   */
  use<M>(app: ArctonApp<M>): ArctonApp<TProvided>
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
  /**
   * Registers a handler for an otherwise-uncaught error — anything thrown by
   * a provider, a middleware, route validation, or the handler itself.
   * Without one, an uncaught error propagates to the runtime adapter exactly
   * as before (a bare 500) — this is opt-in, not a replacement for try/catch
   * middleware.
   *
   * Only a single handler at a time (a later call replaces an earlier one),
   * and only the instance whose `listen()` you call is ever consulted — one
   * set on a module mounted with `use()` has no effect. For a boundary
   * scoped to part of your app, wrap `next()` in try/catch inside a scoped
   * `use(scope, middleware)` instead.
   *
   * `ctx.response.status` defaults to `500` if the handler doesn't set one
   * itself. If the handler itself throws, that error propagates uncaught,
   * the same as with no handler registered at all.
   */
  onError(
    handler: ErrorHandler<RouteParams, QueryParams, {}, TProvided>
  ): ArctonApp<TProvided>
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

/** A bare schema (implicitly `200`), or an explicit status → schema map. */
export type ResponseSchemas =
  | StandardSchemaV1
  | Record<number, StandardSchemaV1>

// A Standard Schema carries its own marker key; a status → schema map never
// does, which is what tells the two shorthand shapes apart.
function normalizeResponse(
  response: ResponseSchemas | undefined
): Record<number, StandardSchemaV1> | undefined {
  if (!response) return undefined
  return '~standard' in response ? { 200: response } : response
}

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
  /**
   * What this route responds with, per status code. A bare schema is
   * shorthand for `{ 200: schema }`.
   *
   * Documentation only — unlike `params`/`query`/`body`, nothing validates a
   * response against it at runtime, so it adds no per-request cost and a
   * handler returning something else still responds normally.
   */
  response?: ResponseSchemas
  /** Documentation metadata — see {@link RouteDetail}. */
  detail?: RouteDetail
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
  records: RouteRecord[]
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
  // What each route declared, kept because the tree stores only composed
  // handlers. Append-only, in registration order; read through routesOf().
  const records: RouteRecord[] = []
  // Not a pipeline step, so no snapshot semantics — see parser()'s doc
  // comment on ArctonApp. Read live at parse time, not per-route.
  const parsers = new Map<string, BodyParser>()
  // Not part of InternalState — a module's own onError() (if any) is never
  // read by mountApp/graftTree, only by the fetch this closure's own
  // listen() builds. See onError()'s doc comment on ArctonApp.
  let errorHandler: ErrorHandler | undefined

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
    method: HttpMethod | readonly HttpMethod[],
    path: Route,
    routeMiddleware: Middleware[],
    handler: RouteHandler,
    contract?: Omit<RouteRecord, 'method' | 'path'>
  ): ArctonApp<never> {
    // Only params/query/body become a pipeline step — `response`/`detail`
    // describe the route without affecting how a request runs.
    const validateStep: Step[] =
      contract && (contract.params || contract.query || contract.body)
        ? [
            {
              kind: 'validate',
              params: contract.params,
              query: contract.query,
              body: contract.body
            }
          ]
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
    const finalPath = joinPrefix(prefix, path)
    router.insert(method, finalPath, composed)

    // After insert, so a rejected registration (duplicate route, conflicting
    // parameter name) leaves no record behind. app.all() registers seven
    // methods and so produces seven records — OpenAPI has no "any method"
    // concept, and neither does the tree.
    for (const m of Array.isArray(method) ? method : [method as HttpMethod]) {
      records.push({ method: m, path: finalPath, ...contract })
    }

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

    // Mirrors the graft: a module's record already carries the module's own
    // prefix, so only this app's prefix is added. Copied, not referenced —
    // the module stays independently mountable, and routes registered on it
    // after this point don't appear here, same as its tree.
    for (const record of subInternal.records) {
      records.push({ ...record, path: joinPrefix(prefix, record.path) })
    }

    for (const route of subInternal.websocketRoutes) {
      websocketRoutes.push({
        path: joinPrefix(prefix, route.path),
        handler: route.handler
      })
    }
  }

  // Shared by both the matched-route and 404/405 branches of fetch() below.
  // errorHandler runs outside this function's own try — a throw from it
  // escapes uncaught rather than being fed back in as a second error.
  async function finalize(
    ctx: Context,
    produce: () => ReturnType<RouteHandler>
  ): Promise<Response> {
    try {
      const body = await produce()
      return ctx.response instanceof Response
        ? ctx.response
        : mapResponse(body, ctx.response)
    } catch (err) {
      if (!errorHandler) throw err
      const body = await errorHandler(err, ctx)
      if (ctx.response instanceof Response) return ctx.response
      // Only backfilled if nothing set a status already — before the throw
      // or in the handler itself.
      if (ctx.response.status === undefined) ctx.response.status = 500
      return mapResponse(body, ctx.response)
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
    response?: ResponseSchemas
    detail?: RouteDetail
    middleware?: Middleware[]
    handler: RouteHandler
  } {
    return typeof value === 'object' && value !== null
  }

  function registerRoute<Route extends string>(
    method: HttpMethod | readonly HttpMethod[],
    path: Route,
    args: unknown[]
  ): ArctonApp<never> {
    if (args.length === 1 && isRouteOptions(args[0])) {
      const { params, query, body, response, detail, middleware, handler } =
        args[0]
      if (typeof handler !== 'function') {
        const label = Array.isArray(method) ? 'ALL' : method
        throw new Error(
          `${label} "${path}": RouteOptions requires a "handler" function`
        )
      }
      return insertRoute(method, path, middleware ?? [], handler, {
        params,
        query,
        body,
        response: normalizeResponse(response),
        detail
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
    all<Route extends string>(path: Route, ...args: unknown[]) {
      return registerRoute(ALL_METHODS, path, args)
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
    onError(handler) {
      errorHandler = handler as ErrorHandler
      return app
    },
    listen(options = {}) {
      const adapter = options.adapter ?? bunAdapter
      const environment = options.env ?? process.env.NODE_ENV ?? 'development'
      const maxBodySize = options.maxBodySize ?? DEFAULT_MAX_BODY_SIZE

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

      // Registered here, against the final record set — every module has
      // been grafted by now, so a documented path is the path being served.
      // Inserted straight into the router: no prefix (the configured path is
      // absolute) and no record of their own, so they never document
      // themselves. A path already taken throws the usual duplicate-route
      // error.
      if (options.openapi) {
        for (const route of options.openapi.routes(records)) {
          router.insert('GET', route.path, route.handler)
        }
      }

      const server = adapter.serve({
        port: options.port ?? 3000,
        hostname: options.hostname,
        websocket: websocketRoutes,
        async fetch(request) {
          if (contentLengthExceeds(request, maxBodySize)) {
            return new Response(null, { status: 413 })
          }
          request = limitBodySize(request, maxBodySize)

          const method = request.method as HttpMethod
          // Parsed once and reused for both matching (pathname) and query
          // (searchParams) — router.matchPathname skips the URL parse
          // router.match does internally, since we already have one here.
          const url = new URL(request.url, 'http://localhost')
          const result = router.matchPathname(method, url.pathname)

          if ('notFound' in result || 'methodNotAllowed' in result) {
            const fallback: RouteHandler =
              'notFound' in result
                ? ctx => {
                    ctx.response.status = notFoundError.status
                    return (
                      notFoundError.body ?? {
                        code: notFoundError.code,
                        message: notFoundError.message
                      }
                    )
                  }
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

            return finalize(ctx, () =>
              notFoundSteps.length === 0
                ? fallback(ctx)
                : runPipeline(notFoundSteps, fallback, ctx)
            )
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
          return finalize(ctx, () => result.handler(ctx))
        }
      })

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
    prefix,
    records
  })

  return app
}

/**
 * Every route registered on `app`, in registration order, with the schemas
 * and metadata each one declared and its final (prefixed) path. Routes
 * mounted from a module are included; `ws()` routes are not, having no
 * contract to describe.
 *
 * The read-only view of what would otherwise be private state — enough for
 * `@arcton/openapi` and anything else that documents or inspects an app,
 * without exposing the router or the pipeline.
 */
export function routesOf<T>(app: ArctonApp<T>): readonly RouteRecord[] {
  const internal = getInternal(app)
  if (!internal) {
    throw new Error('routesOf() expects an Arcton app')
  }
  return internal.records
}
