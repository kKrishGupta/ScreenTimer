export const SESSION_COOKIE_NAME = 'dp_session';

/** Read a browser session cookie, while retaining bearer support for trusted API clients. */
export function readSessionToken(request) {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith('Bearer ')) {
    const candidate = authorization.slice(7).trim();
    if (!candidate.startsWith('dp_sec_')) return candidate;
  }

  const cookieHeader = request.headers.cookie;
  if (typeof cookieHeader !== 'string') return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    return /^[a-f0-9]{64}$/i.test(value) ? value : null;
  }
  return null;
}

export function serializeSessionCookie(token, { secure = false, maxAgeSeconds } = {}) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${token || ''}`,
    'Path=/api/v1',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  if (Number.isInteger(maxAgeSeconds)) parts.push(`Max-Age=${Math.max(0, maxAgeSeconds)}`);
  return parts.join('; ');
}
