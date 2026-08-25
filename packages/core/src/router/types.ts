// Type-level route-param extraction.
//
// Peels one path segment at a time off the route literal (splitting on
// "/", same as parse.ts does at runtime), pulling a param name
// out of `:name` (dynamic) and `*name` (wildcard) segments and discarding
// everything else (static segments, including the empty segments a
// leading/trailing "/" produces). The result is a union of the route's
// param names, which then becomes the keys of the params object.

type SegmentParamName<Segment extends string> = Segment extends `:${infer Name}`
  ? Name
  : Segment extends `*${infer Name}`
    ? Name
    : never

type RouteParamNames<Route extends string> =
  Route extends `${infer Head}/${infer Rest}`
    ? SegmentParamName<Head> | RouteParamNames<Rest>
    : SegmentParamName<Route>

// `string extends Route` is true only when `Route` is the wide `string`
// type itself, not a specific literal (a literal like "/users/:id" is a
// subtype of `string`, but `string` doesn't extend it back) — the standard
// literal-vs-widened check. That's the case for a `path` built at runtime
// and passed in as a plain `string` variable: there's no literal to parse,
// so params fall back to `Record<string, string>` (today's un-inferred
// behavior) instead of parsing "string" itself as if it were a route.
//
// A literal route with no `:`/`*` segments (e.g. "/health", or "/" itself)
// yields a `never` name union — `Record<string, never>` for that case
// (rather than `{}`) so it still satisfies the `P extends RouteParams`
// bound on `Context`/`RouteHandler` (an index signature of `never` is a
// subtype of one of `string`; a bare `{}` is not, since it carries no index
// signature at all).
export type ExtractParams<Route extends string> = string extends Route
  ? Record<string, string>
  : [RouteParamNames<Route>] extends [never]
    ? Record<string, never>
    : { [K in RouteParamNames<Route>]: string }
