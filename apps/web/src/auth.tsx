import { useQueryClient } from '@tanstack/react-query';
import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { applySession, logout as apiLogout, PublicUser, refreshSession, Session, setSessionListener } from './api';

interface AuthState {
  user: PublicUser | null;
  ready: boolean;
  setSession: (s: Session | null) => void;
  setUser: (u: PublicUser) => void;
  logout: () => Promise<void>;
  hasRole: (...roles: string[]) => boolean;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<PublicUser | null>(null);
  const [ready, setReady] = useState(false);
  const queryClient = useQueryClient();
  const lastUserId = useRef<string | null>(null);

  // Data loaded for one person must never be shown to the next one on the same browser:
  // whenever the signed-in person changes (sign-out, or someone else signs in), drop every cached answer.
  useEffect(() => {
    const id = user?.id ?? null;
    if (id !== lastUserId.current) {
      queryClient.cancelQueries();
      queryClient.clear();
      lastUserId.current = id;
    }
  }, [user?.id, queryClient]);

  useEffect(() => {
    setSessionListener((s) => setUserState(s?.user ?? null));
    // Restore the session from the refresh cookie after a page reload.
    refreshSession().finally(() => setReady(true));
  }, []);

  // Renew the 15-minute access token a minute before it ends, while the tab is open.
  useEffect(() => {
    if (!user) return;
    const t = window.setInterval(() => void refreshSession(), 13 * 60_000);
    return () => window.clearInterval(t);
  }, [user]);

  const setSession = useCallback((s: Session | null) => applySession(s), []);
  const logout = useCallback(async () => apiLogout(), []);
  const hasRole = useCallback((...roles: string[]) => !!user && roles.some((r) => user.roles.includes(r)), [user]);

  return <Ctx.Provider value={{ user, ready, setSession, setUser: setUserState, logout, hasRole }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
