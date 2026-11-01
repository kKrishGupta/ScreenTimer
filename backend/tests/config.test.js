import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../src/shared/config.js';

const base = { DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/db' };

test('defaults bind to loopback port 3001', () => {
  const cfg = loadConfig({ ...base });
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.port, 3001);
  assert.deepEqual(cfg.corsOrigins, ['http://localhost:5173', 'http://127.0.0.1:5173']);
});

test('refuses non-loopback HOST (Stage 1 is localhost-only)', () => {
  assert.throws(() => loadConfig({ ...base, HOST: '0.0.0.0' }), ConfigError);
});

test('requires a postgresql DATABASE_URL', () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL is required/);
  assert.throws(() => loadConfig({ DATABASE_URL: 'mysql://x@y/z' }), /postgresql/);
  assert.throws(() => loadConfig({ DATABASE_URL: 'not a url' }), /valid URL/);
});

test('validates PORT and LOG_LEVEL', () => {
  assert.throws(() => loadConfig({ ...base, PORT: '70000' }), /PORT/);
  assert.throws(() => loadConfig({ ...base, LOG_LEVEL: 'verbose' }), /LOG_LEVEL/);
});

