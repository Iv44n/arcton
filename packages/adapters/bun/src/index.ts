import type {
  RuntimeAdapter,
  RuntimeServeOptions,
  RuntimeServer
} from '@arcton/contracts'

export const bunAdapter: RuntimeAdapter = {
  name: 'bun',
  serve(options: RuntimeServeOptions): RuntimeServer {
    const server = Bun.serve({
      port: options.port,
      hostname: options.hostname,
      fetch: options.fetch
    })

    return {
      get port() {
        // undefined only applies to Bun's unix-socket mode, which this adapter never uses
        return server.port ?? options.port
      },
      get url() {
        return server.url
      },
      stop(closeActiveConnections) {
        return server.stop(closeActiveConnections)
      }
    }
  }
}
