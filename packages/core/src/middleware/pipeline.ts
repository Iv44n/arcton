import type {
  Body,
  BodyParser,
  Context,
  Middleware,
  RouteHandler,
  StandardSchemaV1
} from '@arcton/contracts'
import {
  defaultErrorResponse,
  isRequestError,
  UnsupportedMediaTypeError,
  ValidationError
} from '../errors'
import { mapResponse } from '../router/serialize'
import { DEFAULT_BODY_MEDIA_TYPE, normalizeMediaType, parseBody } from './body'

type ErrorDispatch = (err: unknown) => Promise<Response>

const errorDispatchers = new WeakMap<Context, ErrorDispatch>()

export function bindErrorDispatch(ctx: Context, dispatch: ErrorDispatch): void {
  errorDispatchers.set(ctx, dispatch)
}

export type Step =
  | { kind: 'provide'; fn: (ctx: Context) => unknown | Promise<unknown> }
  | { kind: 'use'; fn: Middleware; scope?: string }
  | {
      kind: 'validate'
      params?: StandardSchemaV1
      query?: StandardSchemaV1
      body?: StandardSchemaV1
      bodyContent?: Record<string, StandardSchemaV1>
      bodyOptional?: boolean
    }

// provide()/use()/route validation share one registration-order sequence.
// - A 'provide' step is transparent: merges its result into the same ctx
//   object and continues immediately — no pre/post of its own, no next().
// - A 'use' step keeps full onion semantics: next()/body-closure, can
//   short-circuit, observe/mutate ctx.response, etc.
// - A 'validate' step runs each declared schema against the current
//   params/query/body, in that order, and overwrites ctx with the
//   validated output — never the raw pre-validation value. The first
//   failing schema raises a ValidationError (or an UnsupportedMediaTypeError
//   for an unsupported body Content-Type), answered right there — via the
//   onError() dispatch bound to ctx, else its default 400/415 — and
//   short-circuits like a middleware that returns a Body without calling
//   next(): nothing downstream runs, and enclosing middleware sees a normal
//   response.
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
  ctx: Context,
  customParsers: ReadonlyMap<string, BodyParser> = new Map()
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
      return runValidation(step, ctx, customParsers).then(
        () => next(),
        err => {
          if (!isRequestError(err)) throw err
          const dispatch = errorDispatchers.get(ctx)
          return Promise.resolve(
            dispatch ? dispatch(err) : defaultErrorResponse(err)
          ).then(response => {
            body = response // short-circuit: no next() call, mapResponse passes it through as-is
            materialize(response)
          })
        }
      )
    }
    // A fresh, single-use wrapper per 'use' step — calling it a second time
    // rejects instead of silently re-running everything downstream again.
    // `nextSettled` tracks whether that one call has resolved/rejected by
    // the time *this* middleware's own function returns — attached here,
    // before the promise is handed back, so it fires regardless of whether
    // the middleware ever awaits it (a fire-and-forget `next()` call, with
    // no `await`/`return`, otherwise races the downstream chain against the
    // response this step is about to produce).
    let calledNext = false
    let nextSettled = false
    let outerChecked = false
    const guardedNext = (): Promise<void> => {
      if (calledNext) {
        const rejected = Promise.reject(
          new Error('next() was already called by this middleware')
        )
        rejected.catch(() => {}) // don't let an unobserved 2nd call crash the process too
        return rejected
      }
      calledNext = true
      let pending: Promise<void>
      try {
        pending = next()
      } catch (err) {
        // next() can throw synchronously (e.g. a handler that throws
        // synchronously rather than rejecting a promise) — settled right
        // then, by definition, since there was never an async gap for a
        // fire-and-forget race to happen in.
        nextSettled = true
        const rejected = Promise.reject(err)
        rejected.catch(() => {}) // don't let an unobserved caller crash the process too
        return rejected
      }
      pending.then(
        () => {
          nextSettled = true
        },
        err => {
          nextSettled = true
          // Only the fire-and-forget path reaches here after outerChecked
          // is already true — a properly awaited/returned next() always
          // settles first, so this never fires for correct middleware.
          if (outerChecked) {
            console.error(
              "Arcton: a middleware's next() call rejected after the " +
                'middleware itself had already returned (fire-and-forget):',
              err
            )
          }
        }
      )
      return pending
    }

    return Promise.resolve(step.fn(ctx, guardedNext)).then(result => {
      outerChecked = true
      // Every middleware either calls next() (continue) or returns a body/
      // Response (short-circuit) — neither is a state the pipeline contract
      // has a meaning for, so it's always a bug, never a legitimate no-op.
      if (!calledNext && result === undefined) {
        throw new Error(
          'Middleware completed without calling next() or returning a response'
        )
      }
      if (calledNext && !nextSettled) {
        throw new Error(
          'Middleware returned before its own next() call finished — did you forget to await it?'
        )
      }
      if (result !== undefined) {
        body = result
        materialize(result)
      }
    })
  }

  return next().then(() => body)
}

// Throws a ValidationError / UnsupportedMediaTypeError on the first failure.
async function runValidation(
  step: Extract<Step, { kind: 'validate' }>,
  ctx: Context,
  customParsers: ReadonlyMap<string, BodyParser>
): Promise<void> {
  const mutableCtx = ctx as unknown as Record<string, unknown>

  if (step.params) {
    const result = await step.params['~standard'].validate(ctx.params)
    if (result.issues) throw new ValidationError(result.issues)
    mutableCtx.params = result.value
  }

  if (step.query) {
    const result = await step.query['~standard'].validate(ctx.query)
    if (result.issues) throw new ValidationError(result.issues)
    mutableCtx.query = result.value
  }

  if (
    (step.body || step.bodyContent) &&
    step.bodyOptional &&
    ctx.request.body === null
  ) {
    mutableCtx.body = undefined
    if (step.bodyContent) mutableCtx.contentType = undefined
  } else if (step.body || step.bodyContent) {
    const mediaType = normalizeMediaType(
      ctx.request.headers.get('content-type') ?? ''
    )
    const schema = step.bodyContent
      ? Object.hasOwn(step.bodyContent, mediaType)
        ? step.bodyContent[mediaType]
        : undefined
      : mediaType === DEFAULT_BODY_MEDIA_TYPE
        ? step.body
        : undefined
    if (!schema) throw new UnsupportedMediaTypeError()

    const parsed = await parseBody(ctx.request, customParsers)
    if (!parsed.ok) {
      throw parsed.reason === 'invalid-body'
        ? new ValidationError([{ message: 'Invalid request body' }])
        : new UnsupportedMediaTypeError()
    }

    const result = await schema['~standard'].validate(parsed.value)
    if (result.issues) throw new ValidationError(result.issues)
    mutableCtx.body = result.value
    if (step.bodyContent) mutableCtx.contentType = mediaType
  }
}
