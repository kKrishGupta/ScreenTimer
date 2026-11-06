import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig } from '../src/shared/config.js';
import { createPrismaClient } from '../src/database/prisma.js';
import { hashPassword } from '../src/modules/auth/auth.service.js';

const EMAIL = 'emailkrish@gmail.com';
const DISPLAY_NAME = 'Krish';
const ORGANIZATION_NAME = 'DigitalPulse System';

// Only this exact Neon database is authorized.
const ALLOWED_DATABASE_HOST =
  'ep-mute-darkness-az8sv2be-pooler.c-3.ap-southeast-1.aws.neon.tech';

const CONFIRMATION_TEXT = 'YES';

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
        } else if (char >= ' ' && char !== '\u007f') {
          value += char;
        }
      }
    };

    input.on('data', onData);
  });
}

let prisma;

try {
  // Load the existing application database configuration.
  const config = loadConfig();
  const database = new URL(config.databaseUrl);

  // Strict database-host verification.
  if (database.hostname !== ALLOWED_DATABASE_HOST) {
    throw new Error(
      `Unauthorized database host: ${database.hostname}`
    );
  }

  if (database.protocol !== 'postgresql:') {
    throw new Error('Expected a PostgreSQL database URL.');
  }

  console.log('\nDigitalPulse Super Admin Provisioning');
  console.log('-------------------------------------');
  console.log('Target database host:', database.hostname);
  console.log('Target database name:', database.pathname.slice(1));
  console.log('Account email:', EMAIL);
  console.log('Role: SUPER_ADMIN');

  const rl = readline.createInterface({ input, output });

  const confirmation = await rl.question(
    '\nType YES to continue: '
  );

  rl.close();

  if (confirmation !== CONFIRMATION_TEXT) {
    throw new Error('Database confirmation failed. No changes made.');
  }

  // Collect a fresh password without displaying it.
  const password = await readHidden(
    '\nEnter a NEW Super Admin password: '
  );

  const passwordConfirmation = await readHidden(
    'Confirm password: '
  );

  if (password.length < 16) {
    throw new Error('Password must contain at least 16 characters.');
  }

  if (password !== passwordConfirmation) {
    throw new Error('Passwords do not match.');
  }

  // Never reuse a password that was previously shared in chat.
  const { hash, salt } = hashPassword(password);

  prisma = createPrismaClient(config);

  // Check whether the account already exists.
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
      `Account already exists with role ${existing.role}. No changes made.`
    );
  }

  // Create organization and Super Admin atomically.
  const result = await prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: {
        name: ORGANIZATION_NAME,
        slug: `digitalpulse-system-${crypto.randomBytes(6).toString('hex')}`
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

  console.log('\nSUCCESS: Super Admin provisioned.');
  console.log('-------------------------------------');
  console.log('Email:', result.user.email);
  console.log('Role:', result.user.role);
  console.log('User ID:', result.user.id);
  console.log('Organization:', result.organization.name);
  console.log('Organization ID:', result.organization.id);
  console.log('Password: securely hashed and stored.');

} catch (error) {
  console.error('\nPROVISIONING FAILED:', error.message);
  process.exitCode = 1;
} finally {
  if (prisma) {
    await prisma.$disconnect();
  }
}
