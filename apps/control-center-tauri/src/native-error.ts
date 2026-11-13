import type { NativeError } from './types';

export function nativeErrorMessage(error: unknown) {
  if (typeof error === 'string') {
    try {
      const parsed = JSON.parse(error) as NativeError;
      return parsed.message || parsed.code || error;
    } catch {
      return error;
    }
  }
  const native = error as NativeError;
  return native?.message || native?.code || 'The operation could not be completed.';
}
