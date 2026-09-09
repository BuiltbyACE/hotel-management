/**
 * Integration test: identity service business rules against a real Postgres.
 * Requires the docker DB (docker-compose up -d) and .env.local.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { withDb, withTx, schema } from '@/core/db';
import { AppError } from '@/core/api';
import { createUser, listUsers, resetPassword, updateUser } from '@/modules/identity/service';
import { findUserById, insertCredentialAccount, insertUser } from '@/modules/identity/repository';
import { resolvePermissions, type Actor } from '@/modules/identity/auth-guard';
import type { CreateUserInput } from '@/modules/identity/validation';

vi.setConfig({ testTimeout: 30_000 });

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

/**
 * The acting admin must be a REAL users row (users.created_by FK). This mirrors
 * production: the seeded admin boots the system. Bootstrap admin is marked for
 * cleanup like everything else.
 */
const ADMIN = actor('admin');
const MANAGER = actor('manager');
const created: string[] = [];

function markCreated(id: string): void {
  created.push(id);
}

async function create(opts: Partial<CreateUserInput> = {}): Promise<string> {
  const input: CreateUserInput = {
    name: 'Ken Staff',
    email: `staff-${randomUUID().slice(0, 8)}@hotm.test`,
    password: 'TempPass123!',
    role: 'receptionist',
    ...opts,
  };
  const user = await createUser(input, ADMIN);
  markCreated(user.id);
  return user.id;
}

async function seedSessions(userId: string, count = 2): Promise<void> {
  await withTx((tx) =>
    Promise.all(
      Array.from({ length: count }, () =>
        tx.insert(schema.sessions).values({
          id: randomUUID(),
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 86400_000),
          userId,
        }),
      ),
    ),
  );
}

async function sessionCount(userId: string): Promise<number> {
  const rows = await withDb((db) =>
    db.select({ id: schema.sessions.id }).from(schema.sessions).where(eq(schema.sessions.userId, userId)),
  );
  return rows.length;
}

beforeAll(async () => {
  const id = await withTx(async (tx) => {
    const user = await insertUser(tx, {
      name: 'Bootstrap Admin',
      email: `bootstrap-${randomUUID().slice(0, 8)}@hotm.test`,
      role: 'admin',
      status: 'active',
      mustChangePassword: true,
      createdBy: null,
    });
    await insertCredentialAccount(tx, { id: randomUUID(), userId: user.id, passwordHash: 'not-used-in-tests' });
    return user.id;
  });
  markCreated(id);
  ADMIN.id = id;
});

afterAll(async () => {
  await withTx(async (tx) => {
    // Users who acted or were audited now have append-only activity_logs
    // references (actor_id FK) and can never be removed — unique UUIDs keep
    // each run isolated, so they stay as residue.
    // Reverse order: users reference the bootstrap admin via created_by.
    for (const id of [...created].reverse()) {
      await tx.delete(schema.sessions).where(eq(schema.sessions.userId, id));
      await tx.delete(schema.userPermissionOverrides).where(eq(schema.userPermissionOverrides.userId, id));
      await tx.delete(schema.accounts).where(eq(schema.accounts.userId, id));
    }
  });
});

describe('createUser', () => {
  it('creates the user row + a credential account atomically', async () => {
    const id = await create();
    const u = await withDb((db) => findUserById(db, id));
    expect(u).not.toBeNull();
    expect(u!.role).toBe('receptionist');
    expect(u!.status).toBe('active');
    expect(u!.mustChangePassword).toBe(true);

    const acc = await withDb((db) =>
      db.select().from(schema.accounts).where(eq(schema.accounts.userId, id)),
    );
    expect(acc).toHaveLength(1);
    expect(acc[0]!.providerId).toBe('credential');
    expect(acc[0]!.accountId).toBe(id);
    expect(acc[0]!.password).toMatch(/^\$argon2/);
  });

  it('rejects a duplicate email case-insensitively', async () => {
    const email = `DUP-${randomUUID().slice(0, 8)}@hotm.test`;
    await create({ email: email.toLowerCase() });
    await expect(create({ email: email.toUpperCase() })).rejects.toSatisfy((e) => e instanceof AppError && e.code === 'DUPLICATE');
  });

  it('forbids creating a user above the actor role', async () => {
    await expect(
      createUser(
        {
          name: 'Upstart',
          email: `up-${randomUUID().slice(0, 8)}@hotm.test`,
          password: 'TempPass123!',
          role: 'admin',
        },
        MANAGER,
      ),
    ).rejects.toSatisfy((e) => e instanceof AppError && e.status === 403);
  });
});

