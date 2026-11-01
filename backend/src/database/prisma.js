import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Creates the Prisma client backed by the node-postgres driver adapter.
 * A single instance is shared by the whole process.
 *
 * @param {{ databaseUrl: string }} config
 */
export function createPrismaClient({ databaseUrl }) {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
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
    return {
      status: 'down',
      latencyMs: Math.round(performance.now() - started),
      error: err instanceof Error ? err.message.split('\n')[0] : String(err),
    };
  }
}

