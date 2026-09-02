import { expect, test } from 'bun:test'
import type { Context, StandardSchemaV1 } from '@arcton/contracts'
import { runPipeline, type Step } from './pipeline'

function makeCtx(overrides: Partial<Context> = {}): Context {
  return {
    request: new Request('http://localhost/'),
    params: {},
    query: {},
    response: { headers: new Headers() },
    ...overrides
  }
}

function fakeSchema<Input, Output>(
  fn: (v: Input) => Output
): StandardSchemaV1<Input, Output> {
  return {
    '~standard': {
      version: 1,
      vendor: 'fake',
      validate: (value: unknown) => {
        try {
          return { value: fn(value as Input) }
        } catch (err) {
          return { issues: [{ message: (err as Error).message }] }
        }
      }
    }
  }
}

function failingSchema(message: string): StandardSchemaV1 {
  return {
    '~standard': {
      version: 1,
      vendor: 'fake',
      validate: () => ({ issues: [{ message }] })
    }
  }
}

test('empty pipeline uses the fast path: same shape as calling the handler directly', () => {
  const cachedPromise = Promise.resolve<{ ok: true }>({ ok: true })
  const handler = () => cachedPromise

  const result = runPipeline([], handler, makeCtx())

  expect(result).toBe(cachedPromise)
})

test('empty pipeline fast path: a synchronous throw in the handler escapes runPipeline(...) itself', () => {
  const handler = () => {
    throw new Error('sync boom')
  }

  expect(() => runPipeline([], handler, makeCtx())).toThrow('sync boom')
})

// ── pure use()-chain onion semantics (ported from compose.ts/compose.test.ts
// before deleting them — compose() duplicated this exact logic and nothing
// imported it outside its own tests; runPipeline's 'use' branch is the one
// real implementation now) ──────────────────────────────────────────────────

test('use-only: pre/post order across two middleware', async () => {
  const order: string[] = []
  const steps: Step[] = [
    {
      kind: 'use',
      fn: async (_ctx, next) => {
        order.push('mw1-pre')
        await next()
        order.push('mw1-post')
      }
    },
    {
      kind: 'use',
      fn: async (_ctx, next) => {
        order.push('mw2-pre')
        await next()
        order.push('mw2-post')
      }
    }
  ]
  const handler = () => {
    order.push('handler')
  }

  await runPipeline(steps, handler, makeCtx())

  expect(order).toEqual([
    'mw1-pre',
    'mw2-pre',
    'handler',
    'mw2-post',
    'mw1-post'
  ])
})

test("use-only: mw calls next() and returns a Body → body = mw's (replace, the return wins)", async () => {
  const steps: Step[] = [
    {
      kind: 'use',
      fn: async (_ctx, next) => {
        await next()
        return { fromMw: true }
      }
    }
  ]
  const handler = () => ({ fromHandler: true })

  const body = await runPipeline(steps, handler, makeCtx())

  expect(body).toEqual({ fromMw: true })
})

test('use-only: short-circuit with a Response — body is the exact Response instance (identity)', async () => {
  const response = new Response('ok')
  const steps: Step[] = [{ kind: 'use', fn: () => response }]
  const handler = () => ({ fromHandler: true })

  const body = await runPipeline(steps, handler, makeCtx())

  expect(body).toBe(response)
})

// ── ctx.response materialization ────────────────────────────────────────────
//
// ctx.response holds the pipeline's mutable response-in-progress. It becomes
// the real Response the moment a body finalizes at some layer (handler
// resolving, a short-circuit, or a replace after next()) — before any
// enclosing middleware's post-next() code runs, so that code always sees
// the real thing, never the pre-materialization placeholder.

