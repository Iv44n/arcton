// Type-only tests for `ArctonApp<TProvided>`, `provide()`, route-level
// middleware combined with provided context, and `route()`'s params/query/
// body schema validation. Same convention as router/types.test-d.ts:
// checked purely by `tsc --noEmit`, no runtime assertions, excluded from
// `bun test`'s file matching (`.test-d.ts`, not `.test.ts`).

import { bunAdapter } from '@arcton/adapter-bun'
import type {
  Middleware,
  QueryParams,
  StandardSchemaV1
} from '@arcton/contracts'
import { Arcton } from './index'

interface User {
  id: string
}
interface Permissions {
  roles: string[]
}

// ── provide(): grows TProvided, destructured flat off ctx ──────────────────

const withAuth = Arcton().provide(async () => ({ user: { id: 'u1' } as User }))

withAuth.get('/me', ({ user }) => {
  user.id satisfies string
})

// A handler registered before provide() doesn't see the provided key.
Arcton().get('/early', ctx => {
  // @ts-expect-error - "user" not provided yet at this point in the chain
  ctx.user
})

// provide() composes — a later one can read what an earlier one added.
const withBoth = withAuth.provide(async ({ user }) => ({
  permissions: { roles: [user.id] } as Permissions
}))

withBoth.get('/admin', ({ user, permissions }) => {
  user.id satisfies string
  permissions.roles satisfies string[]
})

// Re-providing an already-provided key is rejected.
// @ts-expect-error - "user" is already provided by withAuth
withAuth.provide(() => ({ user: 'oops' }))

// Providing a key that collides with a base Context field is rejected.
// @ts-expect-error - "params" collides with the reserved Context field
Arcton().provide(() => ({ params: 'oops' }))

// ── route-level middleware + provide(), combined ────────────────────────────

const routeAuth: Middleware<
  { id: string },
  QueryParams,
  {},
  { user: User }
> = async (ctx, next) => {
  ctx.params.id satisfies string
  ctx.user.id satisfies string
  await next()
}

withBoth.get(
  '/users/:id/profile',
  routeAuth,
  ({ params, user, permissions }) => {
    params.id satisfies string
    user.id satisfies string
    permissions.roles satisfies string[]
  }
)

// Route-level middleware typed for the wrong route's params is rejected.
const wrongParamsMw: Middleware<
  { slug: string },
  QueryParams,
  {},
  { user: User }
> = async (_ctx, next) => {
  await next()
}
// @ts-expect-error - Middleware<{slug: string}, ...> doesn't match "/users/:id"'s {id: string}
withBoth.get('/users/:id', wrongParamsMw, _ctx => {})

// 0-middleware call (backward-compat shape) still works with provided context.
withBoth.get('/users/:id', ({ params, user }) => {
  params.id satisfies string
  user.id satisfies string
})

// ── get/post(path, options): params/query/body schemas, combinable ─────────

function fakeSchema<Input, Output>(
  fn: (v: Input) => Output
): StandardSchemaV1<Input, Output> {
  return {
    '~standard': {
      version: 1,
      vendor: 'fake',
      validate: (v: unknown) => ({ value: fn(v as Input) })
    }
  }
}

const idParams = fakeSchema((v: Record<string, string>) => ({
  id: Number(v.id)
}))
const limitQuery = fakeSchema((v: Record<string, string>) => ({
  limit: v.limit ? Number(v.limit) : undefined
}))
const createUserBody = fakeSchema((v: unknown) => ({
  name: String((v as { name: unknown }).name)
}))

// No schema at all — same as the plain-handler shape, ctx.body doesn't exist.
Arcton().get('/users/:id', {
  handler: ctx => {
    ctx.params.id satisfies string
    ctx.query satisfies Record<string, string>
    // @ts-expect-error - no body schema declared, ctx.body doesn't exist
    ctx.body
  }
})

// params only.
Arcton().get('/users/:id', {
  params: idParams,
  handler: ctx => {
    ctx.params.id satisfies number
    ctx.query satisfies Record<string, string>
  }
})

// query only.
Arcton().get('/users/:id', {
  query: limitQuery,
  handler: ctx => {
    ctx.params.id satisfies string
    ctx.query.limit satisfies number | undefined
  }
})

// body only.
Arcton().post('/users/:id', {
  body: createUserBody,
  handler: ctx => {
    ctx.params.id satisfies string
    ctx.body.name satisfies string
  }
})

// params + query.
Arcton().get('/users/:id', {
  params: idParams,
  query: limitQuery,
  handler: ctx => {
    ctx.params.id satisfies number
    ctx.query.limit satisfies number | undefined
  }
})

// params + body.
Arcton().post('/users/:id', {
  params: idParams,
  body: createUserBody,
  handler: ctx => {
    ctx.params.id satisfies number
    ctx.body.name satisfies string
  }
})

// query + body.
Arcton().post('/users/:id', {
  query: limitQuery,
  body: createUserBody,
  handler: ctx => {
    ctx.query.limit satisfies number | undefined
    ctx.body.name satisfies string
    ctx.params.id satisfies string
  }
})

// params + query + body, plus route-level middleware seeing all three
// validated, plus TProvided from an earlier provide() still intact.
withAuth.post('/users/:id', {
  params: idParams,
  query: limitQuery,
  body: createUserBody,
  middleware: [
    async (ctx, next) => {
      ctx.params.id satisfies number
      ctx.query.limit satisfies number | undefined
      ctx.body.name satisfies string
      ctx.user.id satisfies string
      await next()
    }
  ],
  handler: ({ params, query, body, user }) => {
    params.id satisfies number
    query.limit satisfies number | undefined
    body.name satisfies string
    user.id satisfies string
    return { ok: true }
  }
})

// ── get/post(path, ...): overload disambiguation ────────────────────────────

// A bare handler still matches the plain-handler overload, not RouteOptions.
Arcton().get('/users/:id', ctx => {
  ctx.params.id satisfies string
})

// A RouteOptions with the wrong handler param type is rejected, not widened.
// @ts-expect-error - handler's ctx.params.id must be number (schema output), not string
Arcton().post('/users/:id', {
  params: idParams,
  handler: (_ctx: { params: { id: string } }) => {}
})

// No overload accepts (path, options, extraArg) — mixing the two call shapes.
// @ts-expect-error
Arcton().get('/x', { handler: () => {} }, () => {})

// ── ArctonConfig / ArctonListenOptions ──────────────────────────────────────

// `port` moved to ArctonListenOptions — ArctonConfig no longer accepts it.
// @ts-expect-error - "port" is not a key of ArctonConfig anymore
Arcton({ port: 3000 })

// adapter/env now belong to listen(), alongside port/hostname.
Arcton().listen({ adapter: bunAdapter, env: 'development' })
