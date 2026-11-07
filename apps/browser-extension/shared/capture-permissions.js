// captureVisibleTab requires this literal host grant for unattended captures.
// Never request it from the worker: only an explicit popup user gesture may do so.
export const CAPTURE_PERMISSION = { origins: ['<all_urls>'] };

export async function hasCapturePermission(chromeApi) {
  try { return await chromeApi.permissions.contains(CAPTURE_PERMISSION) === true; }
  catch { return false; }
}
