// Production requests must stay on the dashboard origin.  The Vercel rewrite
// forwards /api/v1 to Fastify, so the HttpOnly session cookie is first-party.
// An old absolute VITE_API_BASE_URL would make this a cross-site cookie flow;
// SameSite=Lax correctly prevents that cookie from being sent on fetches.
const configuredApiBase = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';
export const API_BASE = (
  import.meta.env.PROD && !configuredApiBase.startsWith('/')
    ? '/api/v1'
    : configuredApiBase
).replace(/\/$/, '');
const DEFAULT_TIMEOUT_MS = 8000;

function clearLegacyTokens() {
  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem('dp_auth_token');
      sessionStorage.removeItem('dp_auth_token');
    } catch {
      // Browser storage is not part of the active HttpOnly-cookie session design.
    }
  }
}

clearLegacyTokens();

// Kept as a compatibility shim for callers while tokens remain HttpOnly cookies.
export function setAuthToken() { clearLegacyTokens(); }
export function getAuthToken() { return null; }

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'NETWORK_ERROR', body, retryAfterSeconds = 0 } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Executes an HTTP fetch request with timeout and error wrapping.
 */
async function request(path, { method = 'GET', body, signal, acceptStatuses = [], timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });

  const headers = {
    Accept: 'application/json',
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
  };

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      credentials: 'include',
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ApiError('Cannot reach the DigitalPulse service. Check your connection and try again.', {
      code: err?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR',
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  const resBody = await res.json().catch(() => null);
  const isProxyGatewayError = res.status === 503 && resBody?.error?.code === 'BACKEND_OFFLINE';
  if ((res.ok || acceptStatuses.includes(res.status)) && !isProxyGatewayError) return resBody;
  throw new ApiError(resBody?.error?.message ?? `Request failed with status ${res.status}`, {
    status: res.status,
    code: resBody?.error?.code ?? 'HTTP_ERROR',
    body: resBody,
    retryAfterSeconds: res.status === 429 ? Math.max(0, Number(res.headers.get('Retry-After')) || 0) : 0,
  });
}

export function getJson(path, opts) {
  return request(path, { ...opts, method: 'GET' });
}

export function postJson(path, body, opts) {
  return request(path, { ...opts, method: 'POST', body });
}

export function patchJson(path, body, opts) {
  return request(path, { ...opts, method: 'PATCH', body });
}

export function deleteJson(path, opts) {
  return request(path, { ...opts, method: 'DELETE' });
}

export async function downloadActivityCsv(params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '')).toString();
  const headers = { Accept: 'text/csv' };
  const response = await fetch(`${API_BASE}/analytics/export/csv${query ? `?${query}` : ''}`, { headers, credentials: 'include' });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(body?.error?.message || `CSV export failed with status ${response.status}`, { status: response.status, code: body?.error?.code || 'HTTP_ERROR', body });
  }
  return response.blob();
}

function toQueryString(params = {}) {
  const clean = Object.entries(params).filter(([_, v]) => v !== undefined && v !== null && v !== '' && v !== 'undefined');
  if (clean.length === 0) return '';
  return `?${new URLSearchParams(Object.fromEntries(clean)).toString()}`;
}

export const api = {
  login: (credentials, opts = {}) => postJson('/auth/login', credentials, opts),
  organizationLogin: (credentials, opts = {}) => postJson('/organization/login', credentials, opts),
  superAdminLogin: (credentials, opts = {}) => postJson('/super-admin/login', credentials, opts),
  registerOrganization: (details, opts = {}) => postJson('/organization/register', details, opts),
  logout: (opts = {}) => postJson('/auth/logout', {}, opts),
  requestPasswordReset: (email, opts = {}) => postJson('/auth/reset-password-request', { email }, { timeoutMs: 45000, ...opts }),
  confirmPasswordReset: (details, opts = {}) => postJson('/auth/reset-password-confirm', details, opts),
  acceptInvitation: (details, opts = {}) => postJson('/auth/invitations/accept', details, opts),
  me: (opts = {}) => getJson('/auth/me', opts),
  health: (opts) => getJson('/health', { ...opts, acceptStatuses: [503] }),
  summary: (params = {}, opts = {}) => getJson(`/activity/summary${toQueryString(params)}`, opts),
  timeline: (params = {}, opts = {}) => getJson(`/activity/timeline${toQueryString(params)}`, opts),
  apps: (params = {}, opts = {}) => getJson(`/activity/apps${toQueryString(params)}`, opts),
  websites: (params = {}, opts = {}) => getJson(`/activity/websites${toQueryString(params)}`, opts),
  devices: (opts = {}) => getJson('/devices', opts),
  myMonitoringStatus: (opts = {}) => getJson('/devices/my-monitoring-status', opts),
  setMyMonitoringConsent: (consent, opts = {}) => postJson('/devices/my-monitoring-consent', { consent }, opts),
  setMyMonitoringAuthorization: (authorized, opts = {}) => patchJson('/devices/my-monitoring-authorization', { authorized }, opts),
  updateMyMonitoringSchedule: (schedule, opts = {}) => patchJson('/devices/my-monitoring-schedule', schedule, opts),
  updateOrganizationTimezone: (timezone, opts = {}) => patchJson('/devices/organization-timezone', { timezone }, opts),
  createMyEnrollmentToken: (deviceKind, opts = {}) => postJson('/devices/my-enrollment-token', { deviceKind }, opts),

  // Screen Monitoring & Screenshot Policy (Milestone 7 & 8)
  screenConfig: (opts = {}) => getJson('/screen/config', opts),
  postScreenPolicy: (policy, opts = {}) => postJson('/screen/policy', policy, opts),
  screenCaptures: (params = {}, opts = {}) => getJson(`/screen/captures${toQueryString(params)}`, opts),
  grantScreenConsent: (opts = {}) => postJson('/screen/consent', { consent: true }, opts),
  revokeScreenConsent: (opts = {}) => postJson('/screen/consent', { consent: false }, opts),
  postScreenConsent: (consent, opts = {}) => postJson('/screen/consent', { consent: typeof consent === 'boolean' ? consent : true }, opts),
  postScreenState: (action, pauseMinutes, opts = {}) => postJson('/screen/state', { action, pauseMinutes }, opts),
  postScreenCapture: (applicationName, opts = {}) => postJson('/screen/capture', { applicationName }, opts),
  deleteScreenCapture: (id, opts = {}) => deleteJson(`/screen/captures/${id}`, opts),
  purgeScreenCaptures: (olderThanDays, opts = {}) => postJson('/screen/retention/purge', { olderThanDays }, opts),
  startLiveSession: (durationMinutes, opts = {}) => postJson('/screen/live-session/start', { durationMinutes }, opts),
  stopLiveSession: (opts = {}) => postJson('/screen/live-session/stop', {}, opts),
  screenAuditLog: (params = {}, opts = {}) => getJson(`/screen/audit-log${toQueryString(params)}`, opts),

  // Family Planner & Wellbeing (Milestone 8)
  plannerTasks: (opts = {}) => getJson('/planner/tasks', opts),
  createPlannerTask: (task, opts = {}) => postJson('/planner/tasks', task, opts),
  updatePlannerTask: (id, updates, opts = {}) => patchJson(`/planner/tasks/${id}`, updates, opts),
  deletePlannerTask: (id, opts = {}) => deleteJson(`/planner/tasks/${id}`, opts),
  plannerGoals: (opts = {}) => getJson('/planner/goals', opts),
  savePlannerGoal: (goal, opts = {}) => postJson('/planner/goals', goal, opts),
  focusSessions: (opts = {}) => getJson('/planner/focus-sessions', opts),
  startFocusSession: (session, opts = {}) => postJson('/planner/focus-sessions/start', session, opts),
  stopFocusSession: (opts = {}) => postJson('/planner/focus-sessions/stop', {}, opts),
  plannerAnalytics: (opts = {}) => getJson('/planner/analytics', opts),
  wellbeingStatus: (opts = {}) => getJson('/wellbeing/status', opts),
  completeBreak: (opts = {}) => postJson('/wellbeing/break/complete', {}, opts),

  // Enterprise Employee Management
  employees: (params = {}, opts = {}) => getJson(`/employees${toQueryString(params)}`, opts),
  liveEmployees: (params = {}, opts = {}) => getJson(`/employees/live${toQueryString(params)}`, opts),
  employee: (id, opts = {}) => getJson(`/employees/${id}`, opts),
  employeeSetupReminder: (employeeId, opts = {}) => postJson(`/employees/${encodeURIComponent(employeeId)}/setup-reminder`, {}, opts),
  createEmployee: (emp, opts = {}) => postJson('/employees', emp, opts),
  updateEmployee: (id, updates, opts = {}) => patchJson(`/employees/${id}`, updates, opts),
  setEmployeeMonitoringAuthorization: (id, authorized, opts = {}) => patchJson(`/employees/${id}/monitoring-authorization`, { authorized }, opts),
  deleteEmployee: (id, opts = {}) => deleteJson(`/employees/${id}`, opts),
  assignEmployeeDevice: (id, deviceId, opts = {}) => postJson(`/employees/${id}/devices`, { deviceId }, opts),
  inviteEmployee: (payload, opts = {}) => postJson('/invitations', payload, opts),
  invitations: (opts = {}) => getJson('/invitations', opts),
  validateInvitation: (token, opts = {}) => postJson('/invitations/validate', { token }, opts),
  revokeInvitation: (id, opts = {}) => deleteJson(`/invitations/${id}`, opts),
  resendInvitation: (id, opts = {}) => postJson(`/invitations/${id}/resend`, {}, opts),

  // Department Governance
  departments: (opts = {}) => getJson('/departments', opts),
  createDepartment: (dept, opts = {}) => postJson('/departments', dept, opts),
  deleteDepartment: (id, opts = {}) => deleteJson(`/departments/${id}`, opts),

  // Family Management & Policy Engine (Legacy compatibility)
  familyMembers: (opts = {}) => getJson('/family/members', opts),
  createFamilyMember: (member, opts = {}) => postJson('/family/members', member, opts),
  updateFamilyMember: (id, updates, opts = {}) => patchJson(`/family/members/${id}`, updates, opts),
  deleteFamilyMember: (id, opts = {}) => deleteJson(`/family/members/${id}`, opts),
  assignFamilyDevice: (id, deviceId, opts = {}) => postJson(`/family/members/${id}/devices`, { deviceId }, opts),
  policies: (opts = {}) => getJson('/policies', opts),
  createPolicy: (policy, opts = {}) => postJson('/policies', policy, opts),
  updatePolicy: (id, updates, opts = {}) => patchJson(`/policies/${id}`, updates, opts),
  deletePolicy: (id, opts = {}) => deleteJson(`/policies/${id}`, opts),
  resetStrictness: (id, opts = {}) => postJson(`/policies/${id}/reset-strictness`, {}, opts),
  checkPolicy: (target, opts = {}) => postJson('/policies/check', target, opts),
  policyViolations: (opts = {}) => getJson('/policies/violations', opts),
  acknowledgeViolation: (id, opts = {}) => postJson(`/policies/violations/${id}/acknowledge`, {}, opts),
  graceGrants: (opts = {}) => getJson('/policies/grace', opts),
  graceVisit: (domain, opts = {}) => postJson('/policies/grace/visit', { domain }, opts),
  graceReset: (domain, additionalMinutes = 15, opts = {}) => postJson('/policies/grace/reset', { domain, additionalMinutes }, opts),
  declarativeRules: (opts = {}) => getJson('/policies/declarative-rules', opts),
  alerts: (opts = {}) => getJson('/alerts', opts),
  exportActivityCsv: downloadActivityCsv,

  // Advanced Digital Wellbeing Analytics
  dailyAnalytics: (params = {}, opts = {}) => getJson(`/analytics/daily${toQueryString(typeof params === 'string' ? { date: params } : params)}`, opts),
  weeklyAnalytics: (params = {}, opts = {}) => getJson(`/analytics/weekly${toQueryString(params)}`, opts),
  setCategory: (target, category, opts = {}) => postJson('/analytics/categories', { target, category }, opts),
};
