import type { Metadata } from 'next';
import { ChangePasswordForm } from '@/components/auth/change-password-form';

export const metadata: Metadata = {
  title: 'Change password',
  robots: { index: false, follow: false },
};

export default function ChangePasswordPage() {
  return <ChangePasswordForm />;
}