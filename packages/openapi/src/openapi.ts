import type { RouteAwareMiddleware, RouteRecord } from '@arcton/contracts'
import { buildDocument, type DocumentOptions } from './document'
import { renderScalar, type ScalarOptions } from './scalar'

export interface OpenAPIOptions extends DocumentOptions {
  /** Where the document is served. Defaults to `/openapi.json`. */
  document?: { path?: string }
  /**
   * Where the Scalar UI is served. Defaults to `/docs`; `false` serves the
   * document alone.
   */
  docs?: (ScalarOptions & { path?: string }) | false
}

// The router ignores a trailing slash, so `/docs/` must reach the same page.
function normalizePath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

/**
 * Serves an OpenAPI 3.1 document, and a Scalar UI reading it, for the routes
 * of the app it is registered on:
 *
 * ```ts
 * app.use(openapi({ info: { title: 'API', version: '1.0.0' } }))
 * ```
 *
 * Both are generated once, on the first request that reaches them — never
 * per request, and after every module has been mounted.
 */
export function openapi(options: OpenAPIOptions): RouteAwareMiddleware {
  const documentPath = normalizePath(options.document?.path ?? '/openapi.json')
  const docs = options.docs === false ? undefined : (options.docs ?? {})
  const docsPath = docs ? normalizePath(docs.path ?? '/docs') : undefined

  let readRoutes: (() => readonly RouteRecord[]) | undefined
  let documentBody: string | undefined
  let docsHtml: string | undefined

  const middleware: RouteAwareMiddleware = Object.assign(
    ((ctx, next) => {
      if (ctx.request.method !== 'GET') return next()

      const path = normalizePath(new URL(ctx.request.url).pathname)

      if (path === documentPath) {
        if (documentBody === undefined) {
          if (!readRoutes) {
            throw new Error('openapi() must be registered with app.use()')
          }
          documentBody = JSON.stringify(buildDocument(readRoutes(), options))
        }
        return new Response(documentBody, {
          headers: { 'content-type': 'application/json; charset=utf-8' }
        })
      }

      if (docs && path === docsPath) {
        docsHtml ??= renderScalar(documentPath, docs)
        return new Response(docsHtml, {
          headers: { 'content-type': 'text/html; charset=utf-8' }
        })
      }

      return next()
    }) as RouteAwareMiddleware,
    {
      bindRoutes(routes: () => readonly RouteRecord[]) {
        readRoutes = routes
      }
    }
  )

  return middleware
}
