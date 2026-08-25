// Type-only tests for `ExtractParams<Route>` and the `app.get<Route>(...)`
// overloads.
//
// bun:test ships no `expectTypeOf`, so this follows the standard TS
// pattern instead: `// @ts-expect-error` on a line that should fail to
// type-check. Checked purely by `tsc --noEmit` (packages/core's `build`
// script) — a stray `@ts-expect-error` on a line that actually type-checks
// is itself a tsc error (TS2578 "Unused '@ts-expect-error' directive"),
// which is what makes each assertion here a real check rather than just a
// comment. Nothing in this file runs: no `test()` calls, and it's excluded
// from `bun test`'s file matching on purpose — `*.test.ts` doesn't pick up
// the `.test-d.ts` suffix used here.

import { Arcton } from '../index'
import type { ExtractParams } from './types'

// ── ExtractParams<Route> in isolation ───────────────────────────────────────

declare const oneParam: ExtractParams<'/users/:id'>
oneParam.id satisfies string
// @ts-expect-error - "name" isn't a param of "/users/:id"
oneParam.name

declare const twoParams: ExtractParams<'/users/:id/posts/:postId'>
twoParams.id satisfies string
twoParams.postId satisfies string

declare const wildcardParam: ExtractParams<'/files/*path'>
wildcardParam.path satisfies string

// Mixing multiple `:param` segments with a trailing `*wildcard` segment.
declare const mixed: ExtractParams<'/users/:userId/posts/:postId/files/*rest'>
mixed.userId satisfies string
mixed.postId satisfies string
mixed.rest satisfies string

// A route with no `:`/`*` segments has no param keys — `Record<string,
// never>` still lets property reads through (index signature), just typed
// `never`, so this is checked by shape (assignability), not `@ts-expect-error`.
declare const noParams: ExtractParams<'/health'>
const wideRecord: Record<string, string> = { anything: 'x' }
// @ts-expect-error - Record<string, string> isn't assignable to Record<string, never>
const _narrowerThanWide: typeof noParams = wideRecord

// A non-literal `Route` (the widened `string` type itself, e.g. a `path`
// built at runtime) falls back to plain `Record<string, string>` instead
// of being parsed as if `"string"` were a route pattern.
declare const fallback: ExtractParams<string>
const _fallbackIsWide: typeof fallback = wideRecord

// ── app.get<Route>(...) end-to-end ──────────────────────────────────────────

const app = Arcton()

app.get('/users/:id', ctx => {
  ctx.params.id satisfies string
  // @ts-expect-error - "name" is not a param on this route
  ctx.params.name
})

app.get('/users/:id/posts/:postId', ctx => {
  ctx.params.id satisfies string
  ctx.params.postId satisfies string
  // @ts-expect-error - "commentId" is not a param on this route
  ctx.params.commentId
})

app.get('/files/*path', ctx => {
  ctx.params.path satisfies string
})

declare const dynamicPath: string
app.get(dynamicPath, ctx => {
  // Falls back to Record<string, string> — any key reads as string.
  const params: Record<string, string> = ctx.params
  return params
})