test('ctx.response is the real Response once the handler resolves, headers stay mutable, status does not', async () => {
  const ctx = makeCtx()
  let sawResponseInstance = false
  let statusAssignmentThrew = false
  const steps: Step[] = [
    {
      kind: 'use',
      fn: async (c, next) => {
        await next()
        sawResponseInstance = c.response instanceof Response
        try {
          c.response.status = 204
        } catch {
          statusAssignmentThrew = true
        }
        c.response.headers.set('X-Request-Id', 'abc')
      }
    }
  ]

  await runPipeline(steps, () => ({ ok: true }), ctx)

  expect(sawResponseInstance).toBe(true)
  expect(statusAssignmentThrew).toBe(true)
  expect(ctx.response.status).toBe(200) // unchanged — the throw above didn't apply
  expect(ctx.response.headers.get('X-Request-Id')).toBe('abc') // headers still mutable
  expect(await (ctx.response as Response).json()).toEqual({ ok: true })
})

test('use-only: replacing the body after next() inherits headers already set on ctx.response', async () => {
  const ctx = makeCtx()
  const steps: Step[] = [
    {
      kind: 'use',
      fn: async (c, next) => {
        await next()
        c.response.headers.set('X-Trace', 'inner')
        return { replaced: true }
      }
    }
  ]

  await runPipeline(steps, () => ({ original: true }), ctx)

  expect(ctx.response).toBeInstanceOf(Response)
  expect(ctx.response.headers.get('X-Trace')).toBe('inner')
  expect(await (ctx.response as Response).json()).toEqual({ replaced: true })
})

test('use-only: replacing with a raw Response after next() overrides completely, no header inheritance', async () => {
  const ctx = makeCtx()
  const rawReplacement = new Response('replaced', { status: 201 })
  const steps: Step[] = [
    {
      kind: 'use',
      fn: async (c, next) => {
        await next()
        c.response.headers.set('X-Trace', 'inner')
        return rawReplacement
      }
    }
  ]

  await runPipeline(steps, () => ({ original: true }), ctx)

  expect(ctx.response).toBe(rawReplacement)
  expect(ctx.response.headers.get('X-Trace')).toBeNull()
  expect(ctx.response.status).toBe(201)
})

test('use-only: a throwing handler propagates, an outer mw with try/catch catches it', async () => {
  const handler = () => {
    throw new Error('handler boom')
  }
  const steps: Step[] = [
    {
      kind: 'use',
      fn: async (_ctx, next) => {
        try {
          await next()
        } catch (err) {
          return { caught: (err as Error).message }
        }
      }
    }
  ]

  const body = await runPipeline(steps, handler, makeCtx())

  expect(body).toEqual({ caught: 'handler boom' })
})

test('use-only: mw2 throws in pre-code, before calling next() → propagates, catchable by outer mw1', async () => {
  const steps: Step[] = [
    {
      kind: 'use',
      fn: async (_ctx, next) => {
        try {
          await next()
        } catch (err) {
          return { caught: (err as Error).message }
        }
      }
    },
    {
      kind: 'use',
      fn: () => {
        throw new Error('mw2 pre-code boom')
      }
    }
  ]
  const handler = () => ({ fromHandler: true })

  const body = await runPipeline(steps, handler, makeCtx())

  expect(body).toEqual({ caught: 'mw2 pre-code boom' })
})

test('use-only: mw2 throws in post-code, after calling next() → downstream already ran, still propagates', async () => {
  let handlerCalled = false
  const steps: Step[] = [
    {
      kind: 'use',
      fn: async (_ctx, next) => {
        try {
          await next()
        } catch (err) {
          return { caught: (err as Error).message }
        }
      }
    },
    {
      kind: 'use',
      fn: async (_ctx, next) => {
        await next()
        throw new Error('mw2 post-code boom')
      }
    }
  ]
  const handler = () => {
    handlerCalled = true
  }

  const body = await runPipeline(steps, handler, makeCtx())

  expect(handlerCalled).toBe(true)
  expect(body).toEqual({ caught: 'mw2 post-code boom' })
})

test("use-only: nested short-circuit — outer mw1 returns void, inner mw2 short-circuits → body is mw2's", async () => {
  let handlerCalled = false
  const steps: Step[] = [
    {
      kind: 'use',
      fn: async (_ctx, next) => {
        await next()
      }
    },
    { kind: 'use', fn: () => ({ fromMw2: true }) }
  ]
  const handler = () => {
    handlerCalled = true
  }

  const body = await runPipeline(steps, handler, makeCtx())

  expect(handlerCalled).toBe(false)
  expect(body).toEqual({ fromMw2: true })
})

