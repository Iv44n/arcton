// ── Router types ────────────────────────────────────────────────────────────

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

export interface BaseContext<P = RouteParams, Q = QueryParams> {
  request: Request
  params: P
  query: Q
  response: ResponseContext
}

// TBody accumulates flat onto Context via intersection, same as TProvided —
// {} (no `body` key at all) unless a route declares a body schema (see
// ArctonApp.route() in packages/core/src/index.ts). TProvided accumulates
// the same way, grown exclusively through ArctonApp.provide() (see
// Middleware types below); consumed by destructuring, e.g.
// `({ user }) => user.id`.
//
// P/Q have no `extends RouteParams`/`extends QueryParams` bound (only a
// default) — a schema with coercion (e.g. Zod's `z.coerce.number()`) can
// produce a params/query shape with non-string values, which wouldn't
// satisfy that bound.
export type Context<
  P = RouteParams,
  Q = QueryParams,
  TBody = {},
  TProvided = {}
> = BaseContext<P, Q> & TBody & TProvided

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

export type RouteHandler<
  P = RouteParams,
  Q = QueryParams,
  TBody = {},
  TProvided = {}
> = (
  ctx: Context<P, Q, TBody, TProvided>
) => (Body | void) | Promise<Body | void>

// `err` is `unknown`, not `Error` — a thrown value in JS isn't guaranteed to
// be one.
export type ErrorHandler<
  P = RouteParams,
  Q = QueryParams,
  TBody = {},
  TProvided = {}
> = (
  err: unknown,
  ctx: Context<P, Q, TBody, TProvided>
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

// P/Q: route params/query (route-level middleware, typed by the route it's
// attached to and by any params/query schema on it — global middleware via
// app.use() stays at the defaults, RouteParams/QueryParams, since it runs
// before route-level validation). TBody/TProvided: accumulated context so
// far in the chain (see Context<P, Q, TBody, TProvided>).
//
// Parameter order is load-bearing: P, Q, TBody, TProvided — inserting Q/TBody
// anywhere else would silently rebind any existing 2-arg explicit usage
// (e.g. `Middleware<{id: string}, {user: User}>`) to mean something
// different instead of failing to compile.
export type Middleware<
  P = RouteParams,
  Q = QueryParams,
  TBody = {},
  TProvided = {}
> = (
  ctx: Context<P, Q, TBody, TProvided>,
  next: NextFunction
) => Promise<Body | void> | Body | void

// Keys a provide() call is not allowed to add — the base Context fields
// (request/params/query/response), 'body' (owned by route()'s TBody slot,
// see BodyFor<> in index.ts — a provide()d "body" would type as an
// intersection with a route's body schema output but get silently
// overwritten by it at runtime, since 'validate' steps always run after
// 'provide' steps), and anything already provided earlier in the chain.
// Re-providing an existing key would silently collapse its type to an
// intersection of both shapes instead of erroring.
export type ReservedKeys<TProvided> =
  | keyof BaseContext
  | 'body'
  | keyof TProvided

// No `next`, no Body semantics — the return value IS the new context slice,
// merged into TProvided by intersection (ArctonApp.provide() adds R, it
// doesn't replace TProvided). provide() always runs before route-level
// validation, so it only ever sees the raw params/query defaults, never a
// route's params/query/body schema output — hence the bare
// RouteParams/QueryParams/{} here, not generics.
export type ProvideFn<TProvided, R extends Record<string, unknown>> = (
  ctx: Context<RouteParams, QueryParams, {}, TProvided>
) => R | Promise<R>

// Registered per exact Content-Type via ArctonApp.parser() — only sees the
// raw Request, not ctx, since parsing has nothing to do with route context.
// `undefined` means "not handled" (keeps looking, ultimately 415) — chosen
// over a truthy check so a legitimately parsed `false`/`0`/`''`/`null`
// still counts as handled.
export type BodyParser = (request: Request) => unknown | Promise<unknown>

// ── Schema validation ─────────────────────────────────────────────────────

// Standard Schema (https://standardschema.dev/) — a vendor-neutral interface
// that validation libraries (Zod 3.24+, Valibot, ArkType, ...) implement, so
// route()'s params/query/body accept any of them without Arcton depending on
// one specifically. `types` is a phantom field — never populated at runtime,
// read only through `InferOutput` for type inference at zero runtime cost.
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>
}

export namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown
    ) => Result<Output> | Promise<Result<Output>>
    readonly types?: Types<Input, Output> | undefined
  }
  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input
    readonly output: Output
  }
  export type Result<Output> = SuccessResult<Output> | FailureResult
  export interface SuccessResult<Output> {
    readonly value: Output
    readonly issues?: undefined
  }
  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>
  }
  export interface Issue {
    readonly message: string
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined
  }
  export interface PathSegment {
    readonly key: PropertyKey
  }
  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['output']
}

// Standard JSON Schema (https://standardschema.dev/json-schema) — a sibling
// spec sharing the same `~standard` key, so a schema that supports it is
// detected by feature, not by vendor: `'jsonSchema' in schema['~standard']`.
// Declared here rather than depending on @standard-schema/spec, same as
// StandardSchemaV1 above. Nothing in the framework reads this; it exists so
// packages built on Arcton (see OpenAPIIntegration) can derive documentation
// from the very schemas already used for validation.
export interface StandardJSONSchemaV1 {
  readonly '~standard': StandardJSONSchemaV1.Props
}

export namespace StandardJSONSchemaV1 {
  export interface Props {
    readonly jsonSchema: Converter
  }
  // `input` and `output` differ for any schema with a transform — the value
  // accepted by a request is not the value a handler produces. Both may throw
  // when a schema has no JSON Schema representation (e.g. Zod's `z.date()`).
  export interface Converter {
    readonly input: (options: Options) => Record<string, unknown>
    readonly output: (options: Options) => Record<string, unknown>
  }
  export type Target =
    | 'draft-2020-12'
    | 'draft-07'
    | 'openapi-3.0'
    | ({} & string)
  export interface Options {
    readonly target: Target
    readonly libraryOptions?: Record<string, unknown> | undefined
  }
}

// ── Route records ────────────────────────────────────────────────────────

/** Documentation-only metadata carried through to an OpenAPI operation. */
export interface RouteDetail {
  operationId?: string
  summary?: string
  description?: string
  tags?: string[]
  deprecated?: boolean
}

// What a route declared, kept alongside the route tree — the tree itself
// stores composed handlers only, so the schemas would otherwise be
// unrecoverable after registration. The original Standard Schemas are kept,
// not a converted form: what a consumer needs them for (JSON Schema, a client
// generator, a test helper) isn't core's business to decide.
//
// `path` is final — the mounting prefix chain is already applied (see
// mountApp in packages/core/src/index.ts), so a record from a module reads
// the same as one registered on the root app.
export interface RouteRecord {
  method: HttpMethod
  path: string
  params?: StandardSchemaV1
  query?: StandardSchemaV1
  body?: StandardSchemaV1
  /** Normalized from `RouteOptions.response`, always keyed by status code. */
  response?: Record<number, StandardSchemaV1>
  detail?: RouteDetail
}

// ── OpenAPI integration ──────────────────────────────────────────────────

/** A route an integration asks `listen()` to register, always as `GET`. */
export interface DocumentRoute {
  path: string
  handler: RouteHandler
}

// The single extension point `listen({ openapi })` accepts — deliberately not
// a plugin registry. Core knows this interface and never the implementation,
// exactly as it knows RuntimeAdapter without knowing any adapter, which keeps
// the dependency pointing @arcton/openapi → @arcton/core.
//
// Called once during listen(), after every module has been grafted, so
// `records` is the final route set.
export interface OpenAPIIntegration {
  routes(records: readonly RouteRecord[]): DocumentRoute[]
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
