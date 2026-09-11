'use client';

import { can, hasRole } from '@/lib/auth/permissions';
import { useSession } from './use-session';

/**
 * UI-only authorization helpers backed by the live session. Server guards
 * (layouts / requirePermission) remain the real authorization boundary.
 */
export function useAuthz() {
  const { data: user } = useSession();
  return {
    can: (permission: string): boolean => can(user?.role, permission),
    hasRole: (required: Parameters<typeof hasRole>[1]): boolean => hasRole(user?.role, required),
  };
}