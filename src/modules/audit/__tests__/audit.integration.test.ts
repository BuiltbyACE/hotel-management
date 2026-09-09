/**
 * Integration tests: audit trail + notifications.
 * Requires a running Postgres (docker-compose up -d).
 *
 * activity_logs is append-only (no_delete/no_update RULES) — rows can never be
 * removed and actor/property FKs are real, so we seed a dedicated property +
 * users per run and scope every assertion to unique markers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { schema, withDb, withTx } from '@/core/db';
import { type Actor } from '@/modules/identity/auth-guard';
import {
  auditActor,
  listActivityLogsRoute,
  listMyNotifications,
  markNotificationRead,
  notify,
  recordAudit,
  SYSTEM_ACTOR,
} from '../service';

const marker = Date.now().toString(36);
let actorId = '';
let propId = '';
let otherUser = '';

function actor(role: Actor['role']): Actor {
  return { id: actorId, name: 'Audit Tester', email: 'audit@test.local', role, propertyId: propId, permissions: new Set() };
}

beforeAll(async () => {
  actorId = randomUUID();
  propId = randomUUID();
  otherUser = randomUUID();
  await withTx(async (tx) => {
    await tx.insert(schema.users).values([
      {
        id: actorId,
        name: 'Audit Tester',
        email: `audit-tester-${randomUUID().slice(0, 8)}@hms.test`,
        role: 'manager',
        status: 'active',
        mustChangePassword: true,
        createdBy: null,
      },
      {
        id: otherUser,
        name: 'Other User',
        email: `audit-other-${randomUUID().slice(0, 8)}@hms.test`,
        role: 'receptionist',
        status: 'active',
        mustChangePassword: true,
        createdBy: null,
      },
    ]);
    await tx.insert(schema.properties).values({
      id: propId,
      name: `Audit Hotel ${randomUUID().slice(0, 6)}`,
      taxPin: 'P051234567K',
    });
  });
});

afterAll(async () => {
  // Notifications are cascaded from users; clean this run's rows only.
  await withDb((db) => db.delete(schema.notifications).where(inArray(schema.notifications.userId, [actorId, otherUser])));
});

describe('audit trail', () => {
  it('writes an append-only row inside the caller transaction', async () => {
    const entityId = randomUUID();
    await withTx((tx) =>
      recordAudit(tx, {
        actor: auditActor(actor('manager')),
        propertyId: propId,
        action: `it.create.${marker}`,
        entityType: 'booking',
        entityId,
        summary: `Audit trail smoke run ${marker}`,
        changes: { nights: 2 },
      }),
    );

    const { data, total } = await listActivityLogsRoute({ entityId, limit: 10, offset: 0 }, propId);
    expect(total).toBe(1);
    expect(data[0]).toMatchObject({
      entityType: 'booking',
      action: `it.create.${marker}`,
      actorId,
      actorRole: 'manager',
      actorName: 'Audit Tester',
      propertyId: propId,
    });
    expect(data[0]!.changes).toEqual({ nights: 2 });
  });

  it('is atomic with the business write: a rollback removes the audit row', async () => {
    const entityId = randomUUID();
    await expect(
      withTx(async (tx) => {
        await recordAudit(tx, {
          actor: SYSTEM_ACTOR,
          propertyId: propId,
          action: `it.rollback.${marker}`,
          entityType: 'booking',
          entityId,
          summary: 'should vanish',
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const { total } = await listActivityLogsRoute({ entityId, limit: 10, offset: 0 }, propId);
    expect(total).toBe(0);
  });

  it('stores system actors without a user and filters by action + paginates', async () => {
    const action = `it.spam.${marker}`;
    await withTx(async (tx) => {
      for (let i = 0; i < 3; i++) {
        await recordAudit(tx, {
          actor: SYSTEM_ACTOR,
          propertyId: propId,
          action,
          entityType: 'guest',
          entityId: randomUUID(),
          summary: `spam ${i}`,
        });
      }
    });

    const all = await listActivityLogsRoute({ action, limit: 10, offset: 0 }, propId);
    expect(all.total).toBe(3);
    expect(all.data.every((r) => r.actorId === null && r.actorName === 'System' && r.actorRole === null)).toBe(true);

    const page = await listActivityLogsRoute({ action, limit: 1, offset: 1 }, propId);
    expect(page.data).toHaveLength(1);
  });

  it('scopes to the property', async () => {
    const action = `it.scope.${marker}`;
    await withTx((tx) =>
      recordAudit(tx, {
        actor: auditActor(actor('admin')),
        propertyId: propId,
        action,
        entityType: 'room',
        entityId: randomUUID(),
        summary: 'scoped',
      }),
    );
    const { total } = await listActivityLogsRoute({ action, limit: 10, offset: 0 }, randomUUID());
    expect(total).toBe(0);
    const mine = await listActivityLogsRoute({ action, limit: 10, offset: 0 }, propId);
    expect(mine.total).toBe(1);
  });
});

describe('notifications', () => {
  it('creates, lists unread and marks read', async () => {
    const type = `it.note.${marker}`;
    const ids = await withTx((tx) =>
      notify(tx, [
        { userId: actorId, type, title: 'Urgent maintenance', body: 'Room 101 AC broken' },
        { userId: actorId, type, title: 'Night audit done', body: 'Daily stats frozen' },
      ]),
    );
    expect(ids).toHaveLength(2);

    const unread = await listMyNotifications(actorId, { includeRead: false, limit: 10, offset: 0 });
    expect(unread.total).toBe(2);
    expect(unread.unreadCount).toBe(2);

    await markNotificationRead(ids[0]!, actorId);

    const after = await listMyNotifications(actorId, { includeRead: false, limit: 10, offset: 0 });
    expect(after.total).toBe(1);
    expect(after.unreadCount).toBe(1);

    const all = await listMyNotifications(actorId, { includeRead: true, limit: 10, offset: 0 });
    expect(all.total).toBe(2);
  });

  it('a user cannot mark a notification that is not their own', async () => {
    const ids = await withTx((tx) =>
      notify(tx, [{ userId: otherUser, type: 'it.other', title: 'Someone else' }]),
    );
    await expect(markNotificationRead(ids[0]!, actorId)).rejects.toThrow();
  });
});