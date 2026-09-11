'use client';

import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api/client';
import type { SessionUser } from '@/lib/auth/types';

export const SESSION_QUERY_KEY = ['session'] as const;

/**
 * Reactive session read. Uses the Better Auth /get-session endpoint with the
 * cookie cache disabled so `mustChangePassword` and `status` are always fresh.
 */
export function useSession() {
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: async () => {
      const body = await get<{ session: unknown; user: SessionUser | null }>(
        '/api/auth/get-session?disableCookieCache=true',
      );
      return body.user ?? null;
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}