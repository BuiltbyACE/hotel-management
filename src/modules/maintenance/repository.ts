/**
 * modules/maintenance/repository.ts
 *
 * SQL for the maintenance flow. Owned tables: maintenance_issues,
 * maintenance_updates. The room rows and the block allocations are the
 * property/availability tables read through the schema barrel (an established
 * cross-module read/write pattern — the D8 payoff lives in room_allocations).
 */
import { and, eq, desc, sql, type SQL } from 'drizzle-orm';
import { type Db, type Tx } from '@/core/db';
import { schema } from '@/core/db';
import type { MaintenancePriority, MaintenanceStatus } from './types';

export interface IssueRow {
  id: string;
  propertyId: string;
  reference: string;
  title: string;
  description: string;
  roomId: string | null;
  location: string | null;
  priority: MaintenancePriority;
  status: MaintenanceStatus;
  assignedTo: string | null;
  assignedUserId: string | null;
  estimatedCost: string | null;
  takesRoomOffline: boolean;
  reportedBy: string;
  reportedAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolutionNotes: string | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueListFilters {
  propertyId: string;
  status?: MaintenanceStatus;
  priority?: MaintenancePriority;
  roomId?: string;
  limit: number;
  offset: number;
}

export interface IssueListRow {
  id: string;
  reference: string;
  title: string;
  description: string;
  roomId: string | null;
  roomNumber: string | null;
  location: string | null;
  priority: MaintenancePriority;
  status: MaintenanceStatus;
  assignedTo: string | null;
  estimatedCost: string | null;
  takesRoomOffline: boolean;
  reportedBy: string;
  reportedAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolutionNotes: string | null;
  closedAt: Date | null;
  actualCost: string | null;
  expenseCount: number;
  createdAt: Date;
}

export async function insertIssue(
  tx: Tx,
  row: {
    propertyId: string;
    reference: string;
    title: string;
    description: string;
    roomId: string | null;
    location: string | null;
    priority: MaintenancePriority;
    status: MaintenanceStatus;
    assignedTo: string | null;
    assignedUserId: string | null;
    estimatedCost: string | null;
    takesRoomOffline: boolean;
    reportedBy: string;
  },
): Promise<IssueRow> {
  const rows = await tx.insert(schema.maintenanceIssues).values(row).returning();
  return rows[0]!;
}

export async function insertIssueUpdate(
  tx: Tx,
  row: {
    issueId: string;
    fromStatus: MaintenanceStatus | null;
    toStatus: MaintenanceStatus;
    note: string | null;
    fileIds: string[];
    createdBy: string;
  },
): Promise<string> {
  const rows = await tx
    .insert(schema.maintenanceUpdates)
    .values({ ...row, fileIds: row.fileIds.length ? row.fileIds : sql`'{}'` })
    .returning({ id: schema.maintenanceUpdates.id });
  return rows[0]!.id;
}

function issueFilters(f: IssueListFilters): SQL[] {
  const clauses: SQL[] = [eq(schema.maintenanceIssues.propertyId, f.propertyId)];
  if (f.status) clauses.push(eq(schema.maintenanceIssues.status, f.status));
  if (f.priority) clauses.push(eq(schema.maintenanceIssues.priority, f.priority));
  if (f.roomId) clauses.push(eq(schema.maintenanceIssues.roomId, f.roomId));
  return clauses;
}

export async function countIssues(db: Db, f: IssueListFilters): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.maintenanceIssues)
    .where(and(...issueFilters(f)));
  return rows[0]?.n ?? 0;
}

export async function listIssues(db: Db, f: IssueListFilters): Promise<IssueListRow[]> {
  const rows = await db
    .select({
      id: schema.maintenanceIssues.id,
      reference: schema.maintenanceIssues.reference,
      title: schema.maintenanceIssues.title,
      description: schema.maintenanceIssues.description,
      roomId: schema.maintenanceIssues.roomId,
      roomNumber: schema.rooms.roomNumber,
      location: schema.maintenanceIssues.location,
      priority: schema.maintenanceIssues.priority,
      status: schema.maintenanceIssues.status,
      assignedTo: schema.maintenanceIssues.assignedTo,
      estimatedCost: schema.maintenanceIssues.estimatedCost,
      takesRoomOffline: schema.maintenanceIssues.takesRoomOffline,
      reportedBy: schema.maintenanceIssues.reportedBy,
      reportedAt: schema.maintenanceIssues.reportedAt,
      resolvedAt: schema.maintenanceIssues.resolvedAt,
      resolvedBy: schema.maintenanceIssues.resolvedBy,
      resolutionNotes: schema.maintenanceIssues.resolutionNotes,
      closedAt: schema.maintenanceIssues.closedAt,
      actualCost: schema.maintenanceCostView.actualCost,
      expenseCount: schema.maintenanceCostView.expenseCount,
      createdAt: schema.maintenanceIssues.createdAt,
    })
    .from(schema.maintenanceIssues)
    .leftJoin(schema.rooms, eq(schema.rooms.id, schema.maintenanceIssues.roomId))
    .leftJoin(schema.maintenanceCostView, eq(schema.maintenanceCostView.issueId, schema.maintenanceIssues.id))
    .where(and(...issueFilters(f)))
    .orderBy(desc(schema.maintenanceIssues.reportedAt))
    .limit(f.limit)
    .offset(f.offset);
  return rows.map((r) => ({ ...r, expenseCount: r.expenseCount ?? 0, roomNumber: r.roomNumber ?? null }));
}

