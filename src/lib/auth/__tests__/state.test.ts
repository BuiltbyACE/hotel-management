import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import {
  initialLoginState,
  loginReducer,
  outcomeFromLoginError,
  outcomeFromTotpError,
} from '@/lib/auth/state';

function user(overrides: Partial<{ id: string; name: string; email: string; role: 'admin' | 'manager' | 'receptionist' }> = {}) {
  return {
    id: 'u1',
    name: 'Ada',
    email: 'ada@hotm.test',
    role: 'admin' as const,
    status: 'active' as const,
    propertyId: null,
    mustChangePassword: false,
    twoFactorEnabled: false,
    emailVerified: true,
    ...overrides,
  };
}

describe('loginReducer', () => {
  it('moves idle → submitting on submit', () => {
    const next = loginReducer(initialLoginState(), { type: 'submit', email: 'a@b.test' });
    expect(next.phase).toBe('submitting');
    expect(next.email).toBe('a@b.test');
    expect(next.retryAfterSeconds).toBe(0);
  });

  it('moves submitting → success and stores the user', () => {
    const s = loginReducer(initialLoginState(), { type: 'submit', email: 'a@b.test' });
    const next = loginReducer(s, { type: 'outcome', outcome: { kind: 'success', user: user() } });
    expect(next.phase).toBe('success');
    expect(next.user?.id).toBe('u1');
  });

  it('moves submitting → otp_required and back to submitting via otp-back', () => {
    let s = loginReducer(initialLoginState(), { type: 'submit', email: 'a@b.test' });
    s = loginReducer(s, { type: 'outcome', outcome: { kind: 'otp_required' } });
    expect(s.phase).toBe('otp');
    s = loginReducer(s, { type: 'totp-back' });
    expect(s.phase).toBe('submitting');
    expect(s.totpAttemptFailed).toBe(false);
  });

  it('tracks a failed TOTP attempt without leaving the otp phase', () => {
    let s = loginReducer(initialLoginState(), { type: 'submit', email: 'a@b.test' });
    s = loginReducer(s, { type: 'outcome', outcome: { kind: 'otp_required' } });
    s = loginReducer(s, { type: 'totp-submit' });
    expect(s.phase).toBe('verifying-otp');
    s = loginReducer(s, { type: 'outcome', outcome: { kind: 'invalid_totp' } });
    expect(s.phase).toBe('otp');
    expect(s.totpAttemptFailed).toBe(true);
  });

  it('records the server retry-after for rate limiting and ticks it down', () => {
    let s = loginReducer(initialLoginState(), { type: 'submit', email: 'a@b.test' });
    s = loginReducer(s, { type: 'outcome', outcome: { kind: 'rate_limited', retryAfterSeconds: 45 } });
    expect(s.phase).toBe('rate_limited');
    expect(s.retryAfterSeconds).toBe(45);
    s = loginReducer(s, { type: 'tick' });
    expect(s.retryAfterSeconds).toBe(44);
  });

  it('never lets the countdown go below zero', () => {
    let s = initialLoginState();
    s = loginReducer(s, { type: 'outcome', outcome: { kind: 'rate_limited', retryAfterSeconds: 1 } });
    s = loginReducer(s, { type: 'tick' });
    expect(s.retryAfterSeconds).toBe(0);
    s = loginReducer(s, { type: 'tick' });
    expect(s.retryAfterSeconds).toBe(0);
  });

  it('maps the identity-phases', () => {
    for (const kind of ['invalid_credentials', 'account_disabled', 'account_suspended', 'network_error', 'unexpected_error'] as const) {
      let s = loginReducer(initialLoginState(), { type: 'submit', email: 'a@b.test' });
      const outcome = kind === 'unexpected_error' ? { kind, requestId: 'r1' } : { kind };
      s = loginReducer(s, { type: 'outcome', outcome } as never);
      expect(s.phase).toBe(kind);
    }
  });
});

describe('outcomeFromLoginError', () => {
  it('classifies network failures', () => {
    expect(outcomeFromLoginError(new ApiError('boom', { status: 0 }))).toEqual({ kind: 'network_error' });
  });

  it('classifies 401 as invalid credentials regardless of body', () => {
    const err = new ApiError('Invalid credentials', { status: 401, code: 'INVALID_CREDENTIALS' });
    expect(outcomeFromLoginError(err)).toEqual({ kind: 'invalid_credentials' });
  });

  it('classifies 403 by problem code', () => {
    expect(outcomeFromLoginError(new ApiError('x', { status: 403, code: 'ACCOUNT_DISABLED' }))).toEqual({
      kind: 'account_disabled',
    });
    expect(outcomeFromLoginError(new ApiError('x', { status: 403, code: 'ACCOUNT_SUSPENDED' }))).toEqual({
      kind: 'account_suspended',
    });
  });

  it('keeps the exact server retry-after for 429 and defaults when missing', () => {
    expect(outcomeFromLoginError(new ApiError('x', { status: 429, retryAfterSeconds: 23 }))).toEqual({
      kind: 'rate_limited',
      retryAfterSeconds: 23,
    });
    expect(outcomeFromLoginError(new ApiError('x', { status: 429 }))).toEqual({
      kind: 'rate_limited',
      retryAfterSeconds: 60,
    });
  });

  it('surfaces unexpected errors with the request id', () => {
    expect(outcomeFromLoginError(new ApiError('x', { status: 500, requestId: 'r1' }))).toEqual({
      kind: 'unexpected_error',
      requestId: 'r1',
    });
    expect(outcomeFromLoginError(new Error('boom'))).toEqual({ kind: 'unexpected_error' });
  });
});

describe('outcomeFromTotpError', () => {
  it('classifies invalid codes from the two-factor error envelope', () => {
    expect(outcomeFromTotpError(new ApiError('x', { status: 400, code: 'INVALID_TOTP_CODE' }))).toEqual({
      kind: 'invalid_totp',
    });
  });

  it('keeps 429 handling', () => {
    expect(outcomeFromTotpError(new ApiError('x', { status: 429, retryAfterSeconds: 9 }))).toEqual({
      kind: 'rate_limited',
      retryAfterSeconds: 9,
    });
  });
});