/**
 * core/auth/session.ts
 *
 * Session helpers for route handlers. These resolve WHO is making the request
 * (identity). What they may DO (authority) is checked in the identity module's
 * requirePermission — see modules/identity/auth-guard.ts.
 */
import { auth, type AuthUser } from './config';

/**
 * Resolve the signed-in user, or null. Route handlers with optional auth use
 * this; guarded routes use requireActor/requirePermission (identity module).
 */
export async function getAuthUser(req: Request): Promise<AuthUser | null> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user) return null;
  return session.user as unknown as AuthUser;
}

/** True when `req` carries a valid session for a non-disabled user. */
export async function hasSession(req: Request): Promise<boolean> {
  const user = await getAuthUser(req);
  return user !== null && user.status === 'active';
}