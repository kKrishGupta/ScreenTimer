import { loadConfig } from '../src/shared/config.js';
import { createPrismaClient } from '../src/database/prisma.js';
import { DeviceService } from '../src/modules/devices/devices.service.js';

const config = loadConfig();
const prisma = createPrismaClient(config);
const deviceService = new DeviceService(prisma, console);

try {
  const tokenInfo = await deviceService.createEnrollmentToken({
    organizationId: '00000000-0000-0000-0000-000000000000',
    deviceKind: 'DESKTOP_WINDOWS',
    expiresInHours: 72,
  });

  console.log('\n======================================================');
  console.log('   DIGITALPULSE: NEW DEVICE ENROLLMENT TOKEN');
  console.log('======================================================');
  console.log('TOKEN:');
  console.log(tokenInfo.token);
  console.log('\nCopy and paste this exact command into PowerShell:');
  console.log(`cargo run -p dp-user-agent -- enroll --token "${tokenInfo.token}"\n`);
  console.log('======================================================\n');
} catch (err) {
  console.error('Failed to generate token:', err.message);
} finally {
  process.exit(0);
}

