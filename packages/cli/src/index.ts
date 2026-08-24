#!/usr/bin/env bun
import { Arcton } from '@arcton/core'

const [command] = Bun.argv.slice(2)

switch (command) {
  case 'dev':
  case 'start': {
    const app = Arcton()
    const server = app.listen()
    console.log(`Arcton listening on ${server.url}`)
    break
  }
  default:
    console.log('Usage: arcton <dev|start>')
}
