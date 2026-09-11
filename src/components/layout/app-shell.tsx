'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { LayoutDashboard, LogOut } from 'lucide-react';
import { authClient } from '@/lib/auth/client';
import { useSession, SESSION_QUERY_KEY } from '@/hooks/use-session';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: user, isPending } = useSession();

  async function handleLogout() {
    await authClient.signOut();
    queryClient.setQueryData(SESSION_QUERY_KEY, null);
    router.replace('/login');
    router.refresh();
  }

  return (
    <div className="flex min-h-svh w-full">
      <aside className="hidden w-60 flex-col border-r bg-sidebar text-sidebar-foreground md:flex">
        <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-4">
          <div className="flex size-8 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
            HMS
          </div>
          <span className="text-sm font-semibold">Hotel Management</span>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          <Link
            href="/dashboard"
            className="flex items-center gap-2 rounded-md bg-sidebar-accent px-3 py-2 text-sm font-medium text-sidebar-accent-foreground"
          >
            <LayoutDashboard className="size-4" aria-hidden="true" />
            Dashboard
          </Link>
        </nav>
        <div className="border-t border-sidebar-border p-3 text-xs text-sidebar-foreground/70">
          Phase 1 shell — booking screens arrive next.
        </div>
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex h-14 items-center justify-between gap-4 border-b px-4">
          <div className="min-w-0">
            {isPending ? (
              <Skeleton className="h-4 w-40" />
            ) : user ? (
              <p className="truncate text-sm font-medium">
                {user.name} <span className="text-muted-foreground">· {user.role}</span>
              </p>
            ) : (
              <Skeleton className="h-4 w-40" />
            )}
          </div>
          <Button variant="outline" size="sm" onClick={() => void handleLogout()}>
            <LogOut aria-hidden="true" />
            Sign out
          </Button>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}