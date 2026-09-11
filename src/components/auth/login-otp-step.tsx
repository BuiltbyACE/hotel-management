'use client';

import { useState } from 'react';
import { post } from '@/lib/api/client';
import { outcomeFromTotpError } from '@/lib/auth/state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { ShieldCheck } from 'lucide-react';

interface LoginOtpStepProps {
  email: string;
  onBack: () => void;
  onSuccess: () => void;
}

export function LoginOtpStep({ email, onBack, onSuccess }: LoginOtpStepProps) {
  const [code, setCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function verify() {
    const trimmed = code.trim();
    if (trimmed.length === 0) {
      setError('Enter the code from your authenticator app.');
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      await post('/api/auth/two-factor/verify-totp', { code: trimmed });
      onSuccess();
    } catch (err) {
      const outcome = outcomeFromTotpError(err);
      if (outcome.kind === 'invalid_totp') {
        setError("That code wasn't accepted. Check the time on your device and try again.");
      } else if (outcome.kind === 'network_error') {
        setError('Cannot reach the server. Check your connection and try again.');
      } else if (outcome.kind === 'rate_limited') {
        setError(`Too many attempts. Try again in ${outcome.retryAfterSeconds} seconds.`);
      } else {
        setError('Something went wrong verifying the code. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="space-y-4" aria-live="polite">
      <Alert variant="default">
        <ShieldCheck aria-hidden="true" />
        <AlertTitle>Two-factor authentication required</AlertTitle>
        <AlertDescription>
          <p>
            Open {email ? 'your authenticator app on this device' : 'your authenticator app'} and enter the 6-digit
            code to finish signing in.
          </p>
        </AlertDescription>
      </Alert>

      <div className="space-y-2">
        <Label htmlFor="otp-code">6-digit code</Label>
        <Input
          id="otp-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="000000"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void verify();
          }}
        />
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not verify</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex gap-3">
        <Button type="button" variant="ghost" onClick={onBack} disabled={isSubmitting}>
          Back
        </Button>
        <Button type="button" onClick={() => void verify()} disabled={isSubmitting || code.length < 6} className="flex-1">
          {isSubmitting ? 'Verifying…' : 'Verify & sign in'}
        </Button>
      </div>
    </div>
  );
}