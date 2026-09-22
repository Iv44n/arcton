// Spawned as a real subprocess by shutdown.e2e.test.ts.
import { Arcton } from '../index'

const app = Arcton()

app.get('/slow', async () => {
  console.log('SLOW_STARTED') // proof the request reached the handler
  await new Promise(resolve => setTimeout(resolve, 500))
  return { ok: true }
})

const server = app.listen({ port: 0 })
console.log(`PORT:${server.port}`)
