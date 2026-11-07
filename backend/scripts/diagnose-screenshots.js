// Read-only screenshot diagnostics. Prints counts/status only, never credentials.
import 'dotenv/config';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 8000 });
try {
  const devices = await pool.query('SELECT kind, is_revoked, (user_id IS NOT NULL) AS assigned, count(*)::int AS devices, max(last_seen_at) AS latest_heartbeat FROM devices GROUP BY kind,is_revoked,(user_id IS NOT NULL)');
  const captures = await pool.query('SELECT capture_status,count(*)::int AS captures,max(captured_at) AS latest_capture FROM screen_captures GROUP BY capture_status');
  console.log(JSON.stringify({ devices: devices.rows, captures: captures.rows }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ diagnosticFailed: true, code: error.code || error.name }));
  process.exitCode = 1;
} finally { await pool.end(); }