export async function findIssueById(db: Db | Tx, id: string): Promise<IssueRow | undefined> {
  const rows = await db.select().from(schema.maintenanceIssues).where(eq(schema.maintenanceIssues.id, id)).limit(1);
  return rows[0];
}

export async function lockIssueForUpdate(tx: Tx, id: string): Promise<IssueRow | undefined> {
  const rows = await tx
    .select()
    .from(schema.maintenanceIssues)
    .where(eq(schema.maintenanceIssues.id, id))
    .for('update')
    .limit(1);
  return rows[0];
}

export async function listIssueUpdates(db: Db | Tx, issueId: string) {
  return db
    .select()
    .from(schema.maintenanceUpdates)
    .where(eq(schema.maintenanceUpdates.issueId, issueId))
    .orderBy(schema.maintenanceUpdates.createdAt);
}

export async function findBlockAllocation(db: Db | Tx, issueId: string) {
  const rows = await db
    .select()
    .from(schema.roomAllocations)
    .where(
      and(
        eq(schema.roomAllocations.maintenanceIssueId, issueId),
        eq(schema.roomAllocations.kind, 'block'),
        eq(schema.roomAllocations.status, 'blocked'),
      ),
    )
    .limit(1);
  return rows[0];
}

export async function insertBlockAllocation(
  tx: Tx,
  row: {
    propertyId: string;
    roomId: string;
    maintenanceIssueId: string;
    blockReason: string;
    startDate: string;
    endDate: string;
    createdBy: string;
  },
): Promise<string> {
  const rows = await tx
    .insert(schema.roomAllocations)
    .values({
      propertyId: row.propertyId,
      roomId: row.roomId,
      kind: 'block',
      status: 'blocked',
      maintenanceIssueId: row.maintenanceIssueId,
      blockReason: row.blockReason,
      startDate: row.startDate,
      endDate: row.endDate,
      createdBy: row.createdBy,
    })
    .returning({ id: schema.roomAllocations.id });
  return rows[0]!.id;
}

export async function releaseBlockAllocation(tx: Tx, issueId: string): Promise<void> {
  await tx
    .update(schema.roomAllocations)
    .set({ status: 'released', releasedAt: new Date() })
    .where(
      and(
        eq(schema.roomAllocations.maintenanceIssueId, issueId),
        eq(schema.roomAllocations.kind, 'block'),
        eq(schema.roomAllocations.status, 'blocked'),
      ),
    );
}

export async function setRoomCondition(tx: Tx, roomId: string, condition: RoomConditionValue): Promise<void> {
  await tx.update(schema.rooms).set({ condition }).where(eq(schema.rooms.id, roomId));
}

type RoomConditionValue = 'available' | 'occupied' | 'cleaning' | 'maintenance' | 'out_of_order';

export async function updateIssue(
  tx: Tx,
  id: string,
  patch: {
    status?: MaintenanceStatus;
    assignedTo?: string | null;
    assignedUserId?: string | null;
    estimatedCost?: string;
    resolutionNotes?: string | null;
    resolvedAt?: Date | null;
    resolvedBy?: string | null;
    closedAt?: Date | null;
  },
): Promise<IssueRow> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) safe[key] = value;
  }
  const rows = await tx.update(schema.maintenanceIssues).set(safe as never).where(eq(schema.maintenanceIssues.id, id)).returning();
  return rows[0]!;
}

export async function findRoomRow(db: Db | Tx, id: string) {
  const rows = await db.select().from(schema.rooms).where(eq(schema.rooms.id, id)).limit(1);
  return rows[0];
}