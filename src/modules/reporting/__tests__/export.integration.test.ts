/**
 * Integration test: async report export (§18.3).
 *
 * The export FILO is covered end-to-end through the job handler directly
 * (render → private storage → files row → notification → audit), because the
 * queue hand-off is the worker's own contract (core/jobs). Enqueue + dedupe
 * are verified separately. Storage is swapped to a throwaway local backend so
 * the suite never touches R2.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { withDb, withTx, schema } from '@/core/db';
import { files, jobQueue } from '@/core/db/infra';
import { __useStorageAdapter, LocalStorage } from '@/core/files/storage';
import { getFileRecord } from '@/core/files';
import { getStorage } from '@/core/files';
import { enqueue } from '@/core/jobs';
import { resolvePermissions, type Actor } from '@/modules/identity/auth-guard';
import { AppError } from '@/core/api';
import { today } from '@/core/dates';
import { exportReportJob, registerExportJobs } from '../export';
import { schemaForExport, validateExportName } from '../service';

vi.setConfig({ testTimeout: 60_000 });

let fixture: Actor;
let userId = '';
let propertyId = '';

async function seed(): Promise<void> {
  await withTx(async (tx) => {
    userId = randomUUID();
    await tx.insert(schema.users).values({
      id: userId,
      name: 'Export Admin',
      email: `export-admin-${randomUUID().slice(0, 8)}@hms.test`,
      role: 'admin',
      status: 'active',
      mustChangePassword: true,
      createdBy: null,
    });
    await tx.insert(schema.accounts).values({ id: randomUUID(), userId, providerId: 'credential', accountId: userId, password: 'x' });

    const propId = await tx
      .insert(schema.properties)
      .values({ name: `Export Hotel ${randomUUID().slice(0, 6)}` })
      .returning({ id: schema.properties.id })
      .then((rows) => rows[0]!.id);
    propertyId = propId;

    const rt = await tx
      .insert(schema.roomTypes)
      .values({ propertyId, code: 'EXP', name: 'Exporter', baseRate: '1000.00', maxOccupancy: 2, maxAdults: 2, maxChildren: 0 })
      .returning({ id: schema.roomTypes.id })
      .then((rows) => rows[0]!.id);
    await tx.insert(schema.rooms).values({ propertyId, roomTypeId: rt, roomNumber: '99' });
  });

  fixture = {
    id: userId,
    name: 'Export Admin',
    email: `export-admin-${randomUUID().slice(0, 8)}@hms.test`,
    role: 'admin',
    propertyId,
    permissions: resolvePermissions('admin', []),
  };
}

beforeAll(async () => {
  __useStorageAdapter(new LocalStorage(mkdtempSync(path.join(tmpdir(), 'hms-export-'))));
  await seed();
  registerExportJobs();
});

afterAll(async () => {
  await withDb(async (db) => {
    await db.delete(schema.notifications).where(eq(schema.notifications.userId, userId));
    await db.delete(files).where(eq(files.uploadedBy, userId));
    await db.delete(schema.activityLogs).where(eq(schema.activityLogs.actorId, userId));
  });
});

const requestedBy = () => ({ id: fixture.id, name: fixture.name, email: fixture.email, role: fixture.role });

describe('reporting export (§18.3)', () => {
  it('enqueues once per identical request and dedupes on the second', async () => {
    const job = {
      jobType: 'export.report',
      propertyId,
      dedupeKey: `export.report:${userId}:bookings:same`,
      payload: {
        name: 'bookings',
        format: 'xlsx',
        propertyId,
        requestedBy: requestedBy(),
        params: {},
      },
    };
    const [first] = await withTx((tx) => enqueue(tx, [job]));
    const ids = await withTx((tx) => enqueue(tx, [job]));
    expect(ids).toHaveLength(0);
    const rows = await withDb((db) =>
      db.select({ id: jobQueue.id }).from(jobQueue).where(eq(jobQueue.dedupeKey, job.dedupeKey!)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first);
  });

  it('rejects unknown report names before anything is queued', () => {
    expect(() => validateExportName('nope')).toThrow(AppError);
    expect(validateExportName('maintenance-issues')).toBe('maintenance-issues');
    expect(schemaForExport('occupancy').safeParse({ groupBy: 'week' }).success).toBe(true);
  });

  it('renders xlsx to private storage with a files row, notification, and audit', async () => {
    const jobId = 42_001;

    await exportReportJob(
      { name: 'available-rooms', format: 'xlsx', propertyId, requestedBy: requestedBy(), params: {} },
      { jobId, propertyId },
    );

    const rows = await withDb((db) =>
      db.select().from(files).where(eq(files.entityType, 'report')).orderBy(files.createdAt),
    );
    expect(rows.length).toBeGreaterThan(0);
    const file = rows[rows.length - 1]!;
    expect(file.propertyId).toBe(propertyId);
    expect(file.visibility).toBe('private');
    expect(file.mimeType).toContain('spreadsheetml');
    expect(file.storageKey.startsWith(`private/report/available-rooms/${new Date().getUTCFullYear()}/`)).toBe(true);
    expect(file.originalName.startsWith('available-rooms-')).toBe(true);
    expect(file.sizeBytes).toBeGreaterThan(0);

    const blob = await getStorage().get(file.storageKey);
    expect(blob).not.toBeNull();
    expect(blob!.body.byteLength).toBe(file.sizeBytes);

    const notifications = await withDb((db) =>
      db.select().from(schema.notifications).where(and(eq(schema.notifications.userId, userId), eq(schema.notifications.type, 'report.export_ready'))),
    );
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications[0]!.link).toBe(`/v1/reports/exports/${file.id}/url`);

    const audit = await withDb((db) =>
      db.select().from(schema.activityLogs).where(eq(schema.activityLogs.action, 'reports.export')),
    );
    expect(audit.length).toBeGreaterThan(0);

    await expect(withDb((db) => getFileRecord(db, file.id))).resolves.toMatchObject({ entityType: 'report' });
  });

  it('renders csv lines for rows and the totals row', async () => {
    const jobId = 42_002;

    await exportReportJob(
      { name: 'available-rooms', format: 'csv', propertyId, requestedBy: requestedBy(), params: { date: today() } },
      { jobId, propertyId },
    );

    const rows = await withDb((db) =>
      db.select().from(files).where(eq(files.entityType, 'report')).orderBy(files.createdAt),
    );
    const csv = [...rows].reverse().find((f) => f.mimeType === 'text/csv') ?? rows[rows.length - 1]!;
    const stored = await getStorage().get(csv.storageKey);
    expect(stored).not.toBeNull();
    const text = new TextDecoder().decode(stored!.body);

    const lines = text.split('\r\n').filter((l) => l.length > 0);
    expect(lines[0]).toContain('roomType');
    expect(lines.some((l) => l.includes('Exporter'))).toBe(true);
    expect(lines[lines.length - 1]!.split(',')[1]).toBe('1'); // totals.total
  });
});