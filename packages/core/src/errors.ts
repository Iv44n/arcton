import type { StandardSchemaV1 } from '@arcton/contracts'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body?: unknown
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export class ValidationError extends HttpError {
  constructor(readonly issues: ReadonlyArray<StandardSchemaV1.Issue>) {
    super(400, 'VALIDATION_FAILED', 'Request validation failed', { issues })
    this.name = 'ValidationError'
  }
}

export class UnsupportedMediaTypeError extends HttpError {
  constructor() {
    super(415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported Media Type')
    this.name = 'UnsupportedMediaTypeError'
  }
}

export type RequestError = ValidationError | UnsupportedMediaTypeError

export function isRequestError(err: unknown): err is RequestError {
  return (
    err instanceof ValidationError || err instanceof UnsupportedMediaTypeError
  )
}

export function defaultErrorResponse(err: RequestError): Response {
  if (err instanceof ValidationError) {
    return new Response(JSON.stringify({ issues: err.issues }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    })
  }
  return new Response(null, { status: 415 })
}

function statusError(status: number, code: string, defaultMessage: string) {
  return (message: string = defaultMessage, body?: unknown): HttpError =>
    new HttpError(status, code, message, body)
}

export const Http = {
  BadRequest: statusError(400, 'BAD_REQUEST', 'Bad Request'),
  Unauthorized: statusError(401, 'UNAUTHORIZED', 'Unauthorized'),
  Forbidden: statusError(403, 'FORBIDDEN', 'Forbidden'),
  NotFound: statusError(404, 'NOT_FOUND', 'Not Found'),
  MethodNotAllowed: statusError(
    405,
    'METHOD_NOT_ALLOWED',
    'Method Not Allowed'
  ),
  Conflict: statusError(409, 'CONFLICT', 'Conflict'),
  Gone: statusError(410, 'GONE', 'Gone'),
  UnprocessableEntity: statusError(
    422,
    'UNPROCESSABLE_ENTITY',
    'Unprocessable Entity'
  ),
  TooManyRequests: statusError(429, 'TOO_MANY_REQUESTS', 'Too Many Requests'),
  InternalServerError: statusError(
    500,
    'INTERNAL_SERVER_ERROR',
    'Internal Server Error'
  ),
  ServiceUnavailable: statusError(
    503,
    'SERVICE_UNAVAILABLE',
    'Service Unavailable'
  )
}
