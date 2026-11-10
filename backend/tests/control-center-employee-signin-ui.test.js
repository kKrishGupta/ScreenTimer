import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sourceUrl = new URL('../../apps/control-center/src/ControlCenter.cs', import.meta.url);

test('Control Center employee sign-in collects email, password, and masked one-time key', async () => {
  const source = await readFile(sourceUrl, 'utf8');
  assert.match(source, /Employee Email ID/);
  assert.match(source, /Employee Secret Key \(Enrollment Key\)/);
  assert.match(source, /password\.UseSystemPasswordChar = true/);
  assert.match(source, /secretKey\.UseSystemPasswordChar = true/);
  assert.match(source, /Show Secret Key/);
  assert.match(source, /Sign In & Enroll/);
  assert.match(source, /Already Enrolled — Sign In/);
  assert.match(source, /firstTimeEnrollment && enrollmentKey\.Length == 0/);
});

test('Control Center sends secrets only through redirected stdin and never command arguments', async () => {
  const source = await readFile(sourceUrl, 'utf8');
  assert.match(source, /RedirectStandardInput = true/);
  assert.match(source, /StandardInput\.WriteLine\(cookieHeader\)/);
  assert.match(source, /StandardInput\.WriteLine\(enrollmentKey \?\? string\.Empty\)/);
  assert.doesNotMatch(source, /Arguments\s*=\s*[^;]*(?:userPassword|enrollmentKey|cookieHeader)/);
  assert.match(source, /Monitoring remains stopped/);
});
