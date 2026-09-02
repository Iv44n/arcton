import type { Middleware } from '@arcton/contracts'
import { Arcton } from '@arcton/core'
import * as v from 'valibot'

const app = Arcton({ port: 3002, env: 'development' })

app.use(async (ctx, next) => {
  console.log(`→ ${ctx.request.method} ${new URL(ctx.request.url).pathname}`)
  await next()
})

app.use(async (ctx, next) => {
  const start = performance.now()
  await next()
  ctx.response.headers.set(
    'X-Response-Time',
    `${(performance.now() - start).toFixed(2)}ms`
  )
})

app.get('/', () => ({ message: 'Welcome to Arcton' }))

const withRequestId: Middleware = async (ctx, next) => {
  ctx.response.headers.set('X-Request-Id', crypto.randomUUID())
  await next()
}

app.get('/health', withRequestId, () => ({ status: 'ok' }))

app.get(
  '/text',
  () =>
    new Response('Hello from Arcton!\n', {
      headers: { 'content-type': 'text/plain' }
    })
)

app.post('/echo', async ctx => ({
  received: await ctx.request.json().catch(() => null)
}))

app.get('/users/:id', ctx => ({ id: ctx.params.id }))

app.post('/users/:id/orders', {
  params: v.object({ id: v.pipe(v.string(), v.transform(Number), v.number()) }),
  query: v.object({
    notify: v.optional(
      v.pipe(
        v.string(),
        v.transform(s => s === 'true'),
        v.boolean()
      )
    )
  }),
  body: v.object({
    item: v.pipe(v.string(), v.minLength(1)),
    quantity: v.pipe(v.number(), v.integer(), v.minValue(1))
  }),
  middleware: [
    async (ctx, next) => {
      console.log(
        `order: user=${ctx.params.id} item=${ctx.body.item} qty=${ctx.body.quantity}`
      )
      await next()
    }
  ],
  handler: ctx => {
    return {
      userId: ctx.params.id,
      notify: ctx.query.notify ?? false,
      order: ctx.body
    }
  }
})

const files: Record<string, string> = {
  'a/b.txt': 'contents of a/b.txt',
  'readme.md': '# Arcton example'
}

app.get('/files/*path', ctx => {
  const segments = ctx.params.path.split('/')
  const isUnsafe = segments.some(segment => segment === '..' || segment === '')
  if (isUnsafe) {
    return new Response('Invalid path', { status: 400 })
  }

  const content = files[ctx.params.path]
  if (content === undefined) {
    return new Response('Not found', { status: 404 })
  }

  return new Response(content, {
    headers: { 'content-type': 'text/plain' }
  })
})

app
  .use(async (_ctx, next) => {
    console.log('auth middlewareeeeee')
    await next()
  })
  .provide(ctx => {
    const authToken = ctx.request.headers.get('authorization')

    return {
      user: authToken === 'secret' ? { id: 1, name: 'Alice' } : null,
      permissions: authToken === 'secret' ? ['read', 'write'] : null
    }
  })
  .get(
    '/profile',
    async (ctx, next) => {
      if (!ctx.user) return new Response('Unauthorized', { status: 401 })
      await next()
    },
    ctx => ({
      user: ctx.user,
      permissions: ctx.permissions
    })
  )

app.ws('/chat', {
  open(ws) {
    ws.send('connected')
  },
  message(ws, message) {
    ws.send(`echo: ${message}`)
  },
  close(_ws, code, reason) {
    console.log('chat closed', code, reason)
  }
})

app.listen()
