import { describe, expect, it } from 'vitest';
import { nativeErrorMessage } from './native-error';

describe('native error presentation', () => {
  it('uses an actionable safe message from a serialized command error', () => {
    expect(nativeErrorMessage('{"code":"DEVICE_REVOKED","message":"This device was revoked."}'))
      .toBe('This device was revoked.');
  });

  it('does not invent details for an unknown error', () => {
    expect(nativeErrorMessage({})).toBe('The operation could not be completed.');
  });
});
