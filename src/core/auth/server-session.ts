/**
 * Server-only session resolver for route guards (login / change-password /
 * dashboard layouts). Reads the DB-fresh session (disableCookieCache) so the
 * mustChangePassword gate never runs on the stale 60s cookie cache.
 *
 * Must only be imported from Server Components or route handlers — it pulls in
 * the server auth stack and next/headers. Never import from client code.
 */
import { headers } from 'next/headers';
import { auth, type AuthUser } from './config';

export async function getServerSession(): Promise<AuthUser | null> {
  const h = await headers();
  const session = await auth.api.getSession({
    headers: h,
    query: { disableCookieCache: 'true' },
  });
  if (!session?.user) return null;
  return session.user as unknown as AuthUser;
}