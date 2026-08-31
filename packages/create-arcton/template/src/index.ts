import { Arcton } from '@arcton/core'

const app = Arcton()

app.get('/', () => {
  return 'Hello, Arcton!'
})

const server = app.listen()

console.log(`Running at ${server.url}`)