describe('updateUser', () => {
  it('edits a user strictly below the actor', async () => {
    const id = await create({ role: 'receptionist' });
    const updated = await updateUser(id, { name: 'Nyambura W.', phone: '+254700000000' }, ADMIN);
    expect(updated.name).toBe('Nyambura W.');
    expect(updated.phone).toBe('+254700000000');
  });

  it('forbids equal-level edits', async () => {
    const id = await create({ role: 'admin' });
    await expect(updateUser(id, { name: 'Hacked' }, MANAGER)).rejects.toSatisfy(
      (e) => e instanceof AppError && e.status === 403,
    );
  });

  it('forbids self role/status changes', async () => {
    const id = await create({ role: 'receptionist' });
    const self = actor('receptionist', id);
    await expect(updateUser(id, { status: 'disabled' }, self)).rejects.toSatisfy(
      (e) => e instanceof AppError && e.status === 403,
    );
    await expect(updateUser(id, { role: 'admin' }, self)).rejects.toSatisfy(
      (e) => e instanceof AppError && e.status === 403,
    );
  });

  it('deactivation cuts the user sessions', async () => {
    const id = await create();
    await seedSessions(id, 3);
    await updateUser(id, { status: 'disabled' }, ADMIN);
    expect(await sessionCount(id)).toBe(0);
  });

  it('forbids disabling the last remaining active admin', async () => {
    // The guard counts ALL active admins globally. Suites run in parallel and
    // sign-in/route suites create more admins concurrently, so the hermetic
    // count must be re-sunk right before each attempt until we observe the
    // invariant this test is actually about.
    await withTx(async (tx) => {
      await tx.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.role, 'admin')).execute();
    });

    for (let attempt = 1; attempt <= 5; attempt++) {
      const a = await create({ role: 'admin' });
      const b = await create({ role: 'admin' });
      await updateUser(a, { status: 'disabled' }, ADMIN);
      // Sink any admin created by a parallel suite since the first sink, so
      // `b` is once again the only active admin.
      await withTx(async (tx) => {
        await tx
          .update(schema.users)
          .set({ status: 'disabled' })
          .where(and(eq(schema.users.role, 'admin'), ne(schema.users.id, b)))
          .execute();
      });
      try {
        await updateUser(b, { status: 'disabled' }, ADMIN);
      } catch (e) {
        if (e instanceof AppError && e.code === 'FORBIDDEN') return;
        throw e;
      }
    }
    throw new Error('last-admin guard never observed (concurrent admin creation)');
  });
});

describe('resetPassword', () => {
  it('forces a change and revokes all sessions', async () => {
    const id = await create();
    await seedSessions(id, 2);
    const before = await withDb((db) =>
      db.select({ pw: schema.accounts.password }).from(schema.accounts).where(eq(schema.accounts.userId, id)),
    );

    const updated = await resetPassword(id, { password: 'FreshPass456!' }, ADMIN);

    expect(updated.mustChangePassword).toBe(true);
    expect(updated.passwordChangedAt).toBeNull();
    expect(await sessionCount(id)).toBe(0);

    const after = await withDb((db) =>
      db.select({ pw: schema.accounts.password }).from(schema.accounts).where(eq(schema.accounts.userId, id)),
    );
    expect(after[0]!.pw).not.toBe(before[0]!.pw);
  });
});

describe('listUsers', () => {
  it('paginates, filters by role, and returns overrides already in the DB', async () => {
    await create({ role: 'receptionist' });
    await create({ role: 'manager' });
    const { data, total } = await listUsers({ role: 'receptionist', limit: 25, offset: 0 });
    expect(total).toBeGreaterThanOrEqual(1);
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data.every((u) => u.role === 'receptionist')).toBe(true);
    expect(data[0]!.overrides).toEqual([]);

    const all = await listUsers({ limit: 100, offset: 0 });
    expect(all.total).toBeGreaterThanOrEqual(2);
    expect(all.data.length).toBeLessThanOrEqual(100);
  });

  it('searches by name case-insensitively', async () => {
    const id = await create({ name: 'Zebedee Njeru' });
    const { data } = await listUsers({ search: 'zebedee', limit: 25, offset: 0 });
    expect(data.some((u) => u.id === id)).toBe(true);
  });
});