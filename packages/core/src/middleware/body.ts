import type { BodyParser } from '@arcton/contracts'

// Reads and parses a request body according to Content-Type — separate from
// validation on purpose: Standard Schema validates a value already in
// memory, it has no notion of HTTP or Content-Type. This is the only piece
// that knows about either.
export type ParsedBody =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'unsupported-media-type' | 'invalid-body' }

// Media types are case-insensitive (RFC 9110 §8.3.1) and may carry
// parameters ("; charset=...", "; boundary=...") that don't affect which
// parser applies — both custom registration keys and incoming Content-Type
// headers go through this before ever being compared.
export function normalizeMediaType(contentType: string): string {
  const semicolon = contentType.indexOf(';')
  return (semicolon === -1 ? contentType : contentType.slice(0, semicolon))
    .trim()
    .toLowerCase()
}

const JSON_MEDIA_TYPE = /^application\/(?:.+\+)?json$/

// application/x-www-form-urlencoded and multipart/form-data both resolve to
// FormData — Request.formData() already decodes either per the Fetch spec,
// so there's no reason to hand-roll a separate URLSearchParams path for the
// former.
const BUILTIN_PARSERS: Record<string, BodyParser> = {
  'text/plain': request => request.text(),
  'application/x-www-form-urlencoded': request => request.formData(),
  'multipart/form-data': request => request.formData(),
  'application/octet-stream': request => request.arrayBuffer()
}

function builtinParserFor(mediaType: string): BodyParser | undefined {
  if (JSON_MEDIA_TYPE.test(mediaType)) return request => request.json()
  return BUILTIN_PARSERS[mediaType]
}

export async function parseBody(
  request: Request,
  customParsers: ReadonlyMap<string, BodyParser> = new Map()
): Promise<ParsedBody> {
  const mediaType = normalizeMediaType(
    request.headers.get('content-type') ?? ''
  )

  const customParser = customParsers.get(mediaType)
  if (customParser) {
    // A custom parser is user code — a throw propagates uncaught, same as
    // a handler or provide() throwing, instead of being swallowed into a
    // generic 400.
    const value = await customParser(request)
    return value === undefined
      ? { ok: false, reason: 'unsupported-media-type' }
      : { ok: true, value }
  }

  const builtin = builtinParserFor(mediaType)
  if (!builtin) return { ok: false, reason: 'unsupported-media-type' }

  // The built-in parsers throw on malformed input (e.g. request.json()'s
  // SyntaxError on bad JSON) — caught here so the caller gets a typed
  // failure instead of a rejected promise surfacing as an undifferentiated
  // 500.
  try {
    const value = await builtin(request)
    return value === undefined
      ? { ok: false, reason: 'unsupported-media-type' }
      : { ok: true, value }
  } catch {
    return { ok: false, reason: 'invalid-body' }
  }
}
