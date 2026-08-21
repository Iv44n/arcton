import { createApp } from '@arcton/core'

const app = createApp()
const server = app.listen()

console.log(`Running at ${server.url}`)
