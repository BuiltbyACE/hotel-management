/**
 * modules/identity/auth-guard.ts
 *
 * "Authority": resolves a signatured request into an `Actor` (identity +
 * resolved permission set), and enforces it. `requirePermission` is the ONLY
 * authorization — route handlers call it as their second statement
 * (blueprint §9.4 MUST). Identity comes from core/auth (Better Auth); the
 * permission matrix + per-user overrides come from this module.
 *
 * Route handlers import this file (category 'guards'); core never does.
 */
import { getAuthUser } from '@/core/auth/session';
import { AppError } from '@/core/api';
import { withDb } from '@/core/db';
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  canModifyUser,
  type Permission,
  type UserRole,
} from './permissions';

export type Actor = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  propertyId: string | null;
  /** role matrix + per-user overrides, resolved once per request */
  permissions: ReadonlySet<Permission>;
};

export interface OverrideRow {
  permission: string;
  allowed: boolean;
}

export { PERMISSIONS, canModifyUser };
export type { Permission, UserRole };

/** Compose the effective permission set for a role + overrides. Pure. */
export function resolvePermissions(
  role: UserRole,
  overrides: readonly OverrideRow[],
): ReadonlySet<Permission> {
  const granted = new Set(ROLE_PERMISSIONS[role]);
  for (const o of overrides) {
    if (!(PERMISSIONS as readonly string[]).includes(o.permission)) continue;
    const p = o.permission as Permission;
    if (o.allowed) granted.add(p);
    else granted.delete(p);
  }
  return granted;
}

/** Pure, UI-safe: does this actor hold the permission? */
export function can(actor: Actor, p: Permission): boolean {
  return actor.permissions.has(p);
}

/**
 * Resolve the signed-in user to an Actor with a resolved permission set, or
 * null when not authenticated.
 */
export async function getActor(req: Request): Promise<Actor | null> {
  const user = await getAuthUser(req);
  if (!user) return null;

  const overrides = await loadOverrides(user.id);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    propertyId: user.propertyId,
    permissions: resolvePermissions(user.role, overrides),
  };
}

/** 401 when unauthenticated, or when the user is not 'active'. */
export async function requireActor(req: Request): Promise<Actor> {
  const actor = await getActor(req);
  if (!actor) {
    throw AppError.unauthorized('Sign in to continue');
  }
  return actor;
}

/**
 * THE server-side gate. 401 unauthenticated; 403 when the actor lacks the
 * permission. Every /api/v1 mutation calls this as its second statement.
 */
export async function requirePermission(req: Request, permission: Permission): Promise<Actor> {
  const actor = await requireActor(req);
  if (!actor.permissions.has(permission)) {
    throw AppError.forbidden('FORBIDDEN', `Missing permission: ${permission}`);
  }
  return actor;
}

/** True when the actor may administer the target (role strictly below). */
export function actorCanManage(actor: Actor, target: { role: UserRole }): boolean {
  return canModifyUser(actor, target);
}

async function loadOverrides(userId: string): Promise<OverrideRow[]> {
  // Deferred import: the repository is module-internal and cheap to pull in
  // lazily, and this keeps auth-guard's hot path free of unused coupling.
  const { listOverrides } = await import('./repository');
  return withDb((db) => listOverrides(db, userId));
}