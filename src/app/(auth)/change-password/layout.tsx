import { redirect } from 'next/navigation';
import { getServerSession } from '@/core/auth/server-session';

export default async function ChangePasswordLayout({ children }: { children: React.ReactNode }) {
  const user = await getServerSession();
  if (!user) redirect('/login');
  if (!user.mustChangePassword) redirect('/dashboard');
  return <>{children}</>;
}