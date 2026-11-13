import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, resolveDatabaseUrl } from '../src/shared/config.js';

const base = { DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/db' };

test('defaults bind to loopback port 3001', () => {
  const cfg = loadConfig({ ...base });
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.port, 3001);
  assert.deepEqual(cfg.corsOrigins, ['http://localhost:5173', 'http://127.0.0.1:5173']);
});

test('allows explicit LAN binding for phone testing', () => {
  const cfg = loadConfig({ ...base, HOST: '0.0.0.0' });
  assert.equal(cfg.host, '0.0.0.0');
});

test('requires a postgresql DATABASE_URL', () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL is required/);
  assert.throws(() => loadConfig({ DATABASE_URL: 'mysql://x@y/z' }), /postgresql/);
  assert.throws(() => loadConfig({ DATABASE_URL: 'not a url' }), /valid URL/);
});

test('accepts legacy DATABASE while preferring canonical DATABASE_URL', () => {
  const legacy = loadConfig({ DATABASE: 'postgresql://legacy:legacy@127.0.0.1:5433/legacy' });
  assert.equal(legacy.databaseUrl, 'postgresql://legacy:legacy@127.0.0.1:5433/legacy');
  assert.equal(resolveDatabaseUrl({
    DATABASE: 'postgresql://legacy:legacy@127.0.0.1:5433/legacy',
    DATABASE_URL: 'postgresql://canonical:canonical@127.0.0.1:5433/canonical',
  }), 'postgresql://canonical:canonical@127.0.0.1:5433/canonical');
});

test('validates PORT and LOG_LEVEL', () => {
  assert.throws(() => loadConfig({ ...base, PORT: '70000' }), /PORT/);
  assert.throws(() => loadConfig({ ...base, LOG_LEVEL: 'verbose' }), /LOG_LEVEL/);
});

test('uses a conservative bounded database pool for free-tier deployments', () => {
  assert.equal(loadConfig(base).databasePoolMax, 5);
  assert.equal(loadConfig({ ...base, DATABASE_POOL_MAX: '2' }).databasePoolMax, 2);
  for (const value of ['0', '11', '1.5', 'invalid']) {
    assert.throws(() => loadConfig({ ...base, DATABASE_POOL_MAX: value }), /DATABASE_POOL_MAX/);
  }
});

test('bounds configurable password reset expiry to a short lifetime', () => {
  assert.equal(loadConfig(base).passwordResetTtlMinutes, 30);
  assert.equal(loadConfig({ ...base, PASSWORD_RESET_TTL_MINUTES: '10' }).passwordResetTtlMinutes, 10);
  for (const value of ['0', '61', '1.5', 'invalid']) {
    assert.throws(() => loadConfig({ ...base, PASSWORD_RESET_TTL_MINUTES: value }), /PASSWORD_RESET_TTL_MINUTES/);
  }
});

test('maps documented SMTP_PASS and EMAIL_FROM settings to the mail service config', () => {
  const cfg = loadConfig({ ...base, SMTP_USER: 'mailer@example.test', SMTP_PASS: 'secret-value', EMAIL_FROM: 'DigitalPulse <mailer@example.test>' });
  assert.equal(cfg.smtpUser, 'mailer@example.test');
  assert.equal(cfg.smtpPassword, 'secret-value');
  assert.equal(cfg.smtpFrom, 'DigitalPulse <mailer@example.test>');
});

test('defaults to Gmail SMTP and maps the documented Gmail settings', () => {
  const cfg = loadConfig({ ...base, SMTP_USER: 'mailer@gmail.com', SMTP_PASS: 'test-app-password', EMAIL_FROM: 'mailer@gmail.com' });
  assert.equal(cfg.smtpHost, 'smtp.gmail.com');
  assert.equal(cfg.smtpPort, '465');
  assert.equal(cfg.smtpSecure, 'true');
  assert.equal(cfg.smtpUser, 'mailer@gmail.com');
  assert.equal(cfg.smtpPassword, 'test-app-password');
  assert.equal(cfg.smtpFrom, 'mailer@gmail.com');
  assert.throws(() => loadConfig({ ...base, SMTP_HOST: 'smtp.example.test' }), /Gmail SMTP/);
  assert.throws(() => loadConfig({ ...base, SMTP_PORT: '587' }), /Gmail SMTP/);
  assert.throws(() => loadConfig({ ...base, SMTP_SECURE: 'false' }), /Gmail SMTP/);
});

test('requires secure, explicit HTTPS origins and reset URLs in production', () => {
  const production = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://user:pass@db.example.test:5432/dp?sslmode=require',
    PUBLIC_APP_URL: 'https://digitalpulse.example.test',
    PUBLIC_APP_DOMAIN: 'digitalpulse.example.test',
    CORS_ORIGINS: 'https://digitalpulse.example.test',
  };
  const cfg = loadConfig(production);
  assert.equal(cfg.host, '0.0.0.0');
  assert.equal(cfg.secureSessionCookies, true);
  assert.equal(cfg.trustProxy, false);
  assert.equal(cfg.invitationAcceptUrl, 'https://digitalpulse.example.test/accept-invitation');
  assert.equal(cfg.passwordResetUrl, 'https://digitalpulse.example.test/reset-password');
  assert.throws(() => loadConfig({ ...production, CORS_ORIGINS: 'http://digitalpulse.example.test' }), /HTTPS origins/);
  assert.throws(() => loadConfig({ ...production, CORS_ORIGINS: 'https://digitalpulse.example.test,https://other.example.test' }), /only the exact PUBLIC_APP_URL/);
  assert.throws(() => loadConfig({ ...production, PUBLIC_APP_URL: undefined }), /PUBLIC_APP_URL is required/);
  assert.throws(() => loadConfig({ ...production, PUBLIC_APP_DOMAIN: 'other.example.test' }), /match the PUBLIC_APP_URL hostname/);
  assert.throws(() => loadConfig({ ...production, DATABASE_URL: 'postgresql://user:pass@db.example.test:5432/dp' }), /sslmode/);
});

test('proxy trust requires explicit IPs or CIDRs and ports reject trailing junk', () => {
  assert.deepEqual(loadConfig({ ...base, TRUSTED_PROXIES: '127.0.0.1,10.0.0.0/24' }).trustProxy, ['127.0.0.1', '10.0.0.0/24']);
  for (const value of ['true', '1', 'example.com', '10.0.0.1/99']) {
    assert.throws(() => loadConfig({ ...base, TRUSTED_PROXIES: value }), /TRUSTED_PROXIES/);
  }
  assert.throws(() => loadConfig({ ...base, PORT: '3001junk' }), /PORT/);
});
