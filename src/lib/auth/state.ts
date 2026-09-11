/**
 * Login flow state machine — pure, exhaustive, unit-tested.
 *
 * Branches on HTTP status + problem-details `code` (never `detail` text).
 * Error outcomes are produced from ApiError so the countdown can read the
 * server-provided Retry-After exactly.
 */
import { isApiError } from '@/lib/api/errors';
import type { SessionUser } from './types';

export type LoginPhase =
  | 'idle'
  | 'submitting'
  | 'otp'
  | 'verifying-otp'
  | 'success'
  | 'invalid_credentials'
  | 'account_disabled'
  | 'account_suspended'
  | 'rate_limited'
  | 'network_error'
  | 'unexpected_error';

export interface LoginState {
  phase: LoginPhase;
  email: string;
  retryAfterSeconds: number;
  totpAttemptFailed: boolean;
  requestId?: string;
  user: SessionUser | null;
}

export type LoginAttemptOutcome =
  | { kind: 'success'; user: SessionUser }
  | { kind: 'otp_required' }
  | { kind: 'invalid_credentials' }
  | { kind: 'account_disabled' }
  | { kind: 'account_suspended' }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'invalid_totp' }
  | { kind: 'network_error' }
  | { kind: 'unexpected_error'; requestId?: string };

export type LoginAction =
  | { type: 'submit'; email: string }
  | { type: 'outcome'; outcome: LoginAttemptOutcome }
  | { type: 'totp-submit' }
  | { type: 'totp-back' }
  | { type: 'tick' }
  | { type: 'reset' };

export function initialLoginState(): LoginState {
  return { phase: 'idle', email: '', retryAfterSeconds: 0, totpAttemptFailed: false, user: null };
}

export function loginReducer(state: LoginState, action: LoginAction): LoginState {
  switch (action.type) {
    case 'submit':
      return { ...state, phase: 'submitting', email: action.email, totpAttemptFailed: false };
    case 'totp-submit':
      return { ...state, phase: 'verifying-otp' };
    case 'totp-back':
      return { ...state, phase: 'submitting', totpAttemptFailed: false };
    case 'tick':
      return { ...state, retryAfterSeconds: Math.max(0, state.retryAfterSeconds - 1) };
    case 'reset':
      return initialLoginState();
    case 'outcome':
      return applyOutcome(state, action.outcome);
  }
}

function applyOutcome(state: LoginState, outcome: LoginAttemptOutcome): LoginState {
  switch (outcome.kind) {
    case 'success':
      return { ...state, phase: 'success', user: outcome.user };
    case 'otp_required':
      return { ...state, phase: 'otp', totpAttemptFailed: false };
    case 'invalid_credentials':
      return { ...state, phase: 'invalid_credentials' };
    case 'account_disabled':
      return { ...state, phase: 'account_disabled' };
    case 'account_suspended':
      return { ...state, phase: 'account_suspended' };
    case 'rate_limited':
      return { ...state, phase: 'rate_limited', retryAfterSeconds: outcome.retryAfterSeconds };
    case 'invalid_totp':
      return { ...state, phase: 'otp', totpAttemptFailed: true };
    case 'network_error':
      return { ...state, phase: 'network_error' };
    case 'unexpected_error':
      return { ...state, phase: 'unexpected_error', requestId: outcome.requestId };
  }
}

export function outcomeFromLoginError(err: unknown): LoginAttemptOutcome {
  if (!isApiError(err)) return { kind: 'unexpected_error' };
  if (err.status === 0) return { kind: 'network_error' };
  if (err.status === 429) return { kind: 'rate_limited', retryAfterSeconds: err.retryAfterSeconds ?? 60 };
  if (err.status === 401) return { kind: 'invalid_credentials' };
  if (err.status === 403) {
    if (err.code === 'ACCOUNT_DISABLED') return { kind: 'account_disabled' };
    if (err.code === 'ACCOUNT_SUSPENDED') return { kind: 'account_suspended' };
  }
  return { kind: 'unexpected_error', requestId: err.requestId };
}

export function outcomeFromTotpError(err: unknown): LoginAttemptOutcome {
  if (!isApiError(err)) return { kind: 'unexpected_error' };
  if (err.status === 0) return { kind: 'network_error' };
  if (err.status === 429) return { kind: 'rate_limited', retryAfterSeconds: err.retryAfterSeconds ?? 60 };
  if (err.code === 'INVALID_TOTP_CODE' || err.code === 'INVALID_CODE') return { kind: 'invalid_totp' };
  return { kind: 'unexpected_error', requestId: err.requestId };
}