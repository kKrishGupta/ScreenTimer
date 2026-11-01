/**
 * Application error carrying an HTTP status and a stable machine-readable code.
 * Route handlers throw these; the global error handler renders them consistently.
 */
export class AppError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} code
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (message = 'Resource not found') => new AppError(404, 'NOT_FOUND', message);
export const badRequest = (message, details) =>
  new AppError(400, 'BAD_REQUEST', message, details);
export const serviceUnavailable = (message) =>
  new AppError(503, 'SERVICE_UNAVAILABLE', message);

