/**
 * Integration test: the maintenance flow (§14.1, spec A10/A15).
 *
 * Reporting takes the room offline via a room_allocations block — the room
 * becomes unbookable through the exclusion constraint, not a code path.
 * Transitions are forward-only and every one lands in maintenance_updates.
 * Resolving releases the block and returns the room to cleaning.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { withDb, withTx, schema } from '@/core/db';
import { resolvePermissions, type Actor } from '@/modules/identity/auth-guard';
import { addDays, today } from '@/core/dates';
import { createBooking } from '@/modules/bookings/service';
import { reportIssue, updateIssue, getIssue, listIssuesService } from '../service';
import type { ReportIssueInput } from '../validation';

vi.setConfig({ testTimeout: 60_000 });

function actor(id: string, propertyId: string | null): Actor {
  return {
    id,
    name: 'MT Admin',
    email: `mt-admin-${randomUUID().slice(0, 6)}@hms.test`,
    role: 'admin',
    propertyId,
    permissions: resolvePermissions('admin', []),
  };
}

const ACTOR = actor('', null);
const ACTOR_OTHER = actor('', null);

let userId = '';
let propertyId = '';
const rooms: Record<string, string> = {};
const issueIds: string[] = [];

const OFFLINE = '101';
const CLEAN = '102';

async function seed() {
  await withTx(async (tx) => {
    userId = randomUUID();
    await tx.insert(schema.users).values({
      id: userId,
      name: 'MT Admin',
      email: `mt-admin-${randomUUID().slice(0, 8)}@hms.test`,
      role: 'admin',
      status: 'active',
      mustChangePassword: true,
      createdBy: null,
    });
    await tx.insert(schema.accounts).values({
      id: randomUUID(),
      userId,
      providerId: 'credential',
      accountId: userId,
      password: 'not-used-in-tests',
    });
    const propId = await tx
      .insert(schema.properties)
      .values({ name: `MT Hotel ${randomUUID().slice(0, 6)}` })
      .returning({ id: schema.properties.id })
      .then((rows) => rows[0]!.id);
    propertyId = propId;

    const rt = await tx
      .insert(schema.roomTypes)
      .values({
        propertyId,
        code: 'STD',
        name: 'Standard',
        baseRate: '5000.00',
        maxOccupancy: 2,
        maxAdults: 2,
        maxChildren: 1,
        extraBedRate: '1500.00',
      })
      .returning({ id: schema.roomTypes.id })
      .then((rows) => rows[0]!.id);

    for (const n of [OFFLINE, CLEAN]) {
      rooms[n] = await tx
        .insert(schema.rooms)
        .values({ propertyId, roomTypeId: rt, roomNumber: n })
        .returning({ id: schema.rooms.id })
        .then((rows) => rows[0]!.id);
    }
  });
  ACTOR.id = userId;
  ACTOR.propertyId = propertyId;
  ACTOR_OTHER.id = userId;
  ACTOR_OTHER.propertyId = randomUUID();
}

beforeAll(async () => {
  await seed();
});

afterAll(async () => {
  await withTx(async (tx) => {
    if (issueIds.length > 0) {
      await tx
        .delete(schema.roomAllocations)
        .where(
          and(eq(schema.roomAllocations.kind, 'block'), sql`${schema.roomAllocations.maintenanceIssueId} IN (${sql.join(issueIds.map((i) => sql`${i}`), sql`,`)})`),
        );
      await tx.delete(schema.maintenanceIssues).where(sql`${schema.maintenanceIssues.id} IN (${sql.join(issueIds.map((i) => sql`${i}`), sql`,`)})`);
    }
    const roomIds = Object.values(rooms);
    if (roomIds.length > 0) {
      await tx.delete(schema.roomAllocations).where(eq(schema.roomAllocations.propertyId, propertyId));
      await tx.delete(schema.rooms).where(sql`${schema.rooms.id} IN (${sql.join(roomIds.map((i) => sql`${i}`), sql`,`)})`);
    }
    await tx.delete(schema.roomTypes).where(eq(schema.roomTypes.propertyId, propertyId));
    await tx.delete(schema.numberSequences).where(eq(schema.numberSequences.propertyId, propertyId));
  });
});

async function roomCondition(roomId: string): Promise<string | null> {
  const rows = await withDb((db) => db.select({ condition: schema.rooms.condition }).from(schema.rooms).where(eq(schema.rooms.id, roomId)));
  return rows[0]?.condition ?? null;
}

async function report(input: ReportIssueInput) {
  const issue = await reportIssue(input, ACTOR);
  issueIds.push(issue.id);
  return issue;
}

describe('reportIssue', () => {
  it('reports an issue and blocks the room via an allocation', async () => {
    const start = today();
    const end = addDays(start, 3) as string;
    const issue = await report({
      title: 'Broken Air Conditioner',
      description: 'AC not cooling, guest room 101',
      roomId: rooms[OFFLINE]!,
      priority: 'high',
      estimatedCost: '18500.00',
      takesRoomOffline: true,
      blockStartDate: start,
      blockEndDate: end,
    });

    expect(issue.reference).toMatch(/^MT-\d{6}$/);
    expect(issue).toMatchObject({
      status: 'reported',
      priority: 'high',
      estimatedCost: '18500.00',
      takesRoomOffline: true,
      roomId: rooms[OFFLINE]!,
      roomNumber: OFFLINE,
    });
    expect(issue.block).toMatchObject({ startDate: start, endDate: end });
    expect(await roomCondition(rooms[OFFLINE]!)).toBe('maintenance');
    expect(issue.updates.map((u) => u.toStatus)).toEqual(['reported']);
  });

  it('makes the blocked room unbookable through the exclusion constraint', async () => {
    await expect(
      createBooking(
        {
          guest: { fullName: `G ${randomUUID().slice(0, 6)}`, phone: '+254700111222', idType: 'national_id', idNumber: randomUUID() },
          source: 'front_desk',
          rooms: [{ roomId: rooms[OFFLINE]!, arrival: today(), departure: addDays(today(), 2), adults: 2, children: 0 }],
        },
        ACTOR,
      ),
    ).rejects.toThrow();
  });

  it('reports a location-based issue without touching a room', async () => {
    const issue = await report({
      title: 'Lobby light out',
      description: 'Reception pendant light flickering',
      location: 'Lobby',
    });
    expect(issue.roomId).toBeNull();
    expect(issue.roomNumber).toBeNull();
    expect(issue.block).toBeNull();
  });
});

describe('updateIssue', () => {
  it('assigns and moves to in_progress, logging the transition', async () => {
    const issue = await report({
      title: 'First floor faucet',
      description: 'Dripping tap in room 102',
      roomId: rooms[CLEAN]!,
      priority: 'low',
    });

    const updated = await updateIssue(
      issue.id,
      { status: 'in_progress', assignedTo: 'Cool Air Ltd' },
      ACTOR,
    );

    expect(updated.status).toBe('in_progress');
    expect(updated.assignedTo).toBe('Cool Air Ltd');
    const trail = updated.updates.map((u) => [u.fromStatus, u.toStatus]);
    expect(trail).toContainEqual(['reported', 'in_progress']);
  });

  it('rejects backward transitions', async () => {
    const issue = await report({ title: 'Temporary', description: 'x', location: 'Gym' });
    const closed = await updateIssue(issue.id, { status: 'closed' }, ACTOR);
    await expect(updateIssue(closed.id, { status: 'in_progress' }, ACTOR)).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
  });

  it('releases the block and returns the room to cleaning on resolve', async () => {
    const start = today();
    const end = addDays(start, 5);
    const issue = await report({
      title: 'AC unit 2',
      description: 'Second unit needs a recharge',
      roomId: rooms[CLEAN]!,
      takesRoomOffline: true,
      blockStartDate: start,
      blockEndDate: end as string,
    });
    expect(issue.block).not.toBeNull();

    const resolved = await updateIssue(
      issue.id,
      { status: 'resolved', resolutionNotes: 'Recharged, cooling fine', note: 'Technician done' },
      ACTOR,
    );

    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.resolvedBy).toBe(userId);
    expect(resolved.resolutionNotes).toBe('Recharged, cooling fine');
    expect(resolved.block).toBeNull();

    const alloc = await withDb((db) =>
      db
        .select({ status: schema.roomAllocations.status, releasedAt: schema.roomAllocations.releasedAt })
        .from(schema.roomAllocations)
        .where(and(eq(schema.roomAllocations.maintenanceIssueId, issue.id), eq(schema.roomAllocations.kind, 'block'))),
    );
    expect(alloc[0]).toMatchObject({ status: 'released' });
    expect(alloc[0]!.releasedAt).not.toBeNull();
    expect(await roomCondition(rooms[CLEAN]!)).toBe('cleaning');
  });
});

describe('reads & scoping', () => {
  it('lists issues with filters and pagination', async () => {
    const { total } = await listIssuesService({ status: 'reported', page: 1, pageSize: 25 }, ACTOR);
    expect(total).toBeGreaterThanOrEqual(1);

    const result = await listIssuesService({ page: 1, pageSize: 100 }, ACTOR);
    expect(result.data.length).toBe(result.total);
    expect(result.data[0]!.reference).toMatch(/^MT-\d{6}$/);
  });

  it('is scoped to the actor property', async () => {
    const issue = await report({ title: 'Scoped', description: 'y', location: 'Garden' });
    await expect(getIssue(issue.id, ACTOR_OTHER)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(updateIssue(issue.id, { status: 'closed' }, ACTOR_OTHER)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
