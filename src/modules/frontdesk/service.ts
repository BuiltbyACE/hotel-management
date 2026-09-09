/**
 * modules/frontdesk/service.ts
 *
 * The front desk (blueprint §13.1, §16.3). Home to the today board and the
 * walk-in, which is the booking engine's create + check-in composed behind one
 * front-desk gesture. The module owns no tables: everything here calls into
 * bookings (ledger lists, the booking engine) and property (sellable room
 * count) services, and re-shapes into frontdesk's own views.
 *
 * The walk-in runs as create-then-check-in (two transactions). If check-in is
 * refused (deposit rule, illegal transition) the confirmed booking stands and
 * the front desk resolves it at the register — never a half-written ledger.
 */
import { type Actor } from '@/modules/identity/auth-guard';
import {
  checkInBooking,
  createBooking,
  expectedArrivals,
  expectedDepartures,
  inHouseRooms,
  markBookingNoShow,
} from '@/modules/bookings/service';
import { postUnpostedNightsForDate } from '@/modules/billing/service';
import { recordAudit, notify } from '@/modules/audit/service';
import { withDb, withTx, withAdvisoryLock } from '@/core/db';
import { AppError } from '@/core/api';
import { today } from '@/core/dates';
import { M } from '@/core/money';
import { enqueue as outbox } from '@/core/jobs';
import { eventBus } from '@/core/events';
import { listRoomsForBoard } from '@/modules/property/service';
import {
  dayCounters,
  departingStayovers,
  frozenStatsRow,
  listActivePropertyIds,
  noShowCandidates,
  readNoShowFeeNights,
  reconcileMismatches,
  reconcileRewrite,
  upsertDailyStats,
  type DailyStatsRow,
} from './repository';
import { FRONTDESK_EVENTS } from './events';
import type { DailyStatsView, LedgerRowView, NightAuditActor, NightAuditResultView, TodaySummaryView } from './types';
import type { WalkInInput } from './validation';

function toRows(rows: readonly {
  bookingId: string;
  reference: string;
  status: string;
  guestName: string;
  roomId: string;
  roomNumber: string;
  date: string;
}[]): LedgerRowView[] {
  return rows.map((r) => ({
    bookingId: r.bookingId,
    reference: r.reference,
    status: r.status,
    guestName: r.guestName,
    roomId: r.roomId,
    roomNumber: r.roomNumber,
    date: r.date,
  }));
}

/** Rooms expected to check in on `date`. */
export async function arrivalsOn(date: string, actor: Actor): Promise<LedgerRowView[]> {
  return toRows(await expectedArrivals(date, actor));
}

/** Rooms due out on `date` (still in-house or already checked out today). */
export async function departuresOn(date: string, actor: Actor): Promise<LedgerRowView[]> {
  return toRows(await expectedDepartures(date, actor));
}

/** Rooms occupied right now. */
export async function inHouseOn(actor: Actor): Promise<LedgerRowView[]> {
  return toRows(await inHouseRooms(actor));
}

/** The at-a-glance today board: arrivals, departures, in-house, occupancy. */
export async function getTodaySummary(date: string, actor: Actor): Promise<TodaySummaryView> {
  const [arrivals, departures, inHouse, rooms] = await Promise.all([
    arrivalsOn(date, actor),
    departuresOn(date, actor),
    inHouseOn(actor),
    listRoomsForBoard(actor),
  ]);
  const roomsTotal = rooms.length;
  const roomsOccupied = inHouse.length;
  return {
    date,
    roomsTotal,
    roomsOccupied,
    roomsVacant: roomsTotal - roomsOccupied,
    occupancyPct: roomsTotal > 0 ? Math.round((roomsOccupied / roomsTotal) * 100) : 0,
    arrivals,
    departures,
    inHouse,
  };
}

/** Guest + booking + check-in behind one front-desk gesture (§16.3). */
export async function walkIn(input: WalkInInput, actor: Actor): Promise<Awaited<ReturnType<typeof checkInBooking>>> {
  const booking = await createBooking(
    {
      guest: {
        fullName: input.guest.fullName,
        phone: input.guest.phone ?? undefined,
        email: input.guest.email ?? undefined,
        idType: input.guest.idType ?? undefined,
        idNumber: input.guest.idNumber,
      },
      source: 'walk_in',
      rooms: input.rooms.map((r) => ({
        roomId: r.roomId,
        arrival: r.arrival,
        departure: r.departure,
        adults: r.adults,
        children: r.children,
        overrideRate: r.overrideRate,
      })),
      specialRequests: input.specialRequests ?? undefined,
      internalNotes: input.internalNotes ?? undefined,
      payment: input.payment ?? null,
    },
    actor,
  );
  return checkInBooking(booking.id, actor, input.overrideDepositReason ?? null);
}

// ─── Night audit (§13.3) ─────────────────────────────────────────────────────

/**
 * Run the night audit for `targetDate` (defaults to yesterday). By default
 * every active property is audited; pass `onlyProperties` to scope a single
 * pass (per-property tests, backfill for one site). One transaction per
 * property, serialised by an advisory lock so manual runs and the cron can
 * never double-post. Freezes the day's stats into `daily_stats` and notifies
 * the management role.
 */
