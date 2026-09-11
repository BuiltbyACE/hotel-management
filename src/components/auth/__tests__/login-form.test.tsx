// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LoginForm } from '@/components/auth/login-form';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
}));

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <LoginForm />
    </QueryClientProvider>,
  );
}

function signInResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  replace.mockReset();
});

describe('LoginForm', () => {
  it('renders the credential fields and submit button', () => {
    wrap();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('posts credentials and navigates to the dashboard on success', async () => {
    const fetchMock = vi.fn(async () =>
      signInResponse({
        token: 't',
        user: { id: 'u1', name: 'Ada', email: 'ada@hotm.test', role: 'admin', mustChangePassword: false },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    wrap();

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@hotm.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Pass123!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard'));
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/sign-in/email', expect.anything());
  });

  it('shows the invalid-credentials alert on a 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => signInResponse({ code: 'INVALID_CREDENTIALS', title: 'Invalid credentials' }, 401)),
    );
    wrap();

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@hotm.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Incorrect email or password. Try again.')).toBeInTheDocument();
  });

  it('shows the disabled-account alert on a 403 problem response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => signInResponse({ code: 'ACCOUNT_DISABLED', title: 'Account has been disabled' }, 403)),
    );
    wrap();

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@hotm.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'GoodPass123!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Account disabled')).toBeInTheDocument();
  });
});