import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..', '..');
const controlCenter = readFileSync(path.join(root, 'apps/control-center/src/ControlCenter.cs'), 'utf8');
const product = readFileSync(path.join(root, 'apps/windows-installer/Product.wxs'), 'utf8');
const bundle = readFileSync(path.join(root, 'apps/windows-installer/Bundle.wxs'), 'utf8');
const dashboard = readFileSync(path.join(root, 'apps/dashboard/src/pages/EmployeeSetupPage.jsx'), 'utf8');

test('Windows portal serves the setup wizard instead of the standalone agent archive', () => {
  assert.match(dashboard, /'\/downloads\/DigitalPulse-Setup\.exe'/);
  assert.doesNotMatch(dashboard, /'\/downloads\/digitalpulse-windows-agent\.zip'/);
});

test('Windows installer preserves local device state during upgrade and uninstall', () => {
  assert.match(product, /Scope="perUser"/);
  assert.match(product, /LocalAppDataFolder/);
  assert.doesNotMatch(product, /agent_storage|DigitalPulse\\queue|Credential Manager/i);
  assert.match(product, /MajorUpgrade/);
  assert.match(bundle, /WixStandardBootstrapperApplication/);
});

test('Control Center keeps sensitive employee enrollment input off process arguments', () => {
  assert.match(controlCenter, /RedirectStandardInput = true/);
  assert.match(controlCenter, /process\.StandardInput\.WriteLine\(enrollmentKey \?\? string\.Empty\)/);
  assert.doesNotMatch(controlCenter, /Arguments\s*=\s*[^;]*(enrollmentKey|userPassword)/);
});

test('Control Center prompts through the existing secure sign-in UI on launch', () => {
  assert.match(controlCenter, /Shown \+= \(s, e\) => BeginInvoke\(new Action\(DpLogin\)\)/);
  assert.match(controlCenter, /Employee Secret Key \(Enrollment Key\)/);
  assert.match(controlCenter, /UseSystemPasswordChar = true/);
});
