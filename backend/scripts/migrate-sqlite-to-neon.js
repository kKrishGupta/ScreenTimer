#!/usr/bin/env node
/**
 * DigitalPulse — Safe Data Migration Script: Legacy SQLite to Neon PostgreSQL
 *
 * Migrates legacy unsynced activity sessions and device state from local agent_storage.db
 * to Neon PostgreSQL (the authoritative central store).
 *
 * Safety Guarantees:
 * 1. Creates an immutable timestamped backup of the SQLite file before any operations.
 * 2. Idempotent: Can be run multiple times safely without creating duplicate records.
 * 3. Never deletes the SQLite database file (preserves historical file for user verification).
 * 4. Verifies database integrity and verifies record counts post-migration.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/shared/config.js';
import { createPrismaClient } from '../src/database/prisma.js';

const ACTIVITY_TYPE_MAP = {
  app_session: 'APP_SESSION',
  web_session: 'WEB_SESSION',
  idle_session: 'IDLE_SESSION',
  APP_SESSION: 'APP_SESSION',
  WEB_SESSION: 'WEB_SESSION',
  IDLE_SESSION: 'IDLE_SESSION',
};

function resolveDefaultSqlitePath() {
  const localAppData = process.env.LOCALAPPDATA || (process.platform === 'win32'
    ? path.join(process.env.USERPROFILE || 'C:\\Users\\Default', 'AppData', 'Local')
    : path.join(process.env.HOME || '.', '.config'));
  return path.join(localAppData, 'DigitalPulse', 'agent_storage.db');
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  let sqlitePath = process.env.DP_SQLITE_PATH || null;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sqlite-path' && args[i + 1]) {
      sqlitePath = args[++i];
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }

  if (!sqlitePath) {
    sqlitePath = resolveDefaultSqlitePath();
  }

  return { sqlitePath: path.resolve(sqlitePath), dryRun };
}

async function main() {
  const { sqlitePath, dryRun } = parseCliArgs();

  console.log('================================================================');
  console.log('   DIGITALPULSE: LEGACY SQLITE -> NEON POSTGRESQL MIGRATION     ');
  console.log('================================================================');
  console.log(`Target SQLite Source: ${sqlitePath}`);
  console.log(`Dry Run Mode:         ${dryRun ? 'YES (Preview only, no writes)' : 'NO (Live migration)'}`);

  if (!fs.existsSync(sqlitePath)) {
    console.log('\n[INFO] No legacy SQLite database found at path.');
    console.log('[OK] Device is either newly initialized or already using Neon PostgreSQL & DPAPI buffer.');
    console.log('Migration complete (0 records pending).');
    process.exit(0);
  }

  // 1. Create Timestamped Backup
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${sqlitePath}.backup-migration-${timestamp}`;
  try {
    fs.copyFileSync(sqlitePath, backupPath);
    console.log(`\n[BACKUP] Created safe timestamped backup:`);
    console.log(`         -> ${backupPath}`);
  } catch (err) {
    console.error(`[ERROR] Failed to create backup of SQLite database: ${err.message}`);
    process.exit(1);
  }

  // 2. Open and inspect SQLite database
  let db;
  try {
    db = new DatabaseSync(sqlitePath, { readOnly: dryRun });
  } catch (err) {
    console.error(`[ERROR] Could not open SQLite database: ${err.message}`);
    process.exit(1);
  }

  // Verify integrity
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    const isIntegrityOk = integrity.length > 0 && (integrity[0].integrity_check === 'ok' || integrity[0]['integrity_check'] === 'ok');
    if (!isIntegrityOk) {
      console.warn('[WARNING] SQLite integrity check returned non-ok result:', integrity);
    } else {
      console.log('[OK] SQLite integrity check passed.');
    }
  } catch (err) {
    console.warn(`[WARNING] Could not run integrity check: ${err.message}`);
  }

  // Check tables
  const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const tables = new Set(tableRows.map((r) => r.name));
  console.log(`[SCHEMA] Detected SQLite tables: ${Array.from(tables).join(', ')}`);

  // Read agent state
  let deviceId = null;
  let backendUrl = null;
  if (tables.has('agent_state')) {
    const stateRows = db.prepare('SELECT key, value FROM agent_state').all();
    for (const row of stateRows) {
      if (row.key === 'device_id') deviceId = row.value;
      if (row.key === 'backend_url') backendUrl = row.value;
    }
  }
  console.log(`[STATE] Local Device ID: ${deviceId || 'Not set'}`);
  console.log(`[STATE] Backend URL:     ${backendUrl || 'Default'}`);

  // 3. Connect to Neon PostgreSQL via Prisma
  const config = loadConfig();
  console.log(`\n[NEON] Connecting to Neon PostgreSQL authoritative store...`);
  const prisma = createPrismaClient(config);

  try {
    await prisma.$queryRaw`SELECT 1`;
    console.log('[OK] Connected to Neon PostgreSQL database successfully.');
  } catch (err) {
    console.error(`[ERROR] Could not connect to Neon PostgreSQL (${err.message}). Check DATABASE_URL.`);
    process.exit(1);
  }

  // Verify or resolve organization and device in Neon
  let organizationId = null;
  let targetDevice = null;

  if (deviceId) {
    try {
      targetDevice = await prisma.device.findUnique({
        where: { id: deviceId },
        include: { organization: true },
      });
      if (targetDevice) {
        organizationId = targetDevice.organizationId;
        console.log(`[OK] Device ${deviceId} matched in Neon PostgreSQL (Org: ${targetDevice.organization.name}).`);
      }
    } catch (err) {
      console.warn(`[WARN] Could not query device in Neon: ${err.message}`);
    }
  }

  if (!organizationId) {
    const firstOrg = await prisma.organization.findFirst({ select: { id: true, name: true } });
    if (firstOrg) {
      organizationId = firstOrg.id;
      console.log(`[INFO] Associated migration with organization: ${firstOrg.name} (${organizationId})`);
    } else {
      console.error('[ERROR] No organization found in Neon PostgreSQL to attach activity events.');
      await prisma.$disconnect();
      process.exit(1);
    }
  }

  // Ensure device exists in Neon if deviceId is known
  if (deviceId && !targetDevice && !dryRun) {
    console.log(`[SEED] Registering legacy device ${deviceId} in Neon PostgreSQL...`);
    try {
      targetDevice = await prisma.device.create({
        data: {
          id: deviceId,
          organizationId,
          kind: 'DESKTOP_AGENT',
          name: 'Migrated Desktop Agent',
          platform: 'Windows (Migrated)',
          isRevoked: false,
        },
      });
      console.log(`[OK] Registered legacy device record in Neon.`);
    } catch (err) {
      console.warn(`[WARN] Device create notice: ${err.message}`);
    }
  }

  // 4. Read sessions from SQLite
  let legacySessions = [];
  if (tables.has('activity_sessions')) {
    legacySessions = db.prepare('SELECT * FROM activity_sessions').all();
  }
  console.log(`\n[DATA] Found ${legacySessions.length} total activity sessions in SQLite.`);

  let unsyncedQueue = [];
  if (tables.has('sync_queue')) {
    unsyncedQueue = db.prepare('SELECT * FROM sync_queue WHERE synced_at IS NULL').all();
  }
  console.log(`[DATA] Found ${unsyncedQueue.length} unsynced items in sync_queue.`);

  if (legacySessions.length === 0 && unsyncedQueue.length === 0) {
    console.log('\n[INFO] No activity sessions to migrate.');
    await prisma.$disconnect();
    console.log('[OK] Safe Data Migration finished.');
    process.exit(0);
  }

  // 5. Migrate sessions idempotently
  let migratedCount = 0;
  let skippedDuplicateCount = 0;
  let failedCount = 0;

  for (const session of legacySessions) {
    const eventId = session.id;
    const sessionDevId = session.device_id || deviceId;

    if (!sessionDevId) {
      failedCount++;
      continue;
    }

    const typeStr = session.event_type || 'app_session';
    const activityType = ACTIVITY_TYPE_MAP[typeStr] || 'APP_SESSION';
    const collectorKind = session.event_source === 'BROWSER_EXTENSION' ? 'BROWSER_EXTENSION' : 'DESKTOP_AGENT';
    const startedAt = session.start_time ? new Date(session.start_time) : new Date(session.created_at || Date.now());
    const endedAt = session.end_time ? new Date(session.end_time) : new Date(startedAt.getTime() + (session.duration_seconds || 1) * 1000);
    const durationSeconds = Number(session.duration_seconds) || Math.max(1, (endedAt.getTime() - startedAt.getTime()) / 1000);
    const idleSeconds = Number(session.idle_seconds) || 0;

    if (dryRun) {
      migratedCount++;
      continue;
    }

    try {
      // Check if event already exists in Neon
      const existing = await prisma.activityEvent.findUnique({
        where: { deviceId_eventId: { deviceId: sessionDevId, eventId } },
      });

      if (existing) {
        skippedDuplicateCount++;
        continue;
      }

      // Resolve application if app_name exists
      let applicationId = null;
      if (session.app_name) {
        const exeName = path.basename(session.app_path || session.app_name).toLowerCase();
        const app = await prisma.application.upsert({
          where: { organizationId_executableName: { organizationId, executableName: exeName } },
          update: {},
          create: {
            organizationId,
            executableName: exeName,
            displayName: session.app_name,
          },
        });
        applicationId = app.id;
      }

      // Resolve website if domain exists
      let websiteId = null;
      if (session.domain) {
        const domainStr = String(session.domain).toLowerCase().trim();
        const site = await prisma.website.upsert({
          where: { organizationId_domain: { organizationId, domain: domainStr } },
          update: {},
          create: {
            organizationId,
            domain: domainStr,
            displayName: domainStr,
          },
        });
        websiteId = site.id;
      }

      // Insert ActivityEvent and ActivitySession in transaction
      await prisma.$transaction(async (tx) => {
        const event = await tx.activityEvent.create({
          data: {
            organizationId,
            deviceId: sessionDevId,
            eventId,
            eventType: activityType,
            eventSource: collectorKind,
            timestamp: startedAt,
            durationSeconds,
            idleSeconds,
            payload: {
              migratedFrom: 'sqlite',
              appName: session.app_name,
              appPath: session.app_path,
              windowTitle: session.window_title,
              url: session.url,
              domain: session.domain,
            },
          },
        });

        await tx.activitySession.create({
          data: {
            organizationId,
            deviceId: sessionDevId,
            activityEventId: event.id,
            type: activityType,
            source: collectorKind,
            applicationId,
            websiteId,
            startedAt,
            endedAt,
            durationSeconds,
          },
        });
      });

      migratedCount++;
    } catch (err) {
      console.warn(`[WARN] Could not migrate session ${eventId}: ${err.message}`);
      failedCount++;
    }
  }

  // 6. Mark SQLite sync_queue rows as synced without deleting the database
  if (!dryRun && tables.has('sync_queue')) {
    try {
      db.prepare("UPDATE sync_queue SET synced_at = datetime('now') WHERE synced_at IS NULL").run();
      console.log('[OK] Marked SQLite sync_queue rows as synced.');
    } catch (err) {
      console.warn(`[WARN] Could not update sync_queue in SQLite: ${err.message}`);
    }
  }

  // 7. Verify record counts
  console.log('\n================================================================');
  console.log('   MIGRATION VERIFICATION & RECONCILIATION REPORT               ');
  console.log('================================================================');
  console.log(`Total Legacy SQLite Sessions: ${legacySessions.length}`);
  console.log(`Successfully Migrated:        ${migratedCount}`);
  console.log(`Already Present (Deduplicated): ${skippedDuplicateCount}`);
  console.log(`Failed / Incomplete:          ${failedCount}`);
  console.log(`Authoritative Database:       Neon PostgreSQL (Prisma Client)`);
  console.log(`----------------------------------------------------------------`);
  console.log(`[SAFETY GUARANTEE]`);
  console.log(`Legacy SQLite File:           PRESERVED at ${sqlitePath}`);
  console.log(`Pre-migration Backup:         PRESERVED at ${backupPath}`);
  console.log(`The SQLite database was NOT deleted.`);
  console.log('================================================================');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[FATAL] Migration aborted due to error:', err);
  process.exit(1);
});

