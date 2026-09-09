/**
 * Integration test: login throttle wrapper + the login-status gate
 * (src/app/api/auth/sign-in/email/route.ts and the session-create hook in
 * core/auth/config.ts) against a real Postgres.
 * Requires docker-compose DB and .env.local.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { withDb, withTx, schema } from '@/core/db';
import { rateLimitAttempts } from '@/core/db/infra';
import { POST } from '@/app/api/auth/sign-in/email/route';
import { createUser, updateUser } from '@/modules/identity/service';
import { insertUser } from '@/modules/identity/repository';
import { resolvePermissions, type Actor } from '@/modules/identity/auth-guard';
import type { CreateUserInput } from '@/modules/identity/validation';

const PASSWORD = 'TempPass123!';

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

/** The acting admin must be a real users row (users.created_by FK). */
const ADMIN = actor('admin');
const created: string[] = [];
const buckets: string[] = [];

function email(tag: string): string {
  return `${tag}-${randomUUID().slice(0, 8)}@hotm.test`;
}

function markCreated(id: string): void {
  created.push(id);
}

async function createStaff(): Promise<{ id: string; email: string }> {
  const staffEmail = email('login');
  const input: CreateUserInput = {
    name: 'Ken Staff',
    email: staffEmail,
    password: PASSWORD,
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

async function countSessions(userId: string): Promise<number> {
  const rows = await withDb((db) =>
    db.select({ id: schema.sessions.id }).from(schema.sessions).where(eq(schema.sessions.userId, userId)),
  );
  return rows.length;
}

async function parse<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
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
    await db.delete(rateLimitAttempts).where(inArray(rateLimitAttempts.bucket, buckets));
    for (const id of [...created].reverse()) {
      await db.delete(schema.sessions).where(eq(schema.sessions.userId, id));
      await db.delete(schema.accounts).where(eq(schema.accounts.userId, id));
      // Users are now audit-referenced (activity_logs.actor_id FK, append-only)
      // — they stay as residue, keyed by unique UUIDs.
    }
  });
});

describe('login throttle + status gate', () => {
  it('signs in an active user and stamps last_login_at', async () => {
    const staff = await createStaff();
    const res = await signIn(staff.email, PASSWORD, '10.0.0.10');

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeTruthy();
    const body = await parse<{ token: string; user: { id: string } }>(res);
    expect(body.token).toBeTruthy();
    expect(body.user.id).toBe(staff.id);

    const rows = await withDb((db) =>
      db
        .select({ lastLoginAt: schema.users.lastLoginAt })
        .from(schema.users)
        .where(eq(schema.users.id, staff.id)),
    );
    expect(rows[0]?.lastLoginAt).toBeTruthy();
    expect(await countSessions(staff.id)).toBe(1);
  }, 30_000);

  it('locks the email after 5 bad logins and returns Retry-After', async () => {
    const ip = '10.0.0.11';
    const victim = email('lock');
    for (let i = 0; i < 5; i++) {
      buckets.push(`login:${victim}`);
      const res = await signIn(victim, 'WrongPass123!', ip);
      expect(res.status).toBe(401);
    }
    buckets.push(`login:ip:${ip}`);
    const res = await signIn(victim, 'WrongPass123!', ip);
    expect(res.status).toBe(429);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect((await parse<{ code: string }>(res)).code).toBe('RATE_LIMITED');
  }, 30_000);

  it('locks the source IP for other emails and answers 429 before touching Auth', async () => {
    const ip = '10.0.0.12';
    for (let i = 0; i < 5; i++) {
      buckets.push(`login:${email('other')}`);
      const res = await signIn(email('other'), 'WrongPass123!', ip);
      expect(res.status).toBe(401);
    }
    buckets.push(`login:ip:${ip}`);
    const fresh = email('fresh');
    const res = await signIn(fresh, 'WrongPass123!', ip);
    expect(res.status).toBe(429);
    expect((await parse<{ code: string }>(res)).code).toBe('RATE_LIMITED');
  }, 30_000);

  it('rejects a disabled user with ACCOUNT_DISABLED and creates no session', async () => {
    const staff = await createStaff();
    await updateUser(staff.id, { status: 'disabled' }, ADMIN);

    const res = await signIn(staff.email, PASSWORD, '10.0.0.13');
    expect(res.status).toBe(403);
    expect((await parse<{ code: string }>(res)).code).toBe('ACCOUNT_DISABLED');
    expect(await countSessions(staff.id)).toBe(0);
  }, 30_000);

  it('rejects a suspended user with ACCOUNT_SUSPENDED', async () => {
    const staff = await createStaff();
    await updateUser(staff.id, { status: 'suspended' }, ADMIN);
    const res = await signIn(staff.email, PASSWORD, '10.0.0.14');
    expect(res.status).toBe(403);
    expect((await parse<{ code: string }>(res)).code).toBe('ACCOUNT_SUSPENDED');
  }, 30_000);

  it('does not leak an existence oracle for unknown emails', async () => {
    const res = await signIn(email('ghost'), 'NotAPerson123!', '10.0.0.15');
    expect(res.status).toBe(401);
  }, 30_000);
});