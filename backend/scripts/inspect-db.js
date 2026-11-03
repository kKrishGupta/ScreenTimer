import { loadConfig } from '../src/shared/config.js';
import { createPrismaClient } from '../src/database/prisma.js';

const config = loadConfig();
const prisma = createPrismaClient(config);

async function main() {
  try {
    const policies = await prisma.familyPolicy.findMany();
    console.log('Policies count in DB:', policies.length);
    console.log('Policies:', JSON.stringify(policies, null, 2));

    const orgs = await prisma.organization.findMany();
    console.log('Orgs in DB:', orgs);

    const users = await prisma.user.findMany({ select: { id: true, email: true, role: true, organizationId: true } });
    console.log('Users in DB:', users);
  } catch (e) {
    console.error('DB error:', e.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
