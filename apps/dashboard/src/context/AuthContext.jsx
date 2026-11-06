
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { api, setAuthToken } from '../lib/api.js';

const AuthContext = createContext(null);

function normalizeDashboardUser(user) {
  if (!user) return user;

  const role = String(user.role || '').toUpperCase();

  const roleMap = {
    SUPER_ADMIN: 'SUPER_ADMIN',
    ADMIN: 'ADMIN',
    EMPLOYEE: 'EMPLOYEE',
  };

  return {
    ...user,
    role: roleMap[role] || 'UNKNOWN',
  };
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    api.me()
      .then((result) => {
        if (active) {
          const profile = normalizeDashboardUser(result.user || result);
          setUser(profile?.id && ['SUPER_ADMIN', 'ADMIN', 'EMPLOYEE'].includes(profile.role) ? profile : null);
        }
      })
      .catch(() => {
        if (active) {
          setAuthToken(null);
          setUser(null);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const value = useMemo(() => ({
    user,
    loading,
    isAuthenticated: Boolean(user),

    async login(credentials, options = {}) {
      const loginType = options.loginType || 'employee';
      const loginMethod = loginType === 'admin' ? api.organizationLogin
        : loginType === 'super-admin' ? api.superAdminLogin : api.login;
      const result = await loginMethod({
        ...credentials,
        rememberMe: options.remember !== false,
      });

      try {
        const profile = await api.me();
        const authenticatedUser = normalizeDashboardUser(
          profile.user || profile
        );

        if (!authenticatedUser?.id ||
            !['SUPER_ADMIN', 'ADMIN', 'EMPLOYEE'].includes(authenticatedUser.role)) {
          throw new Error('This account has no supported dashboard role.');
        }

        const expectedRole = { employee: 'EMPLOYEE', admin: 'ADMIN', 'super-admin': 'SUPER_ADMIN' }[loginType];
        if (authenticatedUser.role !== expectedRole) {
          throw new Error('This account cannot access this login portal.');
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
      return api.registerOrganization(details);
    },

    async logout() {
      try {
        await api.logout();
      } finally {
        setAuthToken(null);
        setUser(null);
      }
    },
  }), [loading, user]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
