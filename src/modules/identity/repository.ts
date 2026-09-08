/**
 * modules/identity/repository.ts
 *
 * All SQL for the identity context. No business rules — just queries.
 *
 * Uses the schema barrel (@/core/db) for `sessions`/`accounts` (Better Auth
 * tables owned by core) and the identity module's own `users` +
 * `user_permission_overrides`. Nothing else in the app touches these tables.
 */
import { and, asc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { schema, type Db, type Tx } from '@/core/db';
import { users, userPermissionOverrides } from './schema';
import type { UserStatus } from './types';

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: 'admin' | 'manager' | 'receptionist';
  status: UserStatus;
  phone: string | null;
  propertyId: string | null;
  mustChangePassword: boolean;
  passwordChangedAt: Date | null;
  lastLoginAt: Date | null;
  twoFactorEnabled: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OverrideRecord {
  permission: string;
  allowed: boolean;
  grantedBy: string | null;
  reason: string | null;
}

export interface UserListFilters {
  search?: string;
  role?: 'admin' | 'manager' | 'receptionist';
  status?: UserStatus;
  limit: number;
  offset: number;
}

const USER_COLUMNS = {
  id: users.id,
  name: users.name,
  email: users.email,
  emailVerified: users.emailVerified,
  role: users.role,
  status: users.status,
  phone: users.phone,
  propertyId: users.propertyId,
  mustChangePassword: users.mustChangePassword,
  passwordChangedAt: users.passwordChangedAt,
  lastLoginAt: users.lastLoginAt,
  twoFactorEnabled: users.twoFactorEnabled,
  createdBy: users.createdBy,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
};

const ACTIVE_USER = sql`${users.deletedAt} IS NULL`;

export function insertUser(tx: Tx, input: {
  name: string;
  email: string;
  role: 'admin' | 'manager' | 'receptionist';
  status: UserStatus;
  phone?: string | null;
  propertyId?: string | null;
  mustChangePassword: boolean;
  createdBy: string | null;
}): Promise<{ id: string }> {
  return tx
    .insert(users)
    .values(input)
    .returning({ id: users.id })
    .then((rows) => rows[0]!);
}

export function insertCredentialAccount(tx: Tx, input: {
  id: string;
  userId: string;
  passwordHash: string;
}): Promise<void> {
  return tx
    .insert(schema.accounts)
    .values({
      id: input.id,
      providerId: 'credential',
      accountId: input.userId,
      userId: input.userId,
      password: input.passwordHash,
    })
    .then(() => undefined);
}

export async function findUserById(db: Db, id: string): Promise<UserRecord | null> {
  const rows = await db.select(USER_COLUMNS).from(users).where(and(eq(users.id, id), ACTIVE_USER)).limit(1);
  return rows[0] ?? null;
}

export async function findUserByEmail(db: Db, email: string): Promise<UserRecord | null> {
  const rows = await db
    .select(USER_COLUMNS)
    .from(users)
    .where(and(sql`lower(${users.email}) = lower(${email})`, ACTIVE_USER))
    .limit(1);
  return rows[0] ?? null;
}

/** Case-insensitive search across name / email / phone (pg_trgm-backed). */
export function userFilters(f?: { search?: string; role?: string; status?: string }) {
  if (!f) return ACTIVE_USER;
  return and(
    ACTIVE_USER,
    f.role ? eq(users.role, f.role as never) : undefined,
    f.status ? eq(users.status, f.status as never) : undefined,
    f.search
      ? or(
          ilike(users.name, `%${f.search}%`),
          ilike(users.email, `%${f.search}%`),
          ilike(users.phone, `%${f.search}%`),
        )
      : undefined,
  );
}

export async function listUsers(db: Db, filters: UserListFilters): Promise<UserRecord[]> {
  return db
    .select(USER_COLUMNS)
    .from(users)
    .where(userFilters(filters))
    .orderBy(asc(users.name))
    .limit(filters.limit)
    .offset(filters.offset);
}

export async function countUsers(db: Db, filters?: { search?: string; role?: string; status?: string }): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(userFilters(filters));
  return rows[0]?.n ?? 0;
}

export function updateUserById(tx: Tx, id: string, patch: {
  name?: string;
  phone?: string | null;
  role?: 'admin' | 'manager' | 'receptionist';
  status?: UserStatus;
  propertyId?: string | null;
}): Promise<UserRecord> {
  const values: Record<string, unknown> = {};
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.phone !== undefined) values.phone = patch.phone;
  if (patch.role !== undefined) values.role = patch.role;
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.propertyId !== undefined) values.propertyId = patch.propertyId;
  return tx.update(users).set(values).where(eq(users.id, id)).returning(USER_COLUMNS).then((rows) => rows[0]!);
}

/** Store a fresh argon2 hash on the credential account row. */
export function updateCredentialPassword(tx: Tx, userId: string, passwordHash: string): Promise<void> {
  return tx
    .update(schema.accounts)
    .set({ password: passwordHash })
    .where(and(eq(schema.accounts.providerId, 'credential'), eq(schema.accounts.userId, userId)))
    .then(() => undefined);
}

export function markPasswordChanged(tx: Tx, userId: string): Promise<void> {
  return tx
    .update(users)
    .set({ mustChangePassword: false, passwordChangedAt: new Date() })
    .where(eq(users.id, userId))
    .then(() => undefined);
}

export function flagPasswordReset(tx: Tx, userId: string): Promise<void> {
  return tx
    .update(users)
    .set({ mustChangePassword: true, passwordChangedAt: null })
    .where(eq(users.id, userId))
    .then(() => undefined);
}

/** Changing a password revokes all the user's sessions. [ERP-DNA] */
export function deleteUserSessions(tx: Tx, userId: string): Promise<number> {
  return tx
    .delete(schema.sessions)
    .where(eq(schema.sessions.userId, userId))
    .then((r) => r.rowCount ?? 0);
}

export async function listOverrides(db: Db, userId: string): Promise<OverrideRecord[]> {
  const rows = await db
    .select({
      permission: userPermissionOverrides.permission,
      allowed: userPermissionOverrides.allowed,
      grantedBy: userPermissionOverrides.grantedBy,
      reason: userPermissionOverrides.reason,
    })
    .from(userPermissionOverrides)
    .where(eq(userPermissionOverrides.userId, userId));
  return rows;
}

/** Fetch overrides for many users in one query (list-page companion). */
export async function listOverridesForUsers(
  db: Db,
  userIds: readonly string[],
): Promise<(OverrideRecord & { userId: string })[]> {
  if (userIds.length === 0) return [];
  const rows = await db
    .select({
      userId: userPermissionOverrides.userId,
      permission: userPermissionOverrides.permission,
      allowed: userPermissionOverrides.allowed,
      grantedBy: userPermissionOverrides.grantedBy,
      reason: userPermissionOverrides.reason,
    })
    .from(userPermissionOverrides)
    .where(inArray(userPermissionOverrides.userId, userIds as string[]));
  return rows;
}

export async function countActiveAdmins(db: Db): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.status, 'active'), ACTIVE_USER));
  return rows[0]?.n ?? 0;
}