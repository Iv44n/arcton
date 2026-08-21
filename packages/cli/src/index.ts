#!/usr/bin/env bun
import { createApp } from '@lior/core'

const [command] = Bun.argv.slice(2)

switch (command) {
  case 'dev':
  case 'start': {
    const app = createApp()
    const server = app.listen()
    console.log(`Lior listening on ${server.url}`)
    break
  }
  default:
    console.log('Usage: lior <dev|start>')
}
