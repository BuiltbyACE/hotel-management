/**
 * Integration test: the forced-password-change gate.
 *
 * Staff are created with mustChangePassword=true. Better Auth's
 * /change-password updates the credential account's hash; the
 * databaseHooks.account.update.after hook in core/auth/config.ts must stamp
 * mustChangePassword=false + password_changed_at so the flag clears and a
 * refreshed session reports false. Requires docker-compose DB and .env.local.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { withDb, withTx, schema } from '@/core/db';
import { auth } from '@/core/auth/config';
import { POST } from '@/app/api/auth/sign-in/email/route';
import { createUser } from '@/modules/identity/service';
import { insertUser } from '@/modules/identity/repository';
import { resolvePermissions, type Actor } from '@/modules/identity/auth-guard';
import type { CreateUserInput } from '@/modules/identity/validation';

const INITIAL_PASSWORD = 'ForcePass123!';
const NEW_PASSWORD = 'ChangedPass456!';

function actor(role: Actor['role'], id?: string): Actor {
  return {
    id: id ?? randomUUID(),
    name: role,
    email: `${role}@actor.test`,
    role,
    propertyId: null,
    permissions: resolvePermissions(role, []),
  };
}

const ADMIN = actor('admin');
const created: string[] = [];

function email(tag: string): string {
  return `${tag}-${randomUUID().slice(0, 8)}@hotm.test`;
}

function markCreated(id: string): void {
  created.push(id);
}

async function createStaff(): Promise<{ id: string; email: string }> {
  const staffEmail = email('force');
  const input: CreateUserInput = {
    name: 'Paula Force',
    email: staffEmail,
    password: INITIAL_PASSWORD,
    role: 'receptionist',
  };
  const user = await createUser(input, ADMIN);
  markCreated(user.id);
  return { id: user.id, email: staffEmail };
}

function signIn(userEmail: string, password: string, ip: string): Promise<Response> {
  return POST(
    new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ email: userEmail, password }),
    }),
  );
}

async function mustChangeFlag(userId: string): Promise<{
  mustChangePassword: boolean;
  passwordChangedAt: Date | null;
}> {
  const rows = await withDb((db) =>
    db
      .select({ mustChangePassword: schema.users.mustChangePassword, passwordChangedAt: schema.users.passwordChangedAt })
      .from(schema.users)
      .where(eq(schema.users.id, userId)),
  );
  return rows[0] ?? { mustChangePassword: true, passwordChangedAt: null };
}

async function sessionUser(cookie: string): Promise<{ id: string; mustChangePassword: boolean } | null> {
  const res = await auth.api.getSession({ headers: { cookie } });
  return res ? { id: res.user.id, mustChangePassword: res.user.mustChangePassword } : null;
}

async function changePassword(cookie: string, from: string, to: string): Promise<void> {
  await auth.api.changePassword({
    body: { currentPassword: from, newPassword: to },
    headers: { cookie },
  });
}

function firstCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('expected a session cookie');
  const nameValue = setCookie.split(';')[0] ?? '';
  if (!nameValue) throw new Error('malformed cookie');
  return nameValue;
}

beforeAll(async () => {
  const id = await withTx((tx) =>
    insertUser(tx, {
      name: 'Bootstrap Admin',
      email: email('boot'),
      role: 'admin',
      status: 'active',
      mustChangePassword: true,
      createdBy: null,
    }),
  );
  ADMIN.id = id.id;
  markCreated(id.id);
});

afterAll(async () => {
  await withDb(async (db) => {
    for (const id of [...created].reverse()) {
      await db.delete(schema.sessions).where(eq(schema.sessions.userId, id));
      await db.delete(schema.accounts).where(eq(schema.accounts.userId, id));
      // Users are now audit-referenced (activity_logs.actor_id FK, append-only)
      // — they stay as residue, keyed by unique UUIDs.
    }
  });
});

describe('must-change-password gate clearing', () => {
  it('new staff start with mustChangePassword=true and a forced-change password change flips it off', async () => {
    const staff = await createStaff();
    expect((await mustChangeFlag(staff.id)).mustChangePassword).toBe(true);

    const login = await signIn(staff.email, INITIAL_PASSWORD, '10.0.0.20');
    expect(login.status).toBe(200);
    const cookie = firstCookie(login);

    const before = await sessionUser(cookie);
    expect(before?.id).toBe(staff.id);
    expect(before?.mustChangePassword).toBe(true);

    await changePassword(cookie, INITIAL_PASSWORD, NEW_PASSWORD);

    const afterDb = await mustChangeFlag(staff.id);
    expect(afterDb.mustChangePassword).toBe(false);
    expect(afterDb.passwordChangedAt).toBeTruthy();

    const after = await sessionUser(cookie);
    expect(after?.id).toBe(staff.id);
    expect(after?.mustChangePassword).toBe(false);
  }, 30_000);

  it('the old password stops working and the new one signs in', async () => {
    const staff = await createStaff();
    const login = await signIn(staff.email, INITIAL_PASSWORD, '10.0.0.21');
    const cookie = firstCookie(login);
    await changePassword(cookie, INITIAL_PASSWORD, NEW_PASSWORD);

    const stale = await signIn(staff.email, INITIAL_PASSWORD, '10.0.0.22');
    expect(stale.status).toBe(401);

    const fresh = await signIn(staff.email, NEW_PASSWORD, '10.0.0.23');
    expect(fresh.status).toBe(200);
    const body = (await fresh.json()) as { user: { id: string } };
    expect(body.user.id).toBe(staff.id);
  }, 30_000);
});