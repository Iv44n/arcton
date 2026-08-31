import { Arcton } from '@arcton/core'

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

app.get('/health', () => ({ status: 'ok' }))

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
