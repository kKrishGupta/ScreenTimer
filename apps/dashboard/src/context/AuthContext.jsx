import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { api, setAuthToken } from '../lib/api.js';

const AuthContext = createContext(null);

function normalizeDashboardUser(user) {
  if (!user) return user;
  const role = String(user.role || '').toUpperCase();
  const canonicalRole = ['OWNER', 'ORG_ADMIN', 'FAMILY_OWNER'].includes(role)
    ? 'ORGANIZATION_ADMIN'
    : ['MEMBER', 'ADULT_MEMBER', 'SUPERVISED_MEMBER'].includes(role)
      ? 'EMPLOYEE'
      : role;
  return { ...user, role: canonicalRole };
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    api.me()
      .then((result) => { if (active) setUser(normalizeDashboardUser(result.user || result)); })
      .catch(() => { if (active) { setAuthToken(null); setUser(null); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const value = useMemo(() => ({
    user,
    loading,
    isAuthenticated: Boolean(user),
    async login(credentials, options = {}) {
      const result = await api.login({ ...credentials, rememberMe: options.remember !== false });
      try {
        const profile = await api.me();
        const authenticatedUser = normalizeDashboardUser(profile.user || profile);
        if (!authenticatedUser?.id || !authenticatedUser?.role) {
          throw new Error('Authenticated user profile is incomplete.');
        }
        if (!['SUPER_ADMIN', 'FAMILY_OWNER', 'ORGANIZATION_ADMIN', 'MANAGER', 'EMPLOYEE'].includes(authenticatedUser.role)) {
          throw new Error('This account has no supported dashboard role.');
        }
        setUser(authenticatedUser);
        return { ...result, user: authenticatedUser };
      } catch (error) {
        await api.logout().catch(() => {});
        setAuthToken(null);
        setUser(null);
        throw error;
      }
    },
    async register(details) {
      return api.register(details);
    },
    async logout() {
      try { await api.logout(); } finally {
        setAuthToken(null);
        setUser(null);
      }
    },
  }), [loading, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
