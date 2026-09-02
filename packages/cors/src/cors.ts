import type { Middleware } from '@arcton/contracts'

export type CorsOrigin =
  | '*'
  | string
  | string[]
  | ((origin: string, request: Request) => boolean)

export interface CorsOptions {
  origin?: CorsOrigin
  methods?: string[]
  allowedHeaders?: string[]
  exposedHeaders?: string[]
  credentials?: boolean
  maxAge?: number
  preflight?: boolean
}

function isOriginAllowed(
  origin: CorsOrigin,
  requestOrigin: string,
  request: Request
): boolean {
  if (origin === '*') return true
  if (typeof origin === 'string') return origin === requestOrigin
  if (Array.isArray(origin)) return origin.includes(requestOrigin)
  return origin(requestOrigin, request)
}

// Access-Control-Allow-Origin can't be "*" for every request whose Origin
// varies (an array or a function) without breaking caching — Vary: Origin
// tells a cache the response depends on the request's Origin, not just its
// URL. Not needed for the "*" case: that response never varies by origin.
function applyOriginHeaders(
  headers: Headers,
  origin: CorsOrigin,
  requestOrigin: string
): void {
  if (origin === '*') {
    headers.set('Access-Control-Allow-Origin', '*')
    return
  }
  headers.set('Access-Control-Allow-Origin', requestOrigin)
  headers.append('Vary', 'Origin')
}

export function cors(options: CorsOptions = {}): Middleware {
  const origin = options.origin ?? '*'
  const credentials = options.credentials ?? false
  const preflight = options.preflight ?? true
  const { methods, allowedHeaders, exposedHeaders, maxAge } = options

  // A credentialed response can't use the wildcard — the browser rejects
  // it. Checked once here, at setup, not per-request.
  if (origin === '*' && credentials) {
    throw new TypeError(
      'CORS: credentials cannot be enabled when origin is "*"'
    )
  }

  return async (ctx, next) => {
    const requestOrigin = ctx.request.headers.get('origin')
    if (requestOrigin === null) return next() // not a CORS request at all

    const allowed = isOriginAllowed(origin, requestOrigin, ctx.request)

    // Access-Control-Request-Method is what makes an OPTIONS request an
    // actual CORS preflight, not just a plain OPTIONS a route might handle
    // itself (e.g. app.options(path, handler)) — only that gets intercepted.
    const isPreflight =
      preflight &&
      ctx.request.method === 'OPTIONS' &&
      ctx.request.headers.has('access-control-request-method')

    if (isPreflight) {
      // Origin rejected: no CORS headers, so the browser blocks the actual
      // request client-side — not Arcton's job to report why.
      if (!allowed) return new Response(null, { status: 204 })

      const headers = new Headers()
      applyOriginHeaders(headers, origin, requestOrigin)
      headers.set(
        'Access-Control-Allow-Methods',
        methods?.join(', ') ??
          ctx.request.headers.get('access-control-request-method') ??
          ''
      )
      const requestedHeaders =
        allowedHeaders?.join(', ') ??
        ctx.request.headers.get('access-control-request-headers')
      if (requestedHeaders) {
        headers.set('Access-Control-Allow-Headers', requestedHeaders)
      }
      if (credentials) headers.set('Access-Control-Allow-Credentials', 'true')
      if (maxAge !== undefined) {
        headers.set('Access-Control-Max-Age', String(maxAge))
      }

      return new Response(null, { status: 204, headers })
    }

    if (!allowed) return next()

    await next()

    applyOriginHeaders(ctx.response.headers, origin, requestOrigin)
    if (credentials) {
      ctx.response.headers.set('Access-Control-Allow-Credentials', 'true')
    }
    if (exposedHeaders && exposedHeaders.length > 0) {
      ctx.response.headers.set(
        'Access-Control-Expose-Headers',
        exposedHeaders.join(', ')
      )
    }
  }
}
