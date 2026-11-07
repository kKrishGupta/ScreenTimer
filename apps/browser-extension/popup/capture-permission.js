import { CAPTURE_PERMISSION, hasCapturePermission } from '../shared/capture-permissions.js';

export function initializeCapturePermission(document, chromeApi) {
  const grant = document.getElementById('capture-permission-grant');
  const revoke = document.getElementById('capture-permission-revoke');
  const status = document.getElementById('capture-permission-status');
  async function render(message = '') {
    const allowed = await hasCapturePermission(chromeApi);
    grant.hidden = allowed;
    revoke.hidden = !allowed;
    status.textContent = message || (allowed
      ? 'Browser permission granted. Server authorization is still required; ON indicates authorized screenshot monitoring.'
      : 'Browser screenshot permission is off. No screenshots will be captured.');
  }
  grant.addEventListener('click', async () => {
    try {
      // Must be the first asynchronous call: retain the browser user gesture.
      const granted = await chromeApi.permissions.request(CAPTURE_PERMISSION);
      await render(granted ? '' : 'Permission declined. Screenshots remain off.');
    } catch { await render('Permission request failed. Screenshots remain off.'); }
  });
  revoke.addEventListener('click', async () => {
    try { await chromeApi.permissions.remove(CAPTURE_PERMISSION); await render(); }
    catch { await render('Could not remove permission. Use the browser extension site-access settings.'); }
  });
  void render();
}
