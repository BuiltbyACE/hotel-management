import { redirect } from 'next/navigation';
import { getServerSession } from '@/core/auth/server-session';

export default async function LoginLayout({ children }: { children: React.ReactNode }) {
  const user = await getServerSession();
  if (user) redirect(user.mustChangePassword ? '/change-password' : '/dashboard');
  return <>{children}</>;
}