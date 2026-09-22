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
