'use client';

import { useEffect, useReducer } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { post } from '@/lib/api/client';
import {
  initialLoginState,
  loginReducer,
  outcomeFromLoginError,
} from '@/lib/auth/state';
import type { SessionUser } from '@/lib/auth/types';
import { SESSION_QUERY_KEY } from '@/hooks/use-session';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { PasswordInput } from './password-input';
import { LoginOtpStep } from './login-otp-step';

const loginSchema = z.object({
  email: z.string().trim().min(1, 'Enter your email').email('Enter a valid email'),
  password: z.string().min(1, 'Enter your password'),
});

type LoginValues = z.infer<typeof loginSchema>;

export function LoginForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(loginReducer, undefined, initialLoginState);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  useEffect(() => {
    if (state.phase !== 'success') return;
    void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    router.replace('/dashboard');
  }, [state.phase, queryClient, router]);

  useEffect(() => {
    if (state.phase !== 'rate_limited' || state.retryAfterSeconds <= 0) return;
    const timer = setInterval(() => dispatch({ type: 'tick' }), 1000);
    return () => clearInterval(timer);
  }, [state.phase, state.retryAfterSeconds]);

  async function onSubmit(values: LoginValues) {
    dispatch({ type: 'submit', email: values.email });
    try {
      const body = await post<{ twoFactorRedirect?: boolean; twoFactorMethods?: string[]; user?: SessionUser }>(
        '/api/auth/sign-in/email',
        values,
      );
      if (body.twoFactorRedirect) {
        dispatch({ type: 'outcome', outcome: { kind: 'otp_required' } });
        return;
      }
      if (body.user) {
        dispatch({ type: 'outcome', outcome: { kind: 'success', user: body.user } });
        return;
      }
      dispatch({ type: 'outcome', outcome: { kind: 'unexpected_error' } });
    } catch (err) {
      dispatch({ type: 'outcome', outcome: outcomeFromLoginError(err) });
    }
  }

  if (state.phase === 'otp') {
    return (
      <LoginOtpStep
        email={state.email}
        onBack={() => dispatch({ type: 'totp-back' })}
        onSuccess={() => {
          void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
          router.replace('/dashboard');
        }}
      />
    );
  }

  const locked = state.phase === 'rate_limited' && state.retryAfterSeconds > 0;
  const submitting = state.phase === 'submitting';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>
          Use your staff account to access the property management system.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={errors.email ? 'email-error' : undefined}
              disabled={submitting || locked}
              {...register('email')}
            />
            {errors.email ? (
              <p id="email-error" className="text-sm text-destructive">
                {errors.email.message}
              </p>
            ) : null}
          </div>

          <PasswordInput
            id="password"
            label="Password"
            autoComplete="current-password"
            error={errors.password?.message}
            disabled={submitting || locked}
            {...register('password')}
          />

          {state.phase === 'invalid_credentials' ? (
            <Alert variant="destructive">
              <AlertTitle>Sign in failed</AlertTitle>
              <AlertDescription>Incorrect email or password. Try again.</AlertDescription>
            </Alert>
          ) : null}
          {state.phase === 'account_disabled' ? (
            <Alert variant="destructive">
              <AlertTitle>Account disabled</AlertTitle>
              <AlertDescription>This account has been disabled. Contact your administrator.</AlertDescription>
            </Alert>
          ) : null}
          {state.phase === 'account_suspended' ? (
            <Alert variant="destructive">
              <AlertTitle>Account suspended</AlertTitle>
              <AlertDescription>
                This account is suspended. Contact your administrator to regain access.
              </AlertDescription>
            </Alert>
          ) : null}
          {state.phase === 'rate_limited' ? (
            <Alert variant="destructive" aria-live="polite">
              <AlertTitle>Too many attempts</AlertTitle>
              <AlertDescription>
                {state.retryAfterSeconds > 0
                  ? `Please wait ${state.retryAfterSeconds} seconds before trying again.`
                  : 'You can try signing in again now.'}
              </AlertDescription>
            </Alert>
          ) : null}
          {state.phase === 'network_error' ? (
            <Alert variant="destructive">
              <AlertTitle>Connection problem</AlertTitle>
              <AlertDescription>Cannot reach the server. Check your connection and try again.</AlertDescription>
            </Alert>
          ) : null}
          {state.phase === 'unexpected_error' ? (
            <Alert variant="destructive">
              <AlertTitle>Something went wrong</AlertTitle>
              <AlertDescription>
                Please try again. If this keeps happening, contact your administrator.
                {state.requestId ? ` (Ref: ${state.requestId})` : null}
              </AlertDescription>
            </Alert>
          ) : null}

          <Button type="submit" className="w-full" disabled={submitting || locked}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <Separator className="my-5" />
        <p className="text-center text-sm text-muted-foreground">
          Forgot your password? Contact your administrator to have it reset.
        </p>
      </CardContent>
    </Card>
  );
}

export { loginSchema };
export type { LoginValues };