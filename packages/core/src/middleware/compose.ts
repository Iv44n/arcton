import type { Body, Context, Middleware, RouteHandler } from '@arcton/contracts'

// Executes [middleware..., handler] as an onion chain.
// - next() returns Promise<void>; the body flows back through the `body`
//   closure, not through next()'s return value.
// - If a middleware returns a Body, it overwrites `body` (short-circuit or
//   replace, depending on whether it also called next()).
// - If a middleware doesn't call next(), the downstream never runs.
export function compose(
  middleware: Middleware[],
  handler: RouteHandler,
  ctx: Context
): Promise<Body | void> {
  // Fast path: no middleware registered, same shape and cost as the
  // pre-middleware call site (Promise.resolve returns the same promise
  // instance when the handler is async).
  if (middleware.length === 0) return Promise.resolve(handler(ctx))

  let i = 0
  let body: Body | void

  function next(): Promise<void> {
    const layer = middleware[i++]
    if (layer === undefined) {
      return Promise.resolve(handler(ctx)).then(result => {
        body = result
      })
    }
    return Promise.resolve(layer(ctx, next)).then(result => {
      if (result !== undefined) body = result
    })
  }

  return next().then(() => body)
}
