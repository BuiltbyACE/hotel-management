/**
 * modules/reporting/export.ts
 *
 * Async report export (§18.3). The route validates the query and enqueues an
 * `export.report` job; the worker re-runs the report, renders xlsx (exceljs)
 * or csv, writes bytes to the PRIVATE storage bucket (keys
 * `private/report/<name>/<yyyy>/<mm>/<uuid>.<ext>`), records a `files` row in
 * the same transaction as the notifications and audit trail, and the user
 * downloads through the guarded GET /v1/reports/exports/{fileId}/url route.
 *
 * Never synchronous — the ERP generated exports inside the request and risked
 * timeouts [ERP-FIX].
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Workbook } from 'exceljs';
import { withDb, withTx } from '@/core/db';
import { createFileRecord } from '@/core/files';
import { getStorage } from '@/core/files';
import { registerHandler, type JobContext } from '@/core/jobs';
import { auditActor, notify, recordAudit } from '@/modules/audit/service';
import type { Actor } from '@/modules/identity/auth-guard';
import { today } from '@/core/dates';
import { resolvePropertyId } from './repository';
import * as service from './service';
import { validateExportName, type ExportReportName } from './service';

type Runner = (params: Record<string, unknown>, actor: Actor) => Promise<unknown>;
const RUNNERS: Record<ExportReportName, Runner> = {
  occupancy: (p, a) => service.occupancyReport(p as never, a),
  revenue: (p, a) => service.revenueReport(p as never, a),
  'arrivals-departures': (p, a) => service.arrivalsDeparturesReport((p.date as string) ?? today(), a),
  'outstanding-balances': (_p, a) => service.outstandingBalancesReport(a),
  expenses: (p, a) => service.expensesReport(p as never, a),
  'maintenance-costs': (p, a) => service.maintenanceCostsReport(p as never, a),
  'profit-summary': (p, a) => service.profitSummaryReport(p as never, a),
  bookings: (p, a) => service.bookingsReport(p as never, a),
  'available-rooms': (p, a) => service.availableRoomsSnapshot(p as never, a),
  'maintenance-issues': (p, a) => service.maintenanceIssuesReport(p as never, a),
};

const exportPayloadSchema = z.object({
  name: z.string(),
  format: z.enum(['xlsx', 'csv']),
  propertyId: z.string().nullish(),
  requestedBy: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    role: z.enum(['admin', 'manager', 'receptionist']),
  }),
  params: z.record(z.string(), z.unknown()),
});

export interface FlatRow {
  [column: string]: string | number | null;
}

/**
 * Flatten any report view into rows + a stable column order:
 *  - `rows` arrays expand to one row each, with nested objects dropped;
 *  - arrivals/departures expand to two labelled sections;
 *  - a nested `totals` object becomes a trailing totals row.
 */
function flattenView(view: Record<string, unknown>): { columns: string[]; rows: FlatRow[]; hasTotalsRow: boolean } {
  const rows: FlatRow[] = [];
  let totalsRow: FlatRow | null = null;
  const scalarize = (obj: Record<string, unknown>): FlatRow => {
    const row: FlatRow = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) {
        row[key] = null;
      } else if (typeof value !== 'object') {
        row[key] = scalar(value);
      }
    }
    return row;
  };

  if (Array.isArray(view.rows)) {
    for (const r of view.rows as Record<string, unknown>[]) rows.push(scalarize(r));
    if (view.totals && typeof view.totals === 'object' && !Array.isArray(view.totals)) {
      totalsRow = scalarize(view.totals as Record<string, unknown>);
    }
  } else if (Array.isArray(view.arrivals) || Array.isArray(view.departures)) {
    for (const r of (view.arrivals as Record<string, unknown>[]) ?? []) rows.push({ section: 'arrivals', ...scalarize(r) });
    for (const r of (view.departures as Record<string, unknown>[]) ?? []) rows.push({ section: 'departures', ...scalarize(r) });
  } else {
    rows.push(scalarize(view));
  }

  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }

  if (totalsRow) {
    // Keep only totals that match a data column; drop scalar totals-only keys.
    for (const key of Object.keys(totalsRow)) {
      if (!columns.includes(key)) delete totalsRow[key];
    }
    rows.push(totalsRow);
  }

  return { columns, rows, hasTotalsRow: totalsRow !== null };
}

function scalar(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number') return v;
  return String(v);
}

function escapeCsv(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function renderCsv(columns: string[], rows: FlatRow[]): string {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCsv(String(row[c] ?? ''))).join(','));
  }
  return lines.join('\r\n');
}

function renderXlsx(name: string, columns: string[], rows: FlatRow[], totalsLast: boolean): Promise<Buffer> {
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet(name);
  sheet.addRow(columns);
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true };
  });
  const dataStart = 2;
  rows.forEach((r, i) => {
    const rowNumber = dataStart + i;
    sheet.addRow(columns.map((c) => (r[c] === null ? '' : r[c])));
    if (totalsLast && i === rows.length - 1) {
      sheet.getRow(rowNumber).font = { bold: true };
    }
  });
  return workbook.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

export async function exportReportJob(payload: Record<string, unknown>, ctx: JobContext): Promise<void> {
  const parsed = exportPayloadSchema.parse(payload);
  const name = validateExportName(parsed.name);
  const format = parsed.format;

  let propertyId = parsed.propertyId;
  if (!propertyId) propertyId = await withDb((db) => resolvePropertyId(db, null));
  if (!propertyId) throw new Error('No active property is configured');

  const actor: Actor = {
    id: parsed.requestedBy.id,
    name: parsed.requestedBy.name,
    email: parsed.requestedBy.email,
    role: parsed.requestedBy.role,
    propertyId,
    permissions: new Set(),
  };

  const view = (await RUNNERS[name](parsed.params, actor)) as Record<string, unknown>;
  const { columns, rows, hasTotalsRow } = flattenView(view);

  const body: Uint8Array = format === 'csv'
    ? new TextEncoder().encode(renderCsv(columns, rows))
    : new Uint8Array(await renderXlsx(name, columns, rows, hasTotalsRow));
  const mimeType = format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  const now = new Date();
  const key = `private/report/${name}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${format}`;
  const { sizeBytes } = await getStorage().put(key, body, mimeType);
  const yyyymmdd = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;

  await withTx(async (tx) => {
    const exportBatchId = randomUUID();
    const file = await createFileRecord(tx, {
      propertyId,
      storageKey: key,
      visibility: 'private',
      originalName: `${name}-${yyyymmdd}.${format}`,
      mimeType,
      sizeBytes,
      entityType: 'report',
      entityId: exportBatchId,
      uploadedBy: parsed.requestedBy.id,
    });
    await notify(tx, [{
      userId: parsed.requestedBy.id,
      type: 'report.export_ready',
      title: 'Report export ready',
      body: `${name} (${format}) is ready to download`,
      link: `/v1/reports/exports/${file.id}/url`,
    }]);
    await recordAudit(tx, {
      actor: auditActor(actor),
      propertyId,
      action: 'reports.export',
      entityType: 'report',
      entityId: exportBatchId,
      summary: `Exported ${name} as ${format} (job ${ctx.jobId})`,
    });
  });
}

/** Register the job so the worker (and tests) can process exports. Idempotent. */
export function registerExportJobs(): void {
  registerHandler('export.report', exportReportJob);
}