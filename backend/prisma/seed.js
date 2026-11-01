// Seeds the single local development organization and owner user (Stage 1).
// Idempotent: safe to run repeatedly. Contains NO activity data - all activity
// comes from real collectors.
import { loadConfig } from '../src/shared/config.js';
import { createPrismaClient } from '../src/database/prisma.js';

const DEV_ORG_SLUG = process.env.DEV_ORG_SLUG ?? 'local-dev';

async function main() {
  const config = loadConfig();
  const prisma = createPrismaClient(config);
  try {
    const org = await prisma.organization.upsert({
      where: { slug: DEV_ORG_SLUG },
      update: {},
      create: { name: 'Local Development', slug: DEV_ORG_SLUG },
    });
    const user = await prisma.user.upsert({
      where: { organizationId_email: { organizationId: org.id, email: 'owner@localhost' } },
      update: {},
      create: {
        organizationId: org.id,
        email: 'owner@localhost',
        displayName: 'Local Owner',
        role: 'OWNER',
      },
    });
    console.log(`Seeded organization "${org.slug}" (${org.id}) and user ${user.email}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