export async function runNightAudit(
  targetDate: string,
  actor: NightAuditActor,
  onlyProperties?: string[],
): Promise<NightAuditResultView[]> {
  if (targetDate > today()) {
    throw AppError.badRequest('VALIDATION_ERROR', 'Night audit cannot run for a future date');
  }
  const propertyIds = onlyProperties ?? (await withDb((db) => listActivePropertyIds(db)));
  if (propertyIds.length === 0) return [];

  const results: NightAuditResultView[] = [];
  for (const propertyId of propertyIds) {
    const result = await withTx(async (tx) =>
      withAdvisoryLock(tx, `night-audit:${propertyId}`, async () => {
        const feeNights = await readNoShowFeeNights(tx);

        // 1. No-shows: confirmed arrivals due on/before the target that never checked in.
        const noShowReferences: string[] = [];
        for (const candidate of await noShowCandidates(tx, propertyId, targetDate)) {
          const out = await markBookingNoShow(tx, candidate.bookingId, { propertyId, businessDate: targetDate, feeNights, audit: actor });
          if (out.marked) noShowReferences.push(out.reference);
        }

        // 2. Stay-overs: in-house bookings that were due out — manager review, never auto-closed.
        const stayovers = await departingStayovers(tx, propertyId, targetDate);
        if (stayovers.length > 0) {
          await notify(tx, [{
            role: 'manager',
            type: 'night.audit_stayover',
            title: `Stay-over guests due out · ${targetDate}`,
            body: `${stayovers.length} in-house booking(s) should have departed by ${targetDate}: ${stayovers.map((s) => s.reference).join(', ')}.`,
            link: '/frontdesk',
          }]);
        }

        // 3. Post the nightly room revenue (stay date = target).
        const posted = await postUnpostedNightsForDate(tx, { propertyId, stayDate: targetDate, postedBy: actor.id });

        // 4. Reconcile header vs ledger; alert only on a real divergence.
        const mismatches = await reconcileMismatches(tx, propertyId);
        if (mismatches.length > 0) {
          await notify(tx, [{
            role: 'manager',
            type: 'night.audit_reconcile',
            title: `Ledger mismatch found · ${targetDate}`,
            body: `${mismatches.length} booking(s) diverge from their ledger: ${mismatches.map((m) => m.reference).join(', ')}.`,
            link: '/finance',
          }]);
        }
        await reconcileRewrite(tx, propertyId);

        // 5. Freeze the day and tell the managers.
        const counters = await dayCounters(tx, propertyId, targetDate);
        const stats = deriveDailyStats({ propertyId, businessDate: targetDate, ...counters });
        await upsertDailyStats(tx, stats);
        const [frozen] = await frozenStatsRow(tx, propertyId, targetDate);
        await notify(tx, [{
          role: 'manager',
          type: 'night.audit_completed',
          title: `Night audit completed · ${targetDate}`,
          body: `${posted.nights} night(s) posted · ${noShowReferences.length} no-show(s) · ${M.format(posted.totalRevenue)} revenue.`,
          link: '/reports',
        }]);
        await outbox(tx, [{
          jobType: 'email.night_audit_summary',
          payload: { propertyId, targetDate },
          propertyId,
          dedupeKey: `nightaudit:summary:${propertyId}:${targetDate}`,
        }]);
        await recordAudit(tx, {
          actor,
          propertyId,
          action: 'frontdesk.night_audit',
          entityType: 'property',
          entityId: propertyId,
          summary: `Night audit for ${targetDate}: ${posted.nights} nights posted, ${noShowReferences.length} no-show(s), ${M.format(posted.totalRevenue)} revenue`,
        });
        await eventBus.emit(FRONTDESK_EVENTS.nightAuditCompleted, {
          propertyId,
          targetDate,
          nightsPosted: posted.nights,
          by: actor.name,
        });

        return {
          propertyId,
          targetDate,
          noShowsMarked: noShowReferences.length,
          noShowReferences,
          stayoversFlagged: stayovers.map((s) => s.reference),
          nightsPosted: posted.nights,
          roomRevenue: posted.roomRevenue,
          totalRevenue: posted.totalRevenue,
          reconcileMismatchCount: mismatches.length,
          stats: toDailyStatsView(stats, frozen?.computedAt),
        } satisfies NightAuditResultView;
      }),
    );
    results.push(result);
  }
  return results;
}

/** ADR/RevPAR/occupancy derive from the day's counters; money stays Decimal. */
function deriveDailyStats(c: Omit<DailyStatsRow, 'adr' | 'revpar' | 'occupancyPct'>): DailyStatsRow {
  const sold = c.roomsSold;
  const sellable = c.roomsSellable;
  const occupancyPct = sellable > 0 ? M.toDecimal(M.of(sold)).dividedBy(sellable).mul(100).toFixed(2) : '0.00';
  const adr = sold > 0 ? M.toDecimal(M.of(c.roomRevenue)).dividedBy(sold).toFixed(2) : '0.00';
  const revpar = sellable > 0 ? M.toDecimal(M.of(c.totalRevenue)).dividedBy(sellable).toFixed(2) : '0.00';
  return { ...c, occupancyPct, adr, revpar };
}

function toDailyStatsView(s: DailyStatsRow, computedAt?: Date): DailyStatsView {
  return { ...s, computedAt: computedAt ? computedAt.toISOString() : new Date().toISOString() };
}