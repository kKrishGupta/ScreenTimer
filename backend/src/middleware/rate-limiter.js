/**
 * In-memory sliding window rate limiter for Fastify.
 * Zero-dependency, offline-resilient, and bounded against memory growth.
 */
export function createRateLimiter({
  windowMs = 60 * 1000,
  maxRequests = 120, // 120 requests per minute default
  excludedPaths = ['/api/v1/health'],
} = {}) {
  const ipBuckets = new Map();

  // Periodically clean expired buckets every 2 minutes
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of ipBuckets.entries()) {
      if (now - bucket.windowStart > windowMs) {
        ipBuckets.delete(ip);
      }
    }
  }, 2 * 60 * 1000);

  if (cleanupInterval.unref) {
    cleanupInterval.unref(); // Don't prevent Node process exit
  }

  return async function rateLimitHook(req, reply) {
    if (excludedPaths.some((p) => req.url.startsWith(p))) {
      return;
    }

    const ip = req.ip || req.socket?.remoteAddress || '127.0.0.1';
    const now = Date.now();
    let bucket = ipBuckets.get(ip);

    if (!bucket || now - bucket.windowStart > windowMs) {
      bucket = { windowStart: now, count: 1 };
      ipBuckets.set(ip, bucket);
    } else {
      bucket.count += 1;
    }

    const remaining = Math.max(0, maxRequests - bucket.count);
    reply.header('X-RateLimit-Limit', maxRequests);
    reply.header('X-RateLimit-Remaining', remaining);
    reply.header('X-RateLimit-Reset', Math.ceil((bucket.windowStart + windowMs) / 1000));

    if (bucket.count > maxRequests) {
      const retryAfterSeconds = Math.ceil((bucket.windowStart + windowMs - now) / 1000);
      reply.header('Retry-After', retryAfterSeconds);
      return reply.status(429).send({
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Too many requests from this IP. Please wait ${retryAfterSeconds} seconds before retrying.`,
        },
      });
    }
  };
}

