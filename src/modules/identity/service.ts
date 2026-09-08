/**
 * modules/identity/service.ts
 *
 * Business rules for staff accounts (blueprint §9).
 *
 * Users are created here — not via better-auth admin (it would strip our
 * additionalFields: role/status/propertyId are input:false). Better Auth's
 * sign-in finds the credential account by userId, so we insert the users row
 * + credential account row atomically (providerId='credential',
 * accountId=userId).
 *
 * Rules enforced here:
 * - create: ROLE_LEVEL[role] <= ROLE_LEVEL[actor.role] (no users above self)
 * - profile/role edits: canModifyUser — strictly below the actor
 * - deactivation (§9.4): needs users.deactivate, never the actor themselves,
 *   never the last active admin; cuts the user's sessions (DB sessions =
 *   instant kill) — and admins may deactivate co-admins (the last-admin
 *   guard is precisely what keeps that safe)
 * - role change revokes sessions; password reset revokes sessions + forces a
 *   change on next sign-in ([ERP-DNA] forced password change)
 * - email uniqueness is case-insensitive (partial unique index in schema)
 */
import { randomUUID } from 'node:crypto';
import { hash as argon2Hash } from '@node-rs/argon2';
import { withDb, withTx } from '@/core/db';
import { eventBus } from '@/core/events';
import { AppError } from '@/core/api';
import { ROLE_LEVEL } from './permissions';
import { canModifyUser, type Actor } from './auth-guard';
import {
  countActiveAdmins,
  countUsers,
  deleteUserSessions,
  findUserByEmail,
  findUserById,
  flagPasswordReset,
  insertCredentialAccount,
  insertUser,
  listOverridesForUsers,
  listUsers as listUsersRows,
  updateCredentialPassword,
  updateUserById,
} from './repository';
import type { UserListFilters, UserRecord } from './repository';
import { IDENTITY_EVENTS } from './events';
import type { UserListView, UserView, UserStatus } from './types';
import type { CreateUserInput, ResetPasswordInput, UpdateUserInput } from './validation';

function toView(u: UserRecord): UserView {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    emailVerified: u.emailVerified,
    role: u.role,
    status: u.status,
    phone: u.phone,
    propertyId: u.propertyId,
    mustChangePassword: u.mustChangePassword,
    passwordChangedAt: u.passwordChangedAt?.toISOString() ?? null,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    twoFactorEnabled: u.twoFactorEnabled,
    createdBy: u.createdBy,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
}

export async function createUser(input: CreateUserInput, actor: Actor): Promise<UserView> {
  if (ROLE_LEVEL[input.role] > ROLE_LEVEL[actor.role]) {
    throw AppError.forbidden('FORBIDDEN', 'Cannot create a user above your own role');
  }

  const existing = await withDb((db) => findUserByEmail(db, input.email));
  if (existing) {
    throw AppError.conflict('DUPLICATE', 'A user with this email already exists');
  }

  const passwordHash = await argon2Hash(input.password, { algorithm: 2 });

  const id = await withTx(async (tx) => {
    const user = await insertUser(tx, {
      name: input.name,
      email: input.email,
      role: input.role,
      status: 'active',
      phone: input.phone || null,
      propertyId: input.propertyId ?? null,
      mustChangePassword: true,
      createdBy: actor.id,
    });
    await insertCredentialAccount(tx, {
      id: randomUUID(),
      userId: user.id,
      passwordHash,
    });
    return user.id;
  });

  await eventBus.emit(IDENTITY_EVENTS.userCreated, {
    id,
    email: input.email,
    role: input.role,
    by: actor.email,
  });

  const created = await withDb((db) => findUserById(db, id));
  return toView(created!);
}

/**
 * Returns true when a status transition cuts the user's sessions (any
 * non-active state). The deactivation rules (§9.4) are:
 * - requires users.deactivate
 * - never the actor themselves
 * - never the last remaining active admin
 * Deactivation is NOT gated by canModifyUser — an admin must be able to remove
 * another admin; the "last active admin" guard is what keeps that safe.
 */
