import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Creates the Prisma client backed by the node-postgres driver adapter.
 * A single instance is shared by the whole process.
 *
 * @param {{ databaseUrl: string }} config
 */
export function createPrismaClient({ databaseUrl }) {
  const isRemoteSsl = databaseUrl.includes('sslmode=require')
    || databaseUrl.includes('sslmode=verify-ca')
    || databaseUrl.includes('sslmode=verify-full')
    || databaseUrl.includes('neon.tech');
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: isRemoteSsl ? { rejectUnauthorized: true } : undefined,
    connectionTimeoutMillis: 30000,
    idleTimeoutMillis: 60000,
    max: 10,
  });

  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

/**
 * Lightweight connectivity probe used by the health endpoint.
 * @param {PrismaClient} prisma
 * @returns {Promise<{ status: 'up' | 'down', latencyMs: number, error?: string }>}
 */
export async function probeDatabase(prisma) {
  const started = performance.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'up', latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    const cause = err?.cause;
    const rawCode = cause?.code || err?.code;
    const message = `${cause?.message || ''} ${err instanceof Error ? err.message : ''}`;
    const knownCode = rawCode || message.match(/\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|28P01|3D000|P\d{4})\b/)?.[1];
    return {
      status: 'down',
      latencyMs: Math.round(performance.now() - started),
      // Driver error messages can include usernames, hostnames, or connection
      // details. Return only a safe error class to API callers and startup logs.
      error: knownCode ? `Database connectivity check failed (${knownCode})` : 'Database connectivity check failed',
    };
  }
}

