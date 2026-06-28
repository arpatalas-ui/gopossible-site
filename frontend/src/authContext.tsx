/**
 * AuthContext — wraps the whole app.
 *
 * Holds the current GoPossible user + session token, persists them to
 * SecureStore (native) / localStorage (web), and gates route access:
 *   - splash while loading from storage
 *   - `/login` when no token
 *   - everything else once authenticated
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter, useSegments } from "expo-router";

import { portal, GoPossibleUser, PortalError } from "@/src/gopossible";
import { secureStorage } from "@/src/secureStorage";

const TOKEN_KEY = "@gopossible/session_token_v1";
const USER_KEY = "@gopossible/session_user_v1";

type AuthState = {
  user: GoPossibleUser | null;
  token: string | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState>({
  user: null,
  token: null,
  loading: true,
  login: async () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<GoPossibleUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Hydrate from storage on mount.
  useEffect(() => {
    (async () => {
      try {
        const [t, u] = await Promise.all([
          secureStorage.getItem(TOKEN_KEY),
          secureStorage.getItem(USER_KEY),
        ]);
        if (t && u) {
          setToken(t);
          setUser(JSON.parse(u));
        }
      } catch {
        /* ignore */
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const u = await portal.login(username.trim(), password);
    if (!u.session_token) throw new PortalError("Brak tokenu sesji w odpowiedzi serwera", 500);
    await Promise.all([
      secureStorage.setItem(TOKEN_KEY, u.session_token),
      secureStorage.setItem(USER_KEY, JSON.stringify(u)),
    ]);
    setToken(u.session_token);
    setUser(u);
  }, []);

  const logout = useCallback(async () => {
    await Promise.all([
      secureStorage.removeItem(TOKEN_KEY),
      secureStorage.removeItem(USER_KEY),
    ]);
    setUser(null);
    setToken(null);
  }, []);

  const value = useMemo(() => ({ user, token, loading, login, logout }), [user, token, loading, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

/**
 * Hook installed inside the navigation root that redirects:
 *   - to `/login` when no token
 *   - back to home when on `/login` but already signed in
 */
export function useAuthRedirect() {
  const { token, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    const onLogin = segments[0] === "login";
    if (!token && !onLogin) {
      router.replace("/login");
    } else if (token && onLogin) {
      router.replace("/");
    }
  }, [token, loading, segments, router]);
}
