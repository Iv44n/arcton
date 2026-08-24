import { Arcton } from '@arcton/core'

const app = Arcton()
const server = app.listen()

console.log(`Running at ${server.url}`)