test('use-only: two middleware both return a Body → the outermost one wins', async () => {
  const steps: Step[] = [
    {
      kind: 'use',
      fn: async (_ctx, next) => {
        await next()
        return { from: 'mw1' }
      }
    },
    {
      kind: 'use',
      fn: async (_ctx, next) => {
        await next()
        return { from: 'mw2' }
      }
    }
  ]
  const handler = () => ({ from: 'handler' })

  const body = await runPipeline(steps, handler, makeCtx())

  expect(body).toEqual({ from: 'mw1' })
})

test('use-only: mw skips next() entirely → resolves void, body left unset', async () => {
  let handlerCalled = false
  const steps: Step[] = [{ kind: 'use', fn: () => {} }]
  const handler = () => {
    handlerCalled = true
    return { fromHandler: true }
  }

  const body = await runPipeline(steps, handler, makeCtx())

  expect(handlerCalled).toBe(false)
  expect(body).toBeUndefined()
})

test('use-only: next() called twice (current behavior, not a guaranteed API) — downstream runs twice', async () => {
  let handlerCalls = 0
  const steps: Step[] = [
    {
      kind: 'use',
      fn: async (_ctx, next) => {
        await next()
        await next()
      }
    }
  ]
  const handler = () => {
    handlerCalls++
  }

  await runPipeline(steps, handler, makeCtx())

  expect(handlerCalls).toBe(2)
})

test('provide → handler: handler sees what was provided', async () => {
  const steps: Step[] = [
    { kind: 'provide', fn: () => ({ user: { id: 'u1' } }) }
  ]
  const ctx = makeCtx()

  const body = await runPipeline(
    steps,
    c => ({ userId: (c as unknown as { user: { id: string } }).user.id }),
    ctx
  )

  expect(body).toEqual({ userId: 'u1' })
  expect((ctx as unknown as { user: unknown }).user).toEqual({ id: 'u1' })
})

test('provide → provide → handler: composition, the second reads the first', async () => {
  const steps: Step[] = [
    { kind: 'provide', fn: () => ({ user: { id: 'u1' } }) },
    {
      kind: 'provide',
      fn: ctx => ({
        permissions: [(ctx as unknown as { user: { id: string } }).user.id]
      })
    }
  ]
  const ctx = makeCtx() as unknown as { user: unknown; permissions: unknown }

  await runPipeline(steps, () => undefined, ctx as unknown as Context)

  expect(ctx.user).toEqual({ id: 'u1' })
  expect(ctx.permissions).toEqual(['u1'])
})

test('provide → use → handler: use sees what was provided before it', async () => {
  let sawUserInUse: unknown
  const steps: Step[] = [
    { kind: 'provide', fn: () => ({ user: { id: 'u1' } }) },
    {
      kind: 'use',
      fn: async (ctx, next) => {
        sawUserInUse = (ctx as unknown as { user: unknown }).user
        await next()
      }
    }
  ]
  const ctx = makeCtx()

  const body = await runPipeline(
    steps,
    c => ({ userId: (c as unknown as { user: { id: string } }).user.id }),
    ctx
  )

  expect(sawUserInUse).toEqual({ id: 'u1' })
  expect(body).toEqual({ userId: 'u1' })
})

test('use → provide → handler: pre-code sees nothing, post-code sees it', async () => {
  let sawInPre: unknown
  let sawInPost: unknown
  const steps: Step[] = [
    {
      kind: 'use',
      fn: async (ctx, next) => {
        sawInPre = (ctx as unknown as { user: unknown }).user // provide() hasn't run yet
        await next()
        sawInPost = (ctx as unknown as { user: unknown }).user // it has, by now
      }
    },
    { kind: 'provide', fn: () => ({ user: { id: 'u1' } }) }
  ]

  await runPipeline(steps, () => undefined, makeCtx())

  expect(sawInPre).toBeUndefined()
  expect(sawInPost).toEqual({ id: 'u1' })
})

