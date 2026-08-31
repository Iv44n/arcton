// Type-only tests for `Middleware`, `NextFunction`, `compose`, `app.use`
// and `Context['state']`. Same convention as ../router/types.test-d.ts:
// checked purely by `tsc --noEmit`, no runtime assertions, excluded from
// `bun test`'s file matching (`.test-d.ts`, not `.test.ts`).

import type {
  Body,
  Context,
  Middleware,
  NextFunction,
  RouteHandler
} from '@arcton/contracts'
import { Arcton } from '../index'
import { compose } from './compose'

// ── Middleware assignability ────────────────────────────────────────────────

const voidMiddleware: Middleware = async (ctx, next) => {
  ctx.state.seen = true
  await next()
}
voidMiddleware satisfies Middleware

const bodyMiddleware: Middleware = () => ({ shortCircuited: true })
bodyMiddleware satisfies Middleware

declare const anyMiddleware: (ctx: Context, next: NextFunction) => void
anyMiddleware satisfies Middleware

// ── compose ──────────────────────────────────────────────────────────────

declare const middlewareList: Middleware[]
declare const handler: RouteHandler
declare const ctx: Context

compose(middlewareList, handler, ctx) satisfies Promise<Body | void>

// ── app.use ──────────────────────────────────────────────────────────────

const app = Arcton()
app.use(voidMiddleware) satisfies typeof app

// ── Context['state'] ─────────────────────────────────────────────────────

declare const state: Context['state']
state satisfies Record<string, unknown>
// Unlabeled key reads/writes are allowed — it's an index signature, not a
// fixed shape.
state.anyKey = 'x'
state.anyKey satisfies unknown

// A Context literal without `state` fails to construct — state is required.
// @ts-expect-error - state is required
const _missingState: Context = {
  request: new Request('http://localhost/'),
  params: {},
  query: {},
  response: { headers: new Headers() }
}
