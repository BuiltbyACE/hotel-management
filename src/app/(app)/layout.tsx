import { redirect } from 'next/navigation';
import { getServerSession } from '@/core/auth/server-session';
import { AppShell } from '@/components/layout/app-shell';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getServerSession();
  if (!user) redirect('/login');
  if (user.mustChangePassword) redirect('/change-password');
  return <AppShell>{children}</AppShell>;
}