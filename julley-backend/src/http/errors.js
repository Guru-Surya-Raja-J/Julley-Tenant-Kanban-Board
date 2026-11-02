export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code, message, details) => new ApiError(400, code, message, details);
export const unauthorized = (message = 'Sign in required') => new ApiError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Your role does not allow this') => new ApiError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Resource') => new ApiError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code, message, details) => new ApiError(409, code, message, details);

const PG_ERRORS = {
  23505: () => conflict('ALREADY_EXISTS', 'That already exists'),
  23503: () => badRequest('INVALID_REFERENCE', 'A referenced record does not exist in this tenant'),
  23514: () => badRequest('CONSTRAINT_VIOLATION', 'The value is not allowed'),
  '22P02': () => badRequest('INVALID_VALUE', 'A value has the wrong format'),
};

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  let error = err;
  if (!(error instanceof ApiError) && PG_ERRORS[err.code]) error = PG_ERRORS[err.code]();
  if (!(error instanceof ApiError) && err.type === 'entity.parse.failed') {
    error = badRequest('INVALID_JSON', 'Request body is not valid JSON');
  }
  if (!(error instanceof ApiError) && err.type === 'entity.too.large') {
    error = new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  }

  if (error instanceof ApiError) {
    return res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
  }

  console.error(`[http] ${req.method} ${req.originalUrl}`, err);
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
}
