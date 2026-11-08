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
          ? new Response(JSON.stringify({ accessToken: 't', expiresIn: 900, user }), { status: 200 })
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