test('provide → use → provide → handler: use only sees what came before it (pre-code)', async () => {
  let sawUserInPre: unknown
  let sawPermissionsInPre: unknown
  let sawPermissionsInPost: unknown

  const steps: Step[] = [
    { kind: 'provide', fn: () => ({ user: { id: 'u1' } }) },
    {
      kind: 'use',
      fn: async (ctx, next) => {
        const c = ctx as unknown as { user: unknown; permissions: unknown }
        sawUserInPre = c.user
        sawPermissionsInPre = c.permissions // registered before the second provide()
        await next()
        sawPermissionsInPost = c.permissions // it already ran by now
      }
    },
    { kind: 'provide', fn: () => ({ permissions: ['admin'] }) }
  ]
  const ctx = makeCtx()

  const body = await runPipeline(
    steps,
    c => {
      const typed = c as unknown as { user: unknown; permissions: unknown }
      return { user: typed.user, permissions: typed.permissions }
    },
    ctx
  )

  expect(sawUserInPre).toEqual({ id: 'u1' })
  expect(sawPermissionsInPre).toBeUndefined() // the critical assertion
  expect(sawPermissionsInPost).toEqual(['admin'])
  expect(body).toEqual({ user: { id: 'u1' }, permissions: ['admin'] })
})

test('a throwing provide() propagates, catchable by an outer use() with try/catch', async () => {
  const steps: Step[] = [
    {
      kind: 'use',
      fn: async (_ctx, next) => {
        try {
          await next()
        } catch (err) {
          return { caught: (err as Error).message }
        }
      }
    },
    {
      kind: 'provide',
      fn: () => {
        throw new Error('auth failed')
      }
    }
  ]

  const body = await runPipeline(steps, () => undefined, makeCtx())

  expect(body).toEqual({ caught: 'auth failed' })
})

test('async provide(): the value is available once it resolves', async () => {
  const steps: Step[] = [
    {
      kind: 'provide',
      fn: async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
        return { user: { id: 'delayed' } }
      }
    }
  ]
  const ctx = makeCtx()

  await runPipeline(steps, () => undefined, ctx)

  expect((ctx as unknown as { user: unknown }).user).toEqual({ id: 'delayed' })
})

test('short-circuit in a use() blocks any provide() registered after it', async () => {
  let laterProvideRan = false
  const steps: Step[] = [
    { kind: 'provide', fn: () => ({ user: { id: 'u1' } }) },
    { kind: 'use', fn: () => ({ blocked: true }) }, // never calls next()
    {
      kind: 'provide',
      fn: () => {
        laterProvideRan = true
        return { permissions: ['admin'] }
      }
    }
  ]
  const ctx = makeCtx()
  let handlerCalled = false

  const body = await runPipeline(
    steps,
    () => {
      handlerCalled = true
      return { fromHandler: true }
    },
    ctx
  )

  expect(handlerCalled).toBe(false)
  expect(laterProvideRan).toBe(false)
  expect(
    (ctx as unknown as { permissions: unknown }).permissions
  ).toBeUndefined()
  expect(body).toEqual({ blocked: true })
})

