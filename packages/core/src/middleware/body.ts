// Reads and parses a request body according to Content-Type — separate from
// validation on purpose: Standard Schema validates a value already in
// memory, it has no notion of HTTP or Content-Type. This is the only piece
// that knows about either.
//
// v1 supports application/json (and the application/*+json suffix,
// RFC 6839) only. Anything else is 'unsupported' — no guessing, no
// multipart/form-data or text/plain parsing yet.
export type ParsedBody =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'unsupported-media-type' | 'invalid-json' }

const JSON_CONTENT_TYPE = /^application\/(?:.+\+)?json(?:;|$)/

export async function parseBody(request: Request): Promise<ParsedBody> {
  // Media types are case-insensitive (RFC 9110 §8.3.1) — a client sending
  // "application/JSON" (or any other casing) is still JSON.
  const contentType = (request.headers.get('content-type') ?? '').toLowerCase()
  if (!JSON_CONTENT_TYPE.test(contentType)) {
    return { ok: false, reason: 'unsupported-media-type' }
  }

  // request.json() throws SyntaxError on malformed/empty JSON — caught here
  // so the caller gets a typed failure instead of a rejected promise that
  // would otherwise surface as an undifferentiated 500.
  try {
    const value: unknown = await request.json()
    return { ok: true, value }
  } catch {
    return { ok: false, reason: 'invalid-json' }
  }
}
