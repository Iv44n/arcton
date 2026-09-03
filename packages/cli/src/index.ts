#!/usr/bin/env node
import type { RuntimeAdapter } from '@arcton/contracts'
import { runCreate } from './commands/create'

const [command, ...rest] = process.argv.slice(2)

// Picks the adapter by actual runtime, not @arcton/core's Bun-default.
async function resolveAdapter(): Promise<RuntimeAdapter> {
  if (typeof Bun !== 'undefined') {
    return (await import('@arcton/adapter-bun')).bunAdapter
  }
  return (await import('@arcton/adapter-node')).nodeAdapter
}

switch (command) {
  case 'create': {
    await runCreate(rest)
    break
  }
  case 'dev':
  case 'start': {
    // Lazy — create shouldn't depend on @arcton/core's loadability.
    const { Arcton } = await import('@arcton/core')
    const app = Arcton({ adapter: await resolveAdapter() })
    const server = app.listen()
    console.log(`Arcton listening on ${server.url}`)
    break
  }
  default:
    console.log('Usage: arcton <create|dev|start>')
}