test('concurrent requests through the same steps array do not cross-contaminate', async () => {
  // Same `steps` reused across "requests" (mirrors the real Arcton() closure
  // model: provide()/use() registered once, run per request). Different
  // delays on purpose — if anything were shared instead of per-ctx, the
  // faster request resolving first would corrupt the slower one's result.
  const steps: Step[] = [
    {
      kind: 'provide',
      fn: async (ctx: Context) => {
        const delay = ctx.request.headers.get('x-delay')
        await new Promise(resolve => setTimeout(resolve, Number(delay)))
        return { user: { id: ctx.request.headers.get('x-user') } }
      }
    }
  ]

  function makeRequestCtx(user: string, delay: number): Context {
    return {
      ...makeCtx(),
      request: new Request('http://localhost/', {
        headers: { 'x-user': user, 'x-delay': String(delay) }
      })
    }
  }

  const ctxSlow = makeRequestCtx('slow-user', 20)
  const ctxFast = makeRequestCtx('fast-user', 1)

  const [slowBody, fastBody] = await Promise.all([
    runPipeline(
      steps,
      c => ({ id: (c as unknown as { user: { id: string } }).user.id }),
      ctxSlow
    ),
    runPipeline(
      steps,
      c => ({ id: (c as unknown as { user: { id: string } }).user.id }),
      ctxFast
    )
  ])

  expect(slowBody).toEqual({ id: 'slow-user' })
  expect(fastBody).toEqual({ id: 'fast-user' })
  expect((ctxSlow as unknown as { user: unknown }).user).toEqual({
    id: 'slow-user'
  })
  expect((ctxFast as unknown as { user: unknown }).user).toEqual({
    id: 'fast-user'
  })
})

test('route-level middleware appended to a global-steps snapshot sees what was already provided', async () => {
  // Mirrors how Arcton's route() actually builds a route's composed
  // handler (packages/core/src/index.ts): route-level middleware is
  // appended as 'use' steps to a *snapshot* of the global steps taken at
  // registration time — one flat runPipeline call, not a nested compose().
  // Snapshotting (not reading the live global `steps` array) is what gives
  // registration-order semantics: a route only ever sees use()/provide()
  // calls that happened before it was registered.
  const routeMiddleware = async (ctx: Context, next: () => Promise<void>) => {
    expect((ctx as unknown as { user: unknown }).user).toEqual({ id: 'u1' })
    await next()
  }
  const routeHandler = (ctx: Context) => ({
    userId: (ctx as unknown as { user: { id: string } }).user.id
  })

  const globalStepsAtRegistration: Step[] = [
    { kind: 'provide', fn: () => ({ user: { id: 'u1' } }) }
  ]
  const routeSteps: Step[] = [
    ...globalStepsAtRegistration,
    { kind: 'use', fn: routeMiddleware }
  ]
  const ctx = makeCtx()

  const body = await runPipeline(routeSteps, routeHandler, ctx)

  expect(body).toEqual({ userId: 'u1' })
})

// ── validate step ─────────────────────────────────────────────────────────

test('validate: a params schema overwrites ctx.params with its output, never the raw value', async () => {
  const steps: Step[] = [
    {
      kind: 'validate',
      params: fakeSchema((p: Record<string, string>) => ({ id: Number(p.id) }))
    }
  ]
  const ctx = makeCtx({ params: { id: '42' } })

  const body = await runPipeline(steps, c => ({ id: c.params }), ctx)

  expect(body).toEqual({ id: { id: 42 } })
  expect(ctx.params as unknown).toEqual({ id: 42 })
})

test('validate: a failing params schema short-circuits with 400 and the issues, handler does not run', async () => {
  const steps: Step[] = [
    { kind: 'validate', params: failingSchema('id must be numeric') }
  ]
  let handlerCalled = false

  const body = await runPipeline(
    steps,
    () => {
      handlerCalled = true
      return { ok: true }
    },
    makeCtx()
  )

  expect(handlerCalled).toBe(false)
  expect(body).toBeInstanceOf(Response)
  expect((body as Response).status).toBe(400)
  expect(await (body as Response).json()).toEqual({
    issues: [{ message: 'id must be numeric' }]
  })
})

test('validate: query schema behaves the same as params', async () => {
  const steps: Step[] = [
    {
      kind: 'validate',
      query: fakeSchema((q: Record<string, string>) => ({
        limit: Number(q.limit)
      }))
    }
  ]
  const ctx = makeCtx({ query: { limit: '10' } })

  await runPipeline(steps, () => undefined, ctx)

  expect(ctx.query as unknown).toEqual({ limit: 10 })
})

