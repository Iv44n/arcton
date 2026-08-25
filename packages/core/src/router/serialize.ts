// Maps a handler's return value to a Response.
//
// The narrowing order below is load-bearing: every instanceof/isView
// check runs before the generic `typeof === "object"` branch, because
// Response, Blob, Uint8Array, ArrayBuffer, DataView, FormData,
// URLSearchParams and ReadableStream are all objects — if any of them fell
// through to the JSON branch, JSON.stringify would silently produce garbage
// (e.g. `{"0":1,"1":2}` for a Uint8Array, `{}` for an ArrayBuffer).

import type { Body, ResponseContext } from '@arcton/contracts'

const NO_BODY_STATUSES = new Set([204, 205, 304])

export function mapResponse(
  result: Body | void,
  responseContext: ResponseContext
): Response {
  // Escape hatch: returned as-is, ctx.response (status AND headers) is
  // entirely ignored — there is no merge, no status validation.
  if (result instanceof Response) {
    return result
  }

  const status = responseContext.status ?? 200
  if (status < 200 || status > 599) {
    throw new Error(
      `Invalid response status ${status}: must be between 200 and 599`
    )
  }

  // Explicit-ness is judged against the headers the handler actually set,
  // before any inferred Content-Type below is merged in on top of the clone.
  const hadExplicitContentType = responseContext.headers.has('Content-Type')
  const headers = new Headers(responseContext.headers)

  let body: Bun.BodyInit | null
  let inferredContentType: string | undefined
  let isFormData = false

  if (result === null || result === undefined) {
    body = null
  } else if (typeof result === 'string') {
    body = result
    inferredContentType = 'text/plain; charset=UTF-8'
  } else if (result instanceof Blob) {
    body = result
    inferredContentType = result.type || 'application/octet-stream'
  } else if (result instanceof FormData) {
    body = result
    isFormData = true
  } else if (result instanceof URLSearchParams) {
    body = result
  } else if (ArrayBuffer.isView(result)) {
    body = result as Bun.BodyInit
    inferredContentType = 'application/octet-stream'
  } else if (result instanceof ArrayBuffer) {
    body = result
    inferredContentType = 'application/octet-stream'
  } else if (result instanceof ReadableStream) {
    body = result
    inferredContentType = 'application/octet-stream'
  } else if (typeof result === 'object') {
    body = JSON.stringify(result)
    inferredContentType = 'application/json; charset=UTF-8'
  } else {
    throw new Error(
      `Cannot serialize handler result of type "${typeof result}" to a Response body`
    )
  }

  if (isFormData) {
    // fetch generates its own `multipart/form-data; boundary=...`; an
    // explicit Content-Type would prevent that and break the body, so it's
    // dropped on purpose even if the handler set one. Footgun declared.
    headers.delete('Content-Type')
  } else if (inferredContentType && !headers.has('Content-Type')) {
    headers.set('Content-Type', inferredContentType)
  }

  if (NO_BODY_STATUSES.has(status)) {
    body = null
    // Explicit headers the handler set (e.g. Content-Length: 0) pass through
    // untouched; an inferred Content-Type is discarded — no sense announcing
    // a type for a body that no longer exists.
    if (!hadExplicitContentType) headers.delete('Content-Type')
  }

  return new Response(body, { status, headers })
}
