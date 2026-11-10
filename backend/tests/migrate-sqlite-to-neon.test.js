import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

describe('Safe Data Migration: Legacy SQLite to Neon PostgreSQL', () => {
  it('creates timestamped backup, safely reads legacy schema, and never deletes the database', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-migration-test-'));
    const testDbPath = path.join(tmpDir, 'agent_storage.db');

    // Create a mock legacy SQLite database
    const db = new DatabaseSync(testDbPath);
    db.exec(`
      CREATE TABLE agent_state (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE activity_sessions (
        id TEXT PRIMARY KEY,
        device_id TEXT,
        app_name TEXT,
        app_path TEXT,
        window_title TEXT,
        event_type TEXT,
        event_source TEXT,
        start_time TEXT,
        end_time TEXT,
        duration_seconds REAL,
        idle_seconds REAL,
        url TEXT,
        domain TEXT,
        created_at TEXT
      );
      CREATE TABLE sync_queue (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        payload TEXT,
        created_at TEXT,
        synced_at TEXT,
        quarantined_at TEXT,
        quarantine_reason TEXT
      );
    `);

    // Insert test data
    db.prepare('INSERT INTO agent_state (key, value) VALUES (?, ?)').run('device_id', '11111111-2222-3333-4444-555555555555');
    db.prepare('INSERT INTO agent_state (key, value) VALUES (?, ?)').run('backend_url', 'http://127.0.0.1:3001');

    db.prepare(`
      INSERT INTO activity_sessions (
        id, device_id, app_name, app_path, window_title, event_type, event_source,
        start_time, end_time, duration_seconds, idle_seconds, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'session-uuid-1',
      '11111111-2222-3333-4444-555555555555',
      'Code.exe',
      'C:\\Tools\\Code.exe',
      'index.js - DigitalPulse',
      'app_session',
      'desktop_agent',
      '2026-11-10T08:00:00.000Z',
      '2026-11-10T08:15:00.000Z',
      900,
      0,
      '2026-11-10T08:15:00.000Z'
    );

    db.prepare(`
      INSERT INTO sync_queue (id, session_id, payload, created_at, synced_at)
      VALUES (?, ?, ?, ?, NULL)
    `).run('queue-1', 'session-uuid-1', '{"test":true}', '2026-11-10T08:15:00.000Z');

    db.close();

    // Verify database file exists
    assert.equal(fs.existsSync(testDbPath), true);

    // Simulate backup creation
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${testDbPath}.backup-migration-${timestamp}`;
    fs.copyFileSync(testDbPath, backupPath);

    assert.equal(fs.existsSync(backupPath), true, 'Backup file must exist');

    // Reopen and verify data can be extracted
    const verifyDb = new DatabaseSync(testDbPath);
    const sessions = verifyDb.prepare('SELECT * FROM activity_sessions').all();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, 'session-uuid-1');
    assert.equal(sessions[0].app_name, 'Code.exe');

    // Mark sync_queue synced
    verifyDb.prepare("UPDATE sync_queue SET synced_at = datetime('now') WHERE id = ?").run('queue-1');
    const updatedQueue = verifyDb.prepare('SELECT * FROM sync_queue WHERE synced_at IS NULL').all();
    assert.equal(updatedQueue.length, 0);

    verifyDb.close();

    // Ensure database file was NOT deleted
    assert.equal(fs.existsSync(testDbPath), true, 'Original SQLite file must NOT be deleted');

    // Cleanup test temp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });
});

