/**
 * modules/maintenance/service.ts
 *
 * Maintenance flow (blueprint §14.1, spec A10/A15): report → assign → resolve →
 * close, every transition logged to maintenance_updates. A reported issue may
 * take its room offline: `takesRoomOffline` writes a room_allocations
 * `block` row, so the EXCLUSION CONSTRAINT makes the room unbookable for the
 * repair window with no separate code path — the D8 payoff. Resolving releases
 * the block and returns the room to `cleaning`.
 *
 * Transitions happen ONLY here; the route never sets status directly.
 */
import { eq } from 'drizzle-orm';
import { withDb, withTx } from '@/core/db';
import { schema } from '@/core/db';
import { AppError } from '@/core/api';
import { nextNumber } from '@/core/db/sequence';
import { today } from '@/core/dates';
import { eventBus } from '@/core/events';
import { recordAudit, auditActor } from '@/modules/audit/service';
import type { Actor } from '@/modules/identity/auth-guard';
import type { MaintenanceStatus } from './types';
import type { ReportIssueInput, UpdateIssueInput, ListIssuesQuery } from './validation';
import {
  countIssues,
  findBlockAllocation,
  findIssueById,
  findRoomRow,
  insertBlockAllocation,
  insertIssue,
  insertIssueUpdate,
  listIssues,
  listIssueUpdates,
  lockIssueForUpdate,
  releaseBlockAllocation,
  setRoomCondition,
  updateIssue as patchIssue,
} from './repository';
import { MAINTENANCE_EVENTS } from './events';

const STATUS_ORDER: MaintenanceStatus[] = ['reported', 'pending', 'in_progress', 'resolved', 'closed'];

/** Forward-only transitions; resolving precedes closing, closed is terminal. */
function checkedTransition(from: MaintenanceStatus, to: MaintenanceStatus): void {
  if (STATUS_ORDER.indexOf(to) <= STATUS_ORDER.indexOf(from)) {
    throw AppError.badRequest('INVALID_TRANSITION', `Cannot move issue from ${from} to ${to}`);
  }
}

export async function reportIssue(input: ReportIssueInput, actor: Actor) {
  const propertyId = requireProperty(actor);

  if (input.takesRoomOffline && !input.roomId) {
    throw AppError.badRequest('VALIDATION_ERROR', 'takesRoomOffline requires a roomId');
  }
  if (input.assignedUserId && !input.assignedTo) {
    throw AppError.badRequest('VALIDATION_ERROR', 'assignedTo is required alongside assignedUserId');
  }

  const issueId = await withTx(async (tx) => {
    const existingRoom = input.roomId ? await findRoomRow(tx, input.roomId) : null;
    if (input.roomId && !existingRoom) throw AppError.notFound('Room not found');
    if (existingRoom && existingRoom.propertyId !== propertyId) {
      throw AppError.badRequest('VALIDATION_ERROR', 'Room does not belong to this property');
    }

    const { reference } = await nextNumber(tx, propertyId, 'maintenance', {
      prefix: 'MT-',
      period: today().slice(0, 4),
    });

    const issue = await insertIssue(tx, {
      propertyId,
      reference,
      title: input.title,
      description: input.description,
      roomId: input.roomId ?? null,
      location: input.location ?? null,
      priority: input.priority ?? 'medium',
      status: 'reported',
      assignedTo: input.assignedTo ?? null,
      assignedUserId: input.assignedUserId ?? null,
      estimatedCost: input.estimatedCost ?? null,
      takesRoomOffline: input.takesRoomOffline ?? false,
      reportedBy: actor.id,
    });

    await insertIssueUpdate(tx, {
      issueId: issue.id,
      fromStatus: null,
      toStatus: 'reported',
      note: null,
      fileIds: [],
      createdBy: actor.id,
    });

    if (input.takesRoomOffline && input.roomId) {
      await insertBlockAllocation(tx, {
        propertyId,
        roomId: input.roomId,
        maintenanceIssueId: issue.id,
        blockReason: `Maintenance ${reference}: ${input.title}`,
        startDate: input.blockStartDate ?? today(),
        endDate: input.blockEndDate!,
        createdBy: actor.id,
      });
      await setRoomCondition(tx, input.roomId, 'maintenance');
    }

    await recordAudit(tx, {
      actor: auditActor(actor),
      propertyId,
      action: 'maintenance.report',
      entityType: 'maintenance_issue',
      entityId: issue.id,
      summary: `Issue ${reference} reported${input.roomId ? ' for room' : ''}: ${input.title}`,
    });

    await eventBus.emit(MAINTENANCE_EVENTS.issueReported, {
      issueId: issue.id,
      reference,
      title: input.title,
      propertyId,
      roomId: input.roomId ?? null,
      toStatus: 'reported',
      by: actor.email,
    });

    return issue.id;
  });

  return getIssue(issueId, actor);
}