test('validate: a body schema reads+validates a JSON request body into ctx.body', async () => {
  const steps: Step[] = [
    {
      kind: 'validate',
      body: fakeSchema((b: { name: string }) => ({
        name: b.name.toUpperCase()
      }))
    }
  ]
  const ctx = makeCtx({
    request: new Request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ivan' })
    })
  })

  const body = await runPipeline(
    steps,
    c => ({ name: (c as unknown as { body: { name: string } }).body.name }),
    ctx
  )

  expect(body).toEqual({ name: 'IVAN' })
})

test('validate: an unsupported body content-type short-circuits with 415, before validate() ever runs', async () => {
  let schemaCalled = false
  const steps: Step[] = [
    {
      kind: 'validate',
      body: fakeSchema((b: unknown) => {
        schemaCalled = true
        return b
      })
    }
  ]
  const ctx = makeCtx({
    request: new Request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/xml' },
      body: 'irrelevant'
    })
  })

  const body = await runPipeline(steps, () => undefined, ctx)

  expect(schemaCalled).toBe(false)
  expect(body).toBeInstanceOf(Response)
  expect((body as Response).status).toBe(415)
})

test('validate: malformed JSON with a JSON content-type short-circuits with 400 issues, not a thrown error', async () => {
  let schemaCalled = false
  const steps: Step[] = [
    {
      kind: 'validate',
      body: fakeSchema((b: unknown) => {
        schemaCalled = true
        return b
      })
    }
  ]
  const ctx = makeCtx({
    request: new Request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json'
    })
  })

  const body = await runPipeline(steps, () => undefined, ctx)

  expect(schemaCalled).toBe(false)
  expect(body).toBeInstanceOf(Response)
  expect((body as Response).status).toBe(400)
  expect(await (body as Response).json()).toEqual({
    issues: [{ message: 'Invalid request body' }]
  })
})

test('validate: params, query and body run together, in that order, all overwriting ctx', async () => {
  const steps: Step[] = [
    {
      kind: 'validate',
      params: fakeSchema((p: Record<string, string>) => ({ id: Number(p.id) })),
      query: fakeSchema((q: Record<string, string>) => ({
        limit: Number(q.limit)
      })),
      body: fakeSchema((b: { name: string }) => ({ name: b.name }))
    }
  ]
  const ctx = makeCtx({
    params: { id: '1' },
    query: { limit: '5' },
    request: new Request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ivan' })
    })
  })

  await runPipeline(steps, () => undefined, ctx)

  expect(ctx.params as unknown).toEqual({ id: 1 })
  expect(ctx.query as unknown).toEqual({ limit: 5 })
  expect((ctx as unknown as { body: unknown }).body).toEqual({ name: 'Ivan' })
})

test('validate: async schema.validate() is awaited before continuing', async () => {
  const asyncSchema: StandardSchemaV1<
    Record<string, string>,
    { id: number }
  > = {
    '~standard': {
      version: 1,
      vendor: 'fake',
      validate: async (v: unknown) => {
        await new Promise(resolve => setTimeout(resolve, 5))
        return { value: { id: Number((v as Record<string, string>).id) } }
      }
    }
  }
  const steps: Step[] = [{ kind: 'validate', params: asyncSchema }]
  const ctx = makeCtx({ params: { id: '7' } })

  await runPipeline(steps, () => undefined, ctx)

  expect(ctx.params as unknown).toEqual({ id: 7 })
})

test('validate: runs after global provide()/use(), before route-level middleware', async () => {
  const order: string[] = []
  const steps: Step[] = [
    {
      kind: 'provide',
      fn: () => {
        order.push('provide')
        return {}
      }
    },
    {
      kind: 'use',
      fn: async (_ctx, next) => {
        order.push('global-use')
        await next()
      }
    },
    {
      kind: 'validate',
      params: fakeSchema((p: Record<string, string>) => {
        order.push('validate')
        return p
      })
    },
    {
      kind: 'use',
      fn: async (_ctx, next) => {
        order.push('route-middleware')
        await next()
      }
    }
  ]

  await runPipeline(
    steps,
    () => {
      order.push('handler')
    },
    makeCtx()
  )

  expect(order).toEqual([
    'provide',
    'global-use',
    'validate',
    'route-middleware',
    'handler'
  ])
})
