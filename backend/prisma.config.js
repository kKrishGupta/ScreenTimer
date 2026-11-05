// Prisma 7 configuration: datasource URL, schema and migration locations.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { defineConfig } from 'prisma/config';

const backendRoot = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(backendRoot, '../.env'), quiet: true });
dotenv.config({ path: path.resolve(backendRoot, '.env'), quiet: true });

// DATABASE_URL is canonical. Keep DATABASE as a compatibility alias for
// existing deployments; the canonical value wins if both are set.
const databaseUrl = process.env.DATABASE_URL?.trim() || process.env.DATABASE?.trim();
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required (legacy DATABASE is accepted)');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'node prisma/seed.js',
  },
  datasource: {
    url: databaseUrl,
  },
});

