import { AppError } from '../shared/errors.js';

/**
 * Global error handler producing a uniform envelope:
 *   { error: { code, message, details?, requestId } }
 * Internal error details are logged but never leaked to clients.
 *
 * @param {import('fastify').FastifyError & { details?: unknown }} error
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export function errorHandler(error, request, reply) {
  if (/^\/api\/v1\/auth\/reset-password-(request|confirm)$/.test(request.url.split('?')[0])) {
    // JSON parser/transport errors can include the submitted secret in their text.
    const status = error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 503;
    if (status >= 500) request.log.error('Password reset request failed');
    return reply.header('Cache-Control', 'no-store').status(status).send({
      error: { code: 'RESET_FAILED', message: status < 500 ? 'Invalid password reset request.' : 'Password reset is temporarily unavailable. Please try again.' },
    });
  }
  if (error.validation) {
    return reply.status(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: error.validation.map((v) => ({
          path: v.instancePath || v.params?.missingProperty || '',
          message: v.message,
        })),
        requestId: request.id,
      },
    });
  }

  if (error instanceof AppError) {
    if (error.statusCode >= 500) request.log.error({ err: error }, error.message);
    return reply.status(error.statusCode).send({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
        requestId: request.id,
      },
    });
  }

  // Fastify-originated client errors (e.g. malformed JSON, payload too large).
  const status = error.statusCode ?? 500;
  if (status >= 400 && status < 500) {
    return reply.status(status).send({
      error: { code: error.code ?? 'BAD_REQUEST', message: error.message, requestId: request.id },
    });
  }

  request.log.error({ err: error }, 'Unhandled error');
  return reply.status(500).send({
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: request.id },
  });
}

/** Uniform 404 for unknown routes. */
export function notFoundHandler(request, reply) {
  return reply.status(404).send({
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `Route ${request.method} ${request.url.split('?')[0]} not found`,
      requestId: request.id,
    },
  });
}

