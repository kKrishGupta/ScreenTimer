import { loadConfig } from '../src/shared/config.js';
import { createPrismaClient } from '../src/database/prisma.js';
import { AuthService } from '../src/modules/auth/auth.service.js';

const { INITIAL_ADMIN_EMAIL: email, INITIAL_ADMIN_PASSWORD: password, INITIAL_ADMIN_NAME: displayName, INITIAL_ORGANIZATION_NAME: organizationName } = process.env;
if (!email || !password || !displayName || !organizationName) {
  console.error('Set INITIAL_ADMIN_EMAIL, INITIAL_ADMIN_PASSWORD, INITIAL_ADMIN_NAME, and INITIAL_ORGANIZATION_NAME in the private deployment environment.');
  process.exit(2);
}

const config = loadConfig();
const prisma = createPrismaClient(config);
try {
  const auth = new AuthService(prisma, console, config);
  const admin = await auth.register({ email, password, displayName, organizationName });
  console.log(`Created organization administrator ${admin.email} for organization ${admin.organizationId}.`);
} catch (error) {
  console.error(`Administrator provisioning failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
