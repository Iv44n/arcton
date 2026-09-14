// The only module that knows Scalar exists.

import { renderApiReference } from '@scalar/client-side-rendering'

export interface ScalarOptions {
  /** Page `<title>`. Defaults to Scalar's own. */
  pageTitle?: string
  /** Where the Scalar bundle is loaded from. Defaults to jsDelivr. */
  cdn?: string
  /**
   * Scalar's own configuration (theme, sidebar, authentication, ...). Kept
   * separate from the OpenAPI document options: one describes the API, the
   * other describes the UI reading it.
   *
   * `url` is set from the document path and is what makes the page fetch the
   * document instead of embedding a second copy of it.
   */
  configuration?: Record<string, unknown>
}

/** A complete HTML page rendering the document served at `documentPath`. */
export function renderScalar(
  documentPath: string,
  options: ScalarOptions = {}
): string {
  return renderApiReference({
    config: { url: documentPath, ...options.configuration },
    ...(options.pageTitle === undefined
      ? {}
      : { pageTitle: options.pageTitle }),
    ...(options.cdn === undefined ? {} : { cdn: options.cdn })
  })
}
