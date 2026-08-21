import { createApp } from '@lior/core'

const app = createApp({ port: 3001 })
const server = app.listen()

console.log(`Example app running at ${server.url}`)
