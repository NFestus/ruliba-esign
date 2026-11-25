import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { vi } from 'vitest';
import { App } from './App';
import { AuthProvider } from './auth';
import { PasswordField } from './components/ui';

function Providers({ path, children }: { path: string; children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

function WhereAmI() {
  return <output data-testid="path">{useLocation().pathname}</output>;
}

describe('web app', () => {
  beforeEach(() => {
    // No session cookie: refresh fails, so the app shows the sign-in page.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
  });

  it('sends a signed-out visitor to the sign-in page', async () => {
    render(
      <Providers path="/settings/users">
        <AuthProvider>
          <App />
        </AuthProvider>
      </Providers>,
    );
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  });

  it('sends a signed-in person without the role from an admin page to the homepage', async () => {
    const user = { id: 'u1', email: 'sender@ruliba.com', fullName: 'Sam Sender', jobTitle: null, departmentId: null, roles: ['SENDER', 'SIGNER'], mfaEnabled: false, mfaMethod: null, mfaRequired: false, mustChangePassword: false };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/auth/refresh')
          ? new Response(JSON.stringify({ accessToken: 't', expiresIn: 600, idleExpiresAt: new Date(Date.now() + 1_800_000).toISOString(), sessionExpiresAt: new Date(Date.now() + 43_200_000).toISOString(), idleMinutes: 30, user }), { status: 200 })
          : new Response('[]', { status: 200 }),
      ),
    );
    render(
      <Providers path="/settings/users">
        <AuthProvider>
          <App />
          <WhereAmI />
        </AuthProvider>
      </Providers>,
    );
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent(/^\/$/));
    expect(screen.queryByPlaceholderText('Search by name or email')).not.toBeInTheDocument();
  });

  it('labels the show-password control for screen readers', () => {
    render(<PasswordField label="Password" />);
    expect(screen.getByRole('button', { name: 'Show password' })).toBeInTheDocument();
  });
});

describe('automatic sign-out', () => {
  const user = { id: 'u2', email: 'clerk@ruliba.com', fullName: 'Cleo Clerk', jobTitle: null, departmentId: null, roles: ['SENDER'], mfaEnabled: false, mfaMethod: null, mfaRequired: false, mustChangePassword: false };
  const session = (idleInMs: number) => ({
    accessToken: 't',
    expiresIn: 600,
    idleExpiresAt: new Date(Date.now() + idleInMs).toISOString(),
    sessionExpiresAt: new Date(Date.now() + 12 * 3_600_000).toISOString(),
    idleMinutes: 30,
    user,
  });
  let calls: string[];

  function serve(firstIdleMs: number) {
    calls = [];
    let refreshes = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url));
        if (String(url).includes('/auth/refresh')) {
          refreshes++;
          return new Response(JSON.stringify(session(refreshes === 1 ? firstIdleMs : 30 * 60_000)), { status: 200 });
        }
        if (String(url).includes('/auth/logout')) return new Response(null, { status: 204 });
        return new Response('[]', { status: 200 });
      }),
    );
  }

  function renderApp() {
    render(
      <Providers path="/">
        <AuthProvider>
          <App />
        </AuthProvider>
      </Providers>,
    );
  }

  beforeEach(() => localStorage.clear());

  it('warns before signing out an idle person, and "Stay signed in" renews the sign-in', async () => {
    serve(90_000); // 1 minute 30 left
    renderApp();
    expect(await screen.findByRole('dialog', { name: 'Are you still there?' })).toBeInTheDocument();
    screen.getByRole('button', { name: 'Stay signed in' }).click();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Are you still there?' })).not.toBeInTheDocument());
    expect(calls.filter((u) => u.includes('/auth/refresh')).length).toBeGreaterThanOrEqual(2);
  });

  it('signs out when the idle time runs out and says why on the sign-in page', async () => {
    serve(1500);
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Welcome back' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText(/signed out because nothing happened for a while/)).toBeInTheDocument();
    expect(calls.some((u) => u.includes('/auth/logout'))).toBe(true);
  });

  it('does not renew a sign-in from background requests alone', async () => {
    const { api, applySession, markActivity } = await import('./api');
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return String(url).includes('/auth/refresh') ? new Response(JSON.stringify(session(30 * 60_000)), { status: 200 }) : new Response('{}', { status: 401 });
      }),
    );
    applySession(session(30 * 60_000));
    await api('/documents').catch(() => undefined);
    expect(calls.some((u) => u.includes('/auth/refresh'))).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    markActivity();
    await api('/documents').catch(() => undefined);
    expect(calls.some((u) => u.includes('/auth/refresh'))).toBe(true);
  });
});
