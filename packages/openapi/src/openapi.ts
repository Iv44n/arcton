import type { DocumentRoute, OpenAPIIntegration } from '@arcton/contracts'
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

/**
 * Serves an OpenAPI 3.1 document, and a Scalar UI reading it, for the routes
 * an app ends up with:
 *
 * ```ts
 * app.listen({ openapi: openapi({ info: { title: 'API', version: '1.0.0' } }) })
 * ```
 *
 * Both are generated once, when `listen()` calls this — never per request.
 */
export function openapi(options: OpenAPIOptions): OpenAPIIntegration {
  const documentPath = options.document?.path ?? '/openapi.json'
  const docs = options.docs === false ? undefined : (options.docs ?? {})
  const docsPath = docs ? (docs.path ?? '/docs') : undefined

  return {
    routes(records) {
      const body = JSON.stringify(buildDocument(records, options))
      const routes: DocumentRoute[] = [
        {
          path: documentPath,
          handler: () =>
            new Response(body, {
              headers: { 'content-type': 'application/json; charset=utf-8' }
            })
        }
      ]

      if (docs && docsPath) {
        const html = renderScalar(documentPath, docs)
        routes.push({
          path: docsPath,
          handler: () =>
            new Response(html, {
              headers: { 'content-type': 'text/html; charset=utf-8' }
            })
        })
      }

      return routes
    }
  }
}