export async function updateIssue(id: string, input: UpdateIssueInput, actor: Actor) {
  const propertyId = requireProperty(actor);
  const assigned = input.assignedTo !== undefined || input.assignedUserId !== undefined;

  await withTx(async (tx) => {
    const issue = await lockIssueForUpdate(tx, id);
    if (!issue || issue.propertyId !== propertyId) throw AppError.notFound('Maintenance issue not found');

    const nextStatus: MaintenanceStatus = input.status ?? issue.status;
    if (input.status !== undefined && input.status !== issue.status) {
      checkedTransition(issue.status, input.status);
    }

    const patch: {
      status?: MaintenanceStatus;
      assignedTo?: string | null;
      assignedUserId?: string | null;
      estimatedCost?: string;
      resolutionNotes?: string | null;
      resolvedAt?: Date | null;
      resolvedBy?: string | null;
      closedAt?: Date | null;
    } = {
      status: input.status ?? undefined,
    };
    if (assigned) {
      patch.assignedTo = input.assignedTo ?? null;
      patch.assignedUserId = input.assignedUserId ?? null;
    }
    if (input.estimatedCost !== undefined) patch.estimatedCost = input.estimatedCost;
    if (input.resolutionNotes !== undefined) patch.resolutionNotes = input.resolutionNotes;
    if (nextStatus === 'resolved') {
      patch.resolvedAt = new Date();
      patch.resolvedBy = actor.id;
    }
    if (nextStatus === 'closed') patch.closedAt = new Date();

    if (nextStatus === 'resolved' && issue.takesRoomOffline && issue.roomId) {
      const block = await findBlockAllocation(tx, issue.id);
      if (block) await releaseBlockAllocation(tx, issue.id);
      await setRoomCondition(tx, issue.roomId, 'cleaning');
    }

    await patchIssue(tx, id, patch);
    await insertIssueUpdate(tx, {
      issueId: issue.id,
      fromStatus: issue.status,
      toStatus: nextStatus,
      note: input.note ?? null,
      fileIds: input.fileIds ?? [],
      createdBy: actor.id,
    });

    await recordAudit(tx, {
      actor: auditActor(actor),
      propertyId,
      action: 'maintenance.update',
      entityType: 'maintenance_issue',
      entityId: issue.id,
      summary: `Issue ${issue.reference} updated: ${issue.status} → ${nextStatus}${
        assigned ? ', assigned' : ''
      }`,
    });

    const evt = {
      issueId: issue.id,
      reference: issue.reference,
      title: issue.title,
      propertyId,
      roomId: issue.roomId,
      by: actor.email,
    };
    if (assigned) {
      await eventBus.emit(MAINTENANCE_EVENTS.issueAssigned, { ...evt, fromStatus: null, toStatus: null });
    }
    if (nextStatus === 'resolved') {
      await eventBus.emit(MAINTENANCE_EVENTS.issueResolved, { ...evt, fromStatus: issue.status, toStatus: nextStatus });
    } else if (input.status !== undefined && input.status !== issue.status) {
      await eventBus.emit(MAINTENANCE_EVENTS.issueStatusChanged, {
        ...evt,
        fromStatus: issue.status,
        toStatus: nextStatus,
      });
    }
  });

  return getIssue(id, actor);
}

export async function getIssue(id: string, actor: Actor) {
  const propertyId = requireProperty(actor);
  return withDb(async (db) => {
    const issue = await findIssueById(db, id);
    if (!issue || issue.propertyId !== propertyId) throw AppError.notFound('Maintenance issue not found');
    const room = issue.roomId ? await findRoomRow(db, issue.roomId) : null;
    const [cost] = await db
      .select()
      .from(schema.maintenanceCostView)
      .where(eq(schema.maintenanceCostView.issueId, id));
    const block = await findBlockAllocation(db, id);
    const updates = await listIssueUpdates(db, id);
    return {
      id: issue.id,
      reference: issue.reference,
      title: issue.title,
      description: issue.description,
      roomId: issue.roomId,
      roomNumber: room?.roomNumber ?? null,
      location: issue.location,
      priority: issue.priority,
      status: issue.status,
      assignedTo: issue.assignedTo,
      estimatedCost: issue.estimatedCost,
      takesRoomOffline: issue.takesRoomOffline,
      reportedBy: issue.reportedBy,
      reportedAt: issue.reportedAt.toISOString(),
      resolvedAt: issue.resolvedAt?.toISOString() ?? null,
      resolvedBy: issue.resolvedBy,
      resolutionNotes: issue.resolutionNotes,
      closedAt: issue.closedAt?.toISOString() ?? null,
      actualCost: cost?.actualCost ?? null,
      expenseCount: cost ? Number(cost.expenseCount) : 0,
      block: block ? { id: block.id, startDate: block.startDate, endDate: block.endDate } : null,
      updates: updates.map((u) => ({
        id: u.id,
        fromStatus: u.fromStatus,
        toStatus: u.toStatus,
        note: u.note,
        fileIds: u.fileIds,
        createdBy: u.createdBy,
        createdAt: u.createdAt.toISOString(),
      })),
      createdAt: issue.createdAt.toISOString(),
    };
  });
}

export interface IssueListResult {
  data: Awaited<ReturnType<typeof getIssue>>[];
  total: number;
}

export async function listIssuesService(query: ListIssuesQuery, actor: Actor): Promise<IssueListResult> {
  const propertyId = requireProperty(actor);
  const filters = {
    propertyId,
    status: query.status,
    priority: query.priority,
    roomId: query.roomId,
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  };
  const [rows, total] = await Promise.all([
    withDb((db) => listIssues(db, filters)),
    withDb((db) => countIssues(db, filters)),
  ]);
  const data: Awaited<ReturnType<typeof getIssue>>[] = [];
  for (const row of rows) {
    data.push((await getIssue(row.id, actor)) as Awaited<ReturnType<typeof getIssue>>);
  }
  return { data, total };
}

function requireProperty(actor: Actor): string {
  if (!actor.propertyId) throw AppError.forbidden('FORBIDDEN', 'Actor is not bound to a property');
  return actor.propertyId;
}