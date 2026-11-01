import 'dotenv/config';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Builds and validates runtime configuration from environment variables.
 * Stage 1 is localhost-only: binding to a non-loopback interface is refused.
 *
 * @param {Record<string, string | undefined>} env
 */
export function loadConfig(env = process.env) {
  const host = env.HOST ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new ConfigError(`HOST must be a loopback address in Stage 1 (got "${host}")`);
  }

  const port = Number.parseInt(env.PORT ?? '3001', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535 (got "${env.PORT}")`);
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new ConfigError('DATABASE_URL is required (see backend/.env.example)');
  }
  let parsedDb;
  try {
    parsedDb = new URL(databaseUrl);
  } catch {
    throw new ConfigError('DATABASE_URL is not a valid URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsedDb.protocol)) {
    throw new ConfigError('DATABASE_URL must use the postgresql:// scheme');
  }

  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!LOG_LEVELS.has(logLevel)) {
    throw new ConfigError(`LOG_LEVEL must be one of ${[...LOG_LEVELS].join(', ')}`);
  }

  const corsOrigins = (env.CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  return Object.freeze({
    nodeEnv: env.NODE_ENV ?? 'development',
    host,
    port,
    databaseUrl,
    logLevel,
    corsOrigins,
  });
}

