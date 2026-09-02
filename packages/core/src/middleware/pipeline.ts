import type {
  Body,
  Context,
  Middleware,
  RouteHandler,
  StandardSchemaV1
} from '@arcton/contracts'
import { mapResponse } from '../router/serialize'
import { parseBody } from './body'

export type Step =
  | { kind: 'provide'; fn: (ctx: Context) => unknown | Promise<unknown> }
  | { kind: 'use'; fn: Middleware; scope?: string }
  | {
      kind: 'validate'
      params?: StandardSchemaV1
      query?: StandardSchemaV1
      body?: StandardSchemaV1
    }

// provide()/use()/route validation share one registration-order sequence.
// - A 'provide' step is transparent: merges its result into the same ctx
//   object and continues immediately — no pre/post of its own, no next().
// - A 'use' step keeps full onion semantics: next()/body-closure, can
//   short-circuit, observe/mutate ctx.response, etc.
// - A 'validate' step runs each declared schema against the current
//   params/query/body, in that order, and overwrites ctx with the
//   validated output — never the raw pre-validation value. The first
//   failing schema short-circuits with a 400 (or 415 for an unsupported
//   body Content-Type) — same short-circuit mechanism as a middleware that
//   returns a Body without calling next(): it doesn't call next(), so
//   nothing downstream (route-level middleware, handler) runs.
// Runtime visibility here matches what ArctonApp<TProvided> promises at the
// type level exactly, not just conservatively: order of registration
// determines both what each step's type sees and what it actually gets at
// request time, because they're the same array walked in the same order.
//
// Every time a body finalizes at some layer (the handler resolving, a step
// short-circuiting, or a step replacing the body after next()), ctx.response
// is immediately materialized into the real Response via mapResponse — using
// whatever ctx.response already holds as the base, so headers an inner layer
// already set survive a later replace. A raw Response always wins outright
// (mapResponse's own escape-hatch rule), at any layer, not just the
// outermost. Materializing before unwinding to the next layer out is what
// lets post-next() middleware mutate ctx.response.headers and have it stick
// — but status/statusText have no setter on a real Response, so they can
// only be set before this point (by the handler or by pre-next() code),
// never overridden by a post-next() layer once materialized.
export function runPipeline(
  steps: Step[],
  handler: RouteHandler,
  ctx: Context
): Promise<Body | void> {
  // Fast path: no provide()/use()/validate registered — same shape and
  // cost as calling the handler directly. ctx.response is never touched
  // here; the caller (Arcton's fetch handler) materializes it instead.
  if (steps.length === 0) return Promise.resolve(handler(ctx))

  let i = 0
  let body: Body | void

  function materialize(result: Body | void): void {
    ctx.response = mapResponse(result, ctx.response)
  }

  function next(): Promise<void> {
    const step = steps[i++]
    if (step === undefined) {
      return Promise.resolve(handler(ctx)).then(result => {
        body = result
        materialize(result)
      })
    }
    if (step.kind === 'provide') {
      return Promise.resolve(step.fn(ctx)).then(provided => {
        Object.assign(ctx, provided)
        return next()
      })
    }
    if (step.kind === 'validate') {
      return runValidation(step, ctx).then(failure => {
        if (failure !== undefined) {
          body = failure // short-circuit: no next() call, mapResponse passes it through as-is
          materialize(failure)
          return
        }
        return next()
      })
    }
    return Promise.resolve(step.fn(ctx, next)).then(result => {
      if (result !== undefined) {
        body = result
        materialize(result)
      }
    })
  }

  return next().then(() => body)
}

// Returns a Response if validation failed (the pipeline should short-circuit
// with it), or undefined on success (ctx has already been overwritten with
// the validated params/query/body — the caller just continues the chain).
async function runValidation(
  step: Extract<Step, { kind: 'validate' }>,
  ctx: Context
): Promise<Response | undefined> {
  const mutableCtx = ctx as unknown as Record<string, unknown>

  if (step.params) {
    const result = await step.params['~standard'].validate(ctx.params)
    if (result.issues) return issuesResponse(result.issues)
    mutableCtx.params = result.value
  }

  if (step.query) {
    const result = await step.query['~standard'].validate(ctx.query)
    if (result.issues) return issuesResponse(result.issues)
    mutableCtx.query = result.value
  }

  if (step.body) {
    const parsed = await parseBody(ctx.request)
    if (!parsed.ok) {
      return parsed.reason === 'invalid-json'
        ? issuesResponse([{ message: 'Invalid JSON body' }])
        : new Response(null, { status: 415 })
    }

    const result = await step.body['~standard'].validate(parsed.value)
    if (result.issues) return issuesResponse(result.issues)
    mutableCtx.body = result.value
  }

  return undefined
}

function issuesResponse(
  issues: ReadonlyArray<StandardSchemaV1.Issue>
): Response {
  return new Response(JSON.stringify({ issues }), {
    status: 400,
    headers: { 'content-type': 'application/json' }
  })
}
