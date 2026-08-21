import { bunAdapter } from '@arcton/adapter-bun'
import type {
  RuntimeAdapter,
  RuntimeHandler,
  RuntimeServer
} from '@arcton/contracts'
import figlet from 'figlet'

export interface ArctonConfig {
  port?: number
  adapter?: RuntimeAdapter
}

export interface ArctonApp {
  config: ArctonConfig
  listen(port?: number): RuntimeServer
}

const defaultHandler: RuntimeHandler = () => new Response('Hello from Arcton!')

export function createApp(config: ArctonConfig = {}): ArctonApp {
  const adapter = config.adapter ?? bunAdapter

  return {
    config,
    listen(port = config.port ?? 3000) {
      console.log(figlet.textSync('Arcton'))
      return adapter.serve({ port, fetch: defaultHandler })
    }
  }
}
