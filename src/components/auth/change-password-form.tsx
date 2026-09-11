'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { authClient } from '@/lib/auth/client';
import { SESSION_QUERY_KEY } from '@/hooks/use-session';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { PasswordInput } from './password-input';

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: z.string().min(8, 'Your new password must be at least 8 characters'),
    confirmPassword: z.string().min(1, 'Re-enter your new password'),
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'Your new password must be different from the current one',
    path: ['newPassword'],
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: 'The passwords do not match',
    path: ['confirmPassword'],
  });

type ChangePasswordValues = z.infer<typeof changePasswordSchema>;

interface ErrorLike {
  status?: number;
  statusCode?: number;
  code?: string;
  message?: string;
}

export function ChangePasswordForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ChangePasswordValues>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  async function onSubmit(values: ChangePasswordValues) {
    setIsSubmitting(true);
    setSubmitError(null);
    const result = await authClient.changePassword({
      currentPassword: values.currentPassword,
      newPassword: values.newPassword,
      revokeOtherSessions: false,
    });
    setIsSubmitting(false);

    if (result.error) {
      const err = result.error as ErrorLike;
      if (err.code === 'INVALID_PASSWORD') {
        setSubmitError('Your current password is incorrect.');
      } else if (err.code === 'PASSWORD_TOO_SHORT') {
        setSubmitError('Your new password must be at least 8 characters.');
      } else if (err.status === 401 || err.statusCode === 401 || err.code === 'UNAUTHORIZED') {
        await authClient.signOut();
        void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
        router.replace('/login');
        setSubmitError('Your session expired. Please sign in again.');
      } else {
        setSubmitError(`Could not update your password. ${err.message ?? 'Please try again.'}`);
      }
      return;
    }

    reset();
    void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    router.replace('/dashboard');
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Choose a new password</CardTitle>
        <CardDescription>
          You must set a new password before continuing. It must be at least 8 characters.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <PasswordInput
            id="current-password"
            label="Current password"
            autoComplete="current-password"
            error={errors.currentPassword?.message}
            disabled={isSubmitting}
            {...register('currentPassword')}
          />
          <PasswordInput
            id="new-password"
            label="New password"
            autoComplete="new-password"
            error={errors.newPassword?.message}
            disabled={isSubmitting}
            {...register('newPassword')}
          />
          <PasswordInput
            id="confirm-password"
            label="Confirm new password"
            autoComplete="new-password"
            error={errors.confirmPassword?.message}
            disabled={isSubmitting}
            {...register('confirmPassword')}
          />

          {submitError ? (
            <Alert variant="destructive" aria-live="polite">
              <AlertTitle>Could not update</AlertTitle>
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          ) : null}

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? 'Updating…' : 'Update password'}
          </Button>
        </form>

        <Separator className="my-5" />
        <p className="text-sm text-muted-foreground">
          After updating your password you will continue to the dashboard. Your other signed-in sessions stay active.
        </p>
      </CardContent>
    </Card>
  );
}