// The only module that knows Scalar exists.

import { renderApiReference } from '@scalar/client-side-rendering'

export interface ScalarOptions {
  /** Page `<title>`. Defaults to Scalar's own. */
  pageTitle?: string
  /** Where the Scalar bundle is loaded from. Defaults to jsDelivr. */
  cdn?: string
  /**
   * Pins the jsDelivr bundle to this `@scalar/api-reference` version
   * (`'1.79.0'`). Without it the page loads whatever jsDelivr serves as
   * latest at that moment, so a compromised or broken release would reach
   * your docs page unreviewed. Not combinable with `cdn`; to also get
   * integrity, self-host the bundle and point `cdn` at it.
   */
  version?: string
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

const JSDELIVR_BUNDLE = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference'
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

// Checked when openapi() is set up, not on the first /docs request.
export function assertScalarOptions(options: ScalarOptions): void {
  if (options.version === undefined) return
  if (options.cdn !== undefined) {
    throw new Error('openapi(): docs.version and docs.cdn cannot be combined.')
  }
  if (!VERSION.test(options.version)) {
    throw new Error(
      `openapi(): docs.version must be an exact version like "1.79.0", got "${options.version}".`
    )
  }
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
    ...(options.version === undefined
      ? options.cdn === undefined
        ? {}
        : { cdn: options.cdn }
      : { cdn: `${JSDELIVR_BUNDLE}@${options.version}` })
  })
}
