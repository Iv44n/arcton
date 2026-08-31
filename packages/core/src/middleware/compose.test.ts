import { expect, test } from 'bun:test'
import type { Body, Context, Middleware, RouteHandler } from '@arcton/contracts'
import { mapResponse } from '../router/serialize'
import { compose } from './compose'

function makeCtx(): Context {
  return {
    request: new Request('http://localhost/'),
    params: {},
    query: {},
    response: { headers: new Headers() },
    state: {}
  }
}

test('empty chain uses the fast path: promise identity with an async handler', () => {
  // An async handler wraps its return in a NEW promise on every call, so
  // calling it twice to compare identity doesn't work. The only way to
  // observe `Promise.resolve(p) === p` from the outside is to memoize the
  // promise once and have the (non-async) handler always return that same
  // reference.
  const cachedPromise = Promise.resolve<Body | void>({ ok: true })
  const handler: RouteHandler = () => cachedPromise

  const result = compose([], handler, makeCtx())

  expect(result).toBe(cachedPromise)
})

test('pre/post order: mw1-pre → mw2-pre → handler → mw2-post → mw1-post', async () => {
  const order: string[] = []
  const mw1: Middleware = async (_ctx, next) => {
    order.push('mw1-pre')
    await next()
    order.push('mw1-post')
  }
  const mw2: Middleware = async (_ctx, next) => {
    order.push('mw2-pre')
    await next()
    order.push('mw2-post')
  }
  const handler: RouteHandler = () => {
    order.push('handler')
  }

  await compose([mw1, mw2], handler, makeCtx())

  expect(order).toEqual([
    'mw1-pre',
    'mw2-pre',
    'handler',
    'mw2-post',
    'mw1-post'
  ])
})

test("short-circuit: mw returns a Body without calling next → handler does not run, body = mw's", async () => {
  let handlerCalled = false
  const mw: Middleware = () => ({ shortCircuited: true })
  const handler: RouteHandler = () => {
    handlerCalled = true
    return { fromHandler: true }
  }

  const body = await compose([mw], handler, makeCtx())

  expect(handlerCalled).toBe(false)
  expect(body).toEqual({ shortCircuited: true })
})

test('short-circuit with a Response: body is the exact Response instance (identity)', async () => {
  const response = new Response('ok')
  const mw: Middleware = () => response
  const handler: RouteHandler = () => ({ fromHandler: true })

  const body = await compose([mw], handler, makeCtx())

  expect(body).toBe(response)
})

test("passthrough: mw calls next() and returns void → body = handler's", async () => {
  const mw: Middleware = async (_ctx, next) => {
    await next()
  }
  const handler: RouteHandler = () => ({ fromHandler: true })

  const body = await compose([mw], handler, makeCtx())

  expect(body).toEqual({ fromHandler: true })
})

test("replace: mw calls next() and returns a Body → body = mw's (the return wins)", async () => {
  const mw: Middleware = async (_ctx, next) => {
    await next()
    return { fromMw: true }
  }
  const handler: RouteHandler = () => ({ fromHandler: true })

  const body = await compose([mw], handler, makeCtx())

  expect(body).toEqual({ fromMw: true })
})

test('post-handler mutation: ctx.response.status set after next() is honored by mapResponse', async () => {
  const ctx = makeCtx()
  const mw: Middleware = async (c, next) => {
    await next()
    c.response.status = 204
  }
  const handler: RouteHandler = () => undefined

  const body = await compose([mw], handler, ctx)
  // mapResponse is synchronous (returns Response, not Promise<Response>) — no await.
  const response = mapResponse(body, ctx.response)

  expect(response.status).toBe(204)
})

test('error: handler throw propagates, an outer mw with try/catch catches it', async () => {
  const handler: RouteHandler = () => {
    throw new Error('handler boom')
  }
  const mw: Middleware = async (_ctx, next) => {
    try {
      await next()
    } catch (err) {
      return { caught: (err as Error).message }
    }
  }

  const body = await compose([mw], handler, makeCtx())

  expect(body).toEqual({ caught: 'handler boom' })
})

test('throw in pre-code: mw2 throws before calling next() → propagates, catchable by outer mw1', async () => {
  const mw1: Middleware = async (_ctx, next) => {
    try {
      await next()
    } catch (err) {
      return { caught: (err as Error).message }
    }
  }
  const mw2: Middleware = () => {
    throw new Error('mw2 pre-code boom')
  }
  const handler: RouteHandler = () => ({ fromHandler: true })

  const body = await compose([mw1, mw2], handler, makeCtx())

  expect(body).toEqual({ caught: 'mw2 pre-code boom' })
})

test('throw in post-code: downstream already ran, mw2 throws after next() → still propagates', async () => {
  let handlerCalled = false
  const mw1: Middleware = async (_ctx, next) => {
    try {
      await next()
    } catch (err) {
      return { caught: (err as Error).message }
    }
  }
  const mw2: Middleware = async (_ctx, next) => {
    await next()
    throw new Error('mw2 post-code boom')
  }
  const handler: RouteHandler = () => {
    handlerCalled = true
  }

  const body = await compose([mw1, mw2], handler, makeCtx())

  expect(handlerCalled).toBe(true)
  expect(body).toEqual({ caught: 'mw2 post-code boom' })
})

test("nested short-circuit: outer mw1 returns void, inner mw2 short-circuits → body is mw2's", async () => {
  let handlerCalled = false
  const mw1: Middleware = async (_ctx, next) => {
    await next()
  }
  const mw2: Middleware = () => ({ fromMw2: true })
  const handler: RouteHandler = () => {
    handlerCalled = true
  }

  const body = await compose([mw1, mw2], handler, makeCtx())

  expect(handlerCalled).toBe(false)
  expect(body).toEqual({ fromMw2: true })
})

test('multiple middleware: both return a Body → the outermost one wins', async () => {
  const mw1: Middleware = async (_ctx, next) => {
    await next()
    return { from: 'mw1' }
  }
  const mw2: Middleware = async (_ctx, next) => {
    await next()
    return { from: 'mw2' }
  }
  const handler: RouteHandler = () => ({ from: 'handler' })

  const body = await compose([mw1, mw2], handler, makeCtx())

  expect(body).toEqual({ from: 'mw1' })
})

test('next() not called: mw skips next → resolves void, body left unset', async () => {
  let handlerCalled = false
  const mw: Middleware = () => {}
  const handler: RouteHandler = () => {
    handlerCalled = true
    return { fromHandler: true }
  }

  const body = await compose([mw], handler, makeCtx())

  expect(handlerCalled).toBe(false)
  expect(body).toBeUndefined()
})

test('synchronous throw in an empty chain: a non-async handler that throws escapes compose(...) itself', () => {
  const handler: RouteHandler = () => {
    throw new Error('sync boom')
  }

  expect(() => compose([], handler, makeCtx())).toThrow('sync boom')
})

test('next() called twice (current behavior, not a guaranteed API): downstream runs twice', async () => {
  let handlerCalls = 0
  const mw: Middleware = async (_ctx, next) => {
    await next()
    await next()
  }
  const handler: RouteHandler = () => {
    handlerCalls++
  }

  await compose([mw], handler, makeCtx())

  expect(handlerCalls).toBe(2)
})
