export type RuntimeHandler = (request: Request) => Response | Promise<Response>

export interface RuntimeServeOptions {
  fetch: RuntimeHandler
  port: number
  hostname?: string
}

export interface RuntimeServer {
  readonly port: number
  readonly url: URL
  stop(closeActiveConnections?: boolean): void | Promise<void>
}

export interface RuntimeAdapter {
  readonly name: string
  serve(options: RuntimeServeOptions): RuntimeServer
}
