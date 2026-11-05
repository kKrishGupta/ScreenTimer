import { buildApp } from './app.js';
import { loadConfig } from './shared/config.js';
import { createPrismaClient, probeDatabase } from './database/prisma.js';

async function main() {
  const config = loadConfig();
  const prisma = createPrismaClient(config);
  if (config.nodeEnv === 'production') {
    const database = await probeDatabase(prisma);
    if (database.status !== 'up') {
      await prisma.$disconnect().catch(() => {});
      throw new Error(`Required PostgreSQL connection is unavailable: ${database.error}`);
    }
  }
  const app = await buildApp({ config, prisma });
  if (!app.authService.emailService.configured) {
    app.log.warn('Password-reset email is unavailable. Configure SMTP_USER and SMTP_PASSWORD (or supported aliases) in the runtime environment.');
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'Shutting down');
    try {
      await app.close();
      await prisma.$disconnect();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err) => {
  // Logger may not exist yet (e.g. config errors), so fall back to stderr.
  console.error(`[digitalpulse-backend] fatal: ${err.message}`);
  process.exit(1);
});