async function lastAdminGuard(target: UserRecord, next: UserStatus, actor: Actor): Promise<boolean> {
  if (next === 'active') return false;
  if (target.id === actor.id) {
    throw AppError.forbidden('FORBIDDEN', 'You cannot deactivate yourself');
  }
  if (!actor.permissions.has('users.deactivate')) {
    throw AppError.forbidden();
  }
  if (target.role === 'admin') {
    const activeAdmins = await withDb((db) => countActiveAdmins(db));
    if (activeAdmins <= 1) {
      throw AppError.forbidden('FORBIDDEN', 'Cannot disable the last active admin');
    }
  }
  return true;
}

export async function updateUser(
  id: string,
  input: UpdateUserInput,
  actor: Actor,
): Promise<UserView> {
  const target = await withDb((db) => findUserById(db, id));
  if (!target) throw AppError.notFound('User not found');

  const statusChange = input.status !== undefined && input.status !== target.status;
  const otherChange =
    input.name !== undefined ||
    input.phone !== undefined ||
    input.propertyId !== undefined ||
    (input.role !== undefined && input.role !== target.role);

  // Profile / role edits follow the strictly-below rule.
  if (otherChange && !canModifyUser(actor, target)) {
    throw AppError.forbidden('FORBIDDEN', 'You may only administer users below your own role');
  }

  const deactivating = statusChange
    ? await lastAdminGuard(target, (input.status ?? target.status) as UserStatus, actor)
    : false;

  await withTx(async (tx) => {
    const updated = await updateUserById(tx, id, {
      name: input.name,
      phone: input.phone === undefined ? undefined : input.phone || null,
      role: input.role,
      status: input.status as UserStatus | undefined,
      propertyId: input.propertyId,
    });

    const roleChanged = input.role !== undefined && input.role !== target.role;
    if (deactivating || roleChanged) await deleteUserSessions(tx, id);

    eventBus.emit(IDENTITY_EVENTS.userUpdated, {
      email: updated.email,
      changes: input,
      by: actor.email,
    });
    if (deactivating) {
      eventBus.emit(IDENTITY_EVENTS.userDeactivated, {
        email: updated.email,
        status: input.status,
        by: actor.email,
      });
    }
  });

  const saved = await withDb((db) => findUserById(db, id));
  return toView(saved!);
}

export async function resetPassword(
  id: string,
  input: ResetPasswordInput,
  actor: Actor,
): Promise<UserView> {
  const target = await withDb((db) => findUserById(db, id));
  if (!target) throw AppError.notFound('User not found');
  if (!canModifyUser(actor, target)) {
    throw AppError.forbidden('FORBIDDEN', 'You may only reset passwords for users below your own role');
  }

  const passwordHash = await argon2Hash(input.password, { algorithm: 2 });

  await withTx(async (tx) => {
    await updateCredentialPassword(tx, id, passwordHash);
    // New password is temporary: force a change + revoke all sessions.
    await flagPasswordReset(tx, id);
    await deleteUserSessions(tx, id);
    eventBus.emit(IDENTITY_EVENTS.userPasswordReset, { id, by: actor.email });
  });

  const saved = await withDb((db) => findUserById(db, id));
  return toView(saved!);
}

export async function listUsers(
  filters: UserListFilters,
): Promise<{ data: UserListView[]; total: number }> {
  return withDb(async (db) => {
    const rows = await listUsersRows(db, filters);
    const total = await countUsers(db, filters);
    const overrides = await listOverridesForUsers(
      db,
      rows.map((r) => r.id),
    );
    const byUser = new Map<string, { permission: string; allowed: boolean }[]>();
    for (const o of overrides) {
      const list = byUser.get(o.userId) ?? [];
      list.push({ permission: o.permission, allowed: o.allowed });
      byUser.set(o.userId, list);
    }
    return {
      data: rows.map((r) => ({
        ...toView(r),
        overrides: byUser.get(r.id) ?? [],
      })),
      total,
    };
  });
}