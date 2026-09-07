import type { BodyParser } from '@arcton/contracts'

// Matches Bun.serve's own default — the Node adapter otherwise buffers a
// request body with no limit at all.
export const DEFAULT_MAX_BODY_SIZE = 128 * 1024 * 1024

// Content-Length is authoritative when present, so this rejects an
// oversized declared body without reading any of it.
export function contentLengthExceeds(
  request: Request,
  maxBytes: number
): boolean {
  const contentLength = request.headers.get('content-length')
  if (contentLength === null) return false
  const declared = Number(contentLength)
  return Number.isFinite(declared) && declared > maxBytes
}

// Counts bytes as a chunked/streamed body (no Content-Length) arrives,
// aborting once the running total exceeds the limit. No-op for GET/HEAD.
export function limitBodySize(request: Request, maxBytes: number): Request {
  if (!request.body) return request

  const source = request.body
  let total = 0
  const limited = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > maxBytes) {
            controller.error(
              new Error(
                `Request body exceeds the configured limit of ${maxBytes} bytes`
              )
            )
            return
          }
          controller.enqueue(value)
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      }
    }
  })

  return new Request(request, { body: limited, duplex: 'half' } as RequestInit)
}

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
