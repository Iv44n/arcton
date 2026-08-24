import { Arcton } from '@arcton/core'

const app = Arcton({ port: 3001 })

app.get('/', () => ({ message: 'Welcome to Arcton' }))

app.get('/health', () => ({ status: 'ok' }))

app.get(
  '/text',
  () =>
    new Response('Hello from Arcton!\n', {
      headers: { 'content-type': 'text/plain' }
    })
)

app.post('/echo', async request => ({
  received: await request.json().catch(() => null)
}))

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

const server = app.listen()

console.log(`Example app running at ${server.url}`)
