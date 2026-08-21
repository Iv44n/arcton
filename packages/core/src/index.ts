import { bunAdapter } from '@lior/adapter-bun'
import type {
  RuntimeAdapter,
  RuntimeHandler,
  RuntimeServer
} from '@lior/contracts'
import figlet from 'figlet'

export interface LiorConfig {
  port?: number
  adapter?: RuntimeAdapter
}

export interface LiorApp {
  config: LiorConfig
  listen(port?: number): RuntimeServer
}

const defaultHandler: RuntimeHandler = () => new Response('Hello from Lior!')

export function createApp(config: LiorConfig = {}): LiorApp {
  const adapter = config.adapter ?? bunAdapter

  return {
    config,
    listen(port = config.port ?? 3000) {
      console.log(figlet.textSync('Lior'))
      return adapter.serve({ port, fetch: defaultHandler })
    }
  }
}
