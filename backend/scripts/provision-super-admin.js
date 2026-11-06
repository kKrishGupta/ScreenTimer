import crypto from 'node:crypto';
import { loadConfig } from '../src/shared/config.js';
import { createPrismaClient } from '../src/database/prisma.js';
import { hashPassword } from '../src/modules/auth/auth.service.js';

const EMAIL = 'emailkrish@gmail.com';
const DISPLAY_NAME = 'Krish';
const ORGANIZATION_NAME = 'DigitalPulse System';

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;

    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      reject(new Error('Run this script in an interactive terminal.'));
      return;
    }

    let value = '';
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();

    const cleanup = () => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      process.stdout.write('\n');
    };

    const onData = (buffer) => {
      for (const char of buffer.toString('utf8')) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('Cancelled.'));
          return;
        }

        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(value);
          return;
        }

        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }

        if (char >= ' ' && char !== '\u007f') {
          value += char;
        }
      }
    };

    input.on('data', onData);
  });
}

let prisma;

try {
  const config = loadConfig();
  const database = new URL(config.databaseUrl);

  // Safety check: only allow local database provisioning.
  if (!['localhost', '127.0.0.1', '::1'].includes(database.hostname)) {
    throw new Error(
      'Refusing to provision against a remote database. Check your local DATABASE_URL.'
    );
  }

  const password = await readHidden('Enter a NEW Super Admin password: ');
  const confirmation = await readHidden('Confirm password: ');

  if (password.length < 16) {
    throw new Error('Use a password of at least 16 characters.');
  }

  if (password !== confirmation) {
    throw new Error('Passwords do not match.');
  }

  const { hash, salt } = hashPassword(password);

  prisma = createPrismaClient(config);

  const existing = await prisma.user.findFirst({
    where: {
      email: {
        equals: EMAIL,
        mode: 'insensitive'
      }
    },
    select: {
      id: true,
      email: true,
      role: true
    }
  });

  if (existing) {
    throw new Error(
      `An account with this email already exists (role: ${existing.role}). No changes made.`
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: {
        name: ORGANIZATION_NAME,
        slug: `digitalpulse-system-${crypto.randomBytes(4).toString('hex')}`
      }
    });

    const user = await tx.user.create({
      data: {
        organizationId: organization.id,
        email: EMAIL,
        displayName: DISPLAY_NAME,
        role: 'SUPER_ADMIN',
        passwordHash: hash,
        passwordSalt: salt,
        employmentStatus: 'active'
      },
      select: {
        id: true,
        email: true,
        role: true,
        organizationId: true
      }
    });

    return { organization, user };
  });

  console.log('\nSuper Admin created successfully.');
  console.log('Email:', result.user.email);
  console.log('Role:', result.user.role);
  console.log('User ID:', result.user.id);
  console.log('System organization:', result.organization.name);
  console.log('Password stored as a secure hash.');

} catch (error) {
  console.error('\nProvisioning failed:', error.message);
  process.exitCode = 1;
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
}
