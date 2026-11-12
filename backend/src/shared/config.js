import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { isIP } from 'node:net';

// Workspace scripts run with `backend/` as cwd, while direct local launches
// often run from the repository root. Resolve env files from this module so
// configuration never depends on the directory from which npm was invoked.
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repositoryRoot = path.resolve(backendRoot, '..');
dotenv.config({ path: path.join(repositoryRoot, '.env'), quiet: true });
dotenv.config({ path: path.join(backendRoot, '.env'), quiet: true });

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);
const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Returns the canonical PostgreSQL URL, accepting DATABASE as a legacy alias.
 * DATABASE_URL always takes precedence when both variables are provided.
 * @param {Record<string, string | undefined>} env
 */
export function resolveDatabaseUrl(env = process.env) {
  return env.DATABASE_URL?.trim() || env.DATABASE?.trim();
}

/**
 * Builds and validates runtime configuration from environment variables.
 * Local development may bind to all interfaces when LAN testing is explicitly
 * requested with HOST=0.0.0.0.
 *
 * @param {Record<string, string | undefined>} env
 */
export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const host = env.HOST ?? (nodeEnv === 'production' ? '0.0.0.0' : '127.0.0.1');
  if (!ALLOWED_HOSTS.has(host)) {
    throw new ConfigError(`HOST must be localhost or 0.0.0.0 (got "${host}")`);
  }

  const port = Number(env.PORT ?? '3001');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535 (got "${env.PORT}")`);
  }

  const databaseUrl = resolveDatabaseUrl(env);
  const trustedProxies = (env.TRUSTED_PROXIES || '').split(',').map((value) => value.trim()).filter(Boolean);
  for (const proxy of trustedProxies) {
    const [address, prefix, extra] = proxy.split('/');
    const version = isIP(address);
    if (!version || extra !== undefined || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (version === 4 ? 32 : 128)))) {
      throw new ConfigError('TRUSTED_PROXIES must contain explicit proxy IP addresses or CIDR ranges');
    }
  }
  if (!databaseUrl) {
    throw new ConfigError('DATABASE_URL is required (legacy DATABASE is accepted; see backend/.env.example)');
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
  if (nodeEnv === 'production') {
    const isLocalDatabase = ['localhost', '127.0.0.1', '::1'].includes(parsedDb.hostname);
    const sslMode = parsedDb.searchParams.get('sslmode');
    if (!isLocalDatabase && !['require', 'verify-ca', 'verify-full'].includes(sslMode)) {
      throw new ConfigError('Production PostgreSQL DATABASE_URL must set sslmode=require or stronger');
    }
  }

  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!LOG_LEVELS.has(logLevel)) {
    throw new ConfigError(`LOG_LEVEL must be one of ${[...LOG_LEVELS].join(', ')}`);
  }

  const corsOrigins = (env.CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const publicAppUrl = env.PUBLIC_APP_URL?.replace(/\/$/, '') || '';
  const publicAppDomain = env.PUBLIC_APP_DOMAIN || '';
  const invitationAcceptUrl = env.INVITATION_ACCEPT_URL || (publicAppUrl
    ? `${publicAppUrl}/accept-invitation`
    : 'http://localhost:5173/accept-invitation');
  const passwordResetUrl = env.PASSWORD_RESET_URL || (publicAppUrl
    ? `${publicAppUrl}/reset-password`
    : 'http://localhost:5173/reset-password');
  const passwordResetTtlMinutes = Number(env.PASSWORD_RESET_TTL_MINUTES ?? 30);
  if (!Number.isInteger(passwordResetTtlMinutes) || passwordResetTtlMinutes < 1 || passwordResetTtlMinutes > 60) {
    throw new ConfigError('PASSWORD_RESET_TTL_MINUTES must be an integer between 1 and 60');
  }
  const smtpHost = env.SMTP_HOST ?? 'smtp.gmail.com';
  const smtpPort = env.SMTP_PORT ?? '465';
  const smtpSecure = env.SMTP_SECURE ?? 'true';
  if (smtpHost.toLowerCase() !== 'smtp.gmail.com' || smtpPort !== '465' || smtpSecure.toLowerCase() !== 'true') {
    throw new ConfigError('Gmail SMTP requires SMTP_HOST=smtp.gmail.com, SMTP_PORT=465 and SMTP_SECURE=true');
  }

  if (nodeEnv === 'production') {
    if (!publicAppUrl) throw new ConfigError('PUBLIC_APP_URL is required in production');
    let appUrl;
    try { appUrl = new URL(publicAppUrl); } catch { throw new ConfigError('PUBLIC_APP_URL must be a valid HTTPS URL'); }
    if (appUrl.protocol !== 'https:' || !['', '/'].includes(appUrl.pathname) || appUrl.search || appUrl.hash) {
      throw new ConfigError('PUBLIC_APP_URL must be an HTTPS origin without a path, query, or fragment');
    }
    if (publicAppDomain && appUrl.hostname !== publicAppDomain) {
      throw new ConfigError('PUBLIC_APP_DOMAIN must match the PUBLIC_APP_URL hostname');
    }
    if (!corsOrigins.length || corsOrigins.some((origin) => {
      try {
        const parsedOrigin = new URL(origin);
        return parsedOrigin.protocol !== 'https:' || !['', '/'].includes(parsedOrigin.pathname) || parsedOrigin.search || parsedOrigin.hash;
      } catch { return true; }
    })) throw new ConfigError('CORS_ORIGINS must contain only valid HTTPS origins in production');
    if (corsOrigins.length !== 1 || corsOrigins[0] !== appUrl.origin) {
      throw new ConfigError('CORS_ORIGINS must contain only the exact PUBLIC_APP_URL origin in production');
    }
    for (const [name, value] of [['INVITATION_ACCEPT_URL', invitationAcceptUrl], ['PASSWORD_RESET_URL', passwordResetUrl]]) {
      let url;
      try { url = new URL(value); } catch { throw new ConfigError(`${name} must be a valid HTTPS URL`); }
      if (url.protocol !== 'https:' || url.origin !== appUrl.origin) {
        throw new ConfigError(`${name} must use the HTTPS PUBLIC_APP_URL origin`);
      }
    }
  }

  return Object.freeze({
    nodeEnv,
    host,
    port,
    databaseUrl,
    logLevel,
    corsOrigins,
    publicAppUrl,
    publicAppDomain,
    allowPublicRegistration: env.ALLOW_PUBLIC_REGISTRATION === undefined
      ? nodeEnv !== 'production' : env.ALLOW_PUBLIC_REGISTRATION === 'true',
    secureSessionCookies: nodeEnv === 'production',
    trustProxy: trustedProxies.length ? trustedProxies : false,
    smtpHost,
    smtpPort,
    smtpSecure,
    smtpUser: env.SMTP_USER ?? env.GMAIL_USER ?? env.google_email,
    smtpPassword: env.SMTP_PASS ?? env.SMTP_PASSWORD ?? env.GMAIL_APP_PASSWORD ?? env.google_password,
    smtpFrom: env.EMAIL_FROM ?? env.SMTP_FROM ?? env.SMTP_USER ?? env.GMAIL_USER ?? env.google_email,
    passwordResetUrl,
    passwordResetTtlMinutes,
    invitationAcceptUrl,
  });
}
