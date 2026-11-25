import { useQueryClient } from '@tanstack/react-query';
import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { applySession, EndReason, logout as apiLogout, markActivity, PublicUser, refreshSession, Session, setSessionListener, sinceRenewal } from './api';
import { Dialog } from './components/ui';

interface AuthState {
  user: PublicUser | null;
  ready: boolean;
  /** Why the last sign-in ended on its own (inactivity, maximum length), for the sign-in page. */
  endReason: EndReason;
  setSession: (s: Session | null) => void;
  setUser: (u: PublicUser) => void;
  logout: () => Promise<void>;
  hasRole: (...roles: string[]) => boolean;
}

const Ctx = createContext<AuthState | null>(null);

/**
 * Session limits are shared by every tab of this browser (they use the same sign-in), so activity in
 * one tab keeps the others signed in. Only times are stored here, never a token.
 */
const LIMITS_KEY = 'esign.session';
interface Limits {
  idleUntil: number;
  endsAt: number;
  idleMinutes: number;
}
function readLimits(): Limits | null {
  try {
    const v = JSON.parse(localStorage.getItem(LIMITS_KEY) ?? 'null') as Limits | null;
    return v && Number.isFinite(v.idleUntil) && Number.isFinite(v.endsAt) ? v : null;
  } catch {
    return null;
  }
}
function writeLimits(s: Session | null) {
  try {
    if (s) {
      localStorage.setItem(LIMITS_KEY, JSON.stringify({ idleUntil: Date.parse(s.idleExpiresAt), endsAt: Date.parse(s.sessionExpiresAt), idleMinutes: s.idleMinutes }));
    } else {
      localStorage.removeItem(LIMITS_KEY);
    }
  } catch {
    // Private mode or storage blocked: each tab then follows its own limits.
  }
}

/** Warn this long before the sign-in ends. */
const WARN_MS = 2 * 60_000;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<PublicUser | null>(null);
  const [ready, setReady] = useState(false);
  const [endReason, setEndReason] = useState<EndReason>(null);
  const queryClient = useQueryClient();
  const lastUserId = useRef<string | null>(null);
  const ownLimits = useRef<Limits | null>(null);

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
    setSessionListener((s, reason) => {
      setUserState(s?.user ?? null);
      if (s) {
        ownLimits.current = { idleUntil: Date.parse(s.idleExpiresAt), endsAt: Date.parse(s.sessionExpiresAt), idleMinutes: s.idleMinutes };
        writeLimits(s);
        setEndReason(null);
      } else {
        ownLimits.current = null;
        if (reason) setEndReason(reason);
      }
    });
    // Restore the session from the refresh cookie after a page reload.
    refreshSession().finally(() => setReady(true));
  }, []);

  const endSession = useCallback(async (reason: EndReason) => {
    await apiLogout();
    setEndReason(reason);
  }, []);

  // While signed in: renew on activity (at most every few minutes), watch the limits, warn, end.
  const [warning, setWarning] = useState<{ kind: 'idle' | 'expired'; endsAt: number } | null>(null);
  const [dismissedEnd, setDismissedEnd] = useState<number | null>(null);
  useEffect(() => {
    if (!user) {
      setWarning(null);
      return;
    }
    const limits = () => readLimits() ?? ownLimits.current;
    let lastMove = 0;
    const onActivity = (e: Event) => {
      if (e.type === 'mousemove') {
        if (Date.now() - lastMove < 1000) return;
        lastMove = Date.now();
      }
      markActivity();
      const l = limits();
      // Renew after a fifth of the idle time (6 minutes by default), so the access token never runs out while someone works.
      if (l && sinceRenewal() > (l.idleMinutes * 60_000) / 5) void refreshSession();
    };
    const events = [...ACTIVITY_EVENTS, 'mousemove'];
    events.forEach((t) => window.addEventListener(t, onActivity, { passive: true, capture: true }));

    const tick = () => {
      const l = limits();
      if (!l) return;
      const now = Date.now();
      const kind = l.endsAt <= l.idleUntil ? 'expired' : 'idle';
      const endsAt = Math.min(l.idleUntil, l.endsAt);
      if (endsAt <= now) {
        setWarning(null);
        void endSession(kind);
      } else if (endsAt - now <= WARN_MS) {
        setWarning({ kind, endsAt });
      } else {
        setWarning(null);
      }
    };
    tick();
    const t = window.setInterval(tick, 1000);
    // Signed out in another tab: sign out here too.
    const onStorage = (e: StorageEvent) => {
      if (e.key === LIMITS_KEY && e.newValue === null) applySession(null);
    };
    window.addEventListener('storage', onStorage);
    return () => {
      events.forEach((t) => window.removeEventListener(t, onActivity, { capture: true }));
      window.clearInterval(t);
      window.removeEventListener('storage', onStorage);
    };
  }, [user, endSession]);

  const setSession = useCallback((s: Session | null) => applySession(s), []);
  const logout = useCallback(async () => {
    writeLimits(null);
    await apiLogout();
  }, []);
  const hasRole = useCallback((...roles: string[]) => !!user && roles.some((r) => user.roles.includes(r)), [user]);
  const stay = useCallback(() => void refreshSession(), []);
  const dismiss = useCallback(() => setDismissedEnd(warning?.endsAt ?? null), [warning?.endsAt]);

  return (
    <Ctx.Provider value={{ user, ready, endReason, setSession, setUser: setUserState, logout, hasRole }}>
      {children}
      {user && warning && !(warning.kind === 'expired' && dismissedEnd === warning.endsAt) && (
        <SessionWarning warning={warning} onStay={stay} onDismiss={dismiss} onSignOut={() => void logout()} />
      )}
    </Ctx.Provider>
  );
}

function SessionWarning({
  warning,
  onStay,
  onDismiss,
  onSignOut,
}: {
  warning: { kind: 'idle' | 'expired'; endsAt: number };
  onStay: () => void;
  onDismiss: () => void;
  onSignOut: () => void;
}) {
  const left = Math.max(0, Math.ceil((warning.endsAt - Date.now()) / 1000));
  const countdown = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  const at = new Intl.DateTimeFormat('en-GB', { timeStyle: 'short', timeZone: 'Africa/Kigali' }).format(warning.endsAt);
  if (warning.kind === 'idle') {
    return (
      <Dialog title="Are you still there?" onClose={onStay}>
        <p>
          For your security, you will be signed out in <b aria-live="polite">{countdown}</b> because nothing has happened for a while.
        </p>
        <div className="row-end">
          <button className="btn" onClick={onSignOut}>
            Sign out
          </button>
          <button className="btn btn-primary" onClick={onStay}>
            Stay signed in
          </button>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog title="Your sign-in is ending" onClose={onDismiss}>
      <p>
        For your security, each sign-in lasts a limited time. You will be signed out at <b>{at}</b> (in <b aria-live="polite">{countdown}</b>). Save what you are working on, then sign in again.
      </p>
      <div className="row-end">
        <button className="btn btn-primary" onClick={onDismiss}>
          OK
        </button>
      </div>
    </Dialog>
  );
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
