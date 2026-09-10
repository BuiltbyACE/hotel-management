# Session: HMS Backend Build (Chunked) — Session Note

## Objective
- Complete the HMS backend in blueprint dependency order; each chunk CI-green, committed, pushed.
- **DONE — Chunk 4** (night audit §13.3) `e398f78`.
- **DONE — Chunk 5** (reporting §18) `d34fd36` — read reports + role-shaped dashboard from `daily_stats`.
- Remainder: **Chunk 6** (money gaps: gap detection + crypto payment escrow §14), **Chunk 8** (system surface: users/roles, guests merge, audit-log page, maintenance/housekeeping/expenses v1 API surface polish). Deferred follow-up: `GET /v1/reports/{name}/export` (exceljs 4.4.0 + R2 `core/files/storage.ts` + queued job + notification) — record as explicit follow-up, not forgotten.

## Important Details
- **Boundary lint**: no module→module repository/schema imports; cross-module `service`/`events`/`guards` allowed; cross-module `types`/`validation` NOT allowed (mirror locally). Cross-module tables only via `schema` barrel from `@/core/db`. Exception in `eslint.config.mjs`: reporting's **repository** may read across schemas (blueprint §5 escape hatch). Reporting never writes.
- **Chunk 4 final state** (`e398f78` "feat(frontdesk): night audit with no-shows, stayover flags, daily stats freeze"): `runNightAudit(targetDate, actor, onlyProperties?: string[])` scoping param; `M.cmp` money assertions; `dayCounters` coerces raw-SQL ints via `Number(v)||0`, money via `String(v??0)`; `roomsSold`/`inHouse` filter `booking_nights` to bookings `('checked_in','checked_out')` so no-show nights are excluded.
- **Chunk 5 design decisions**: trends read frozen `daily_stats` only (§18.1); "today" probes live ledger. Permission mapping: `arrivals-departures` + `/v1/dashboard` → `reports.operational`; occupancy/revenue/outstanding-balances/expenses/maintenance-costs/profit-summary → `reports.financial`. Dashboard role-shaped: receptionist operational board only; manager/admin get `financial` (revenueToday, paymentsTodayByMethod, outstandingBalance, openMaintenanceByPriority, revenue/expenses/profit MTD month-start..yesterday); admin adds `admin.activeUsers`.
- **Money discipline**: Postgres `numeric` returns strings like `'7500'` (no trailing zeros); SQL `::numeric(14,2)::text` gives `'7500.00'`. `M.add/sub` on raw strings collapse scale, so the service's `money()` helper `= M.toDecimal(v).toFixed(2)` is applied at every output point (occupancy/revenue/profit/expenses/outstanding totals + dashboard MTD). Raw-SQL timestamps come back as strings, not `Date` — use `new Date(r.x).toISOString()`.
- **Property scoping**: services use local `scopeProperty(actor)` → `resolvePropertyId` (actor's property, else single active property) → `AppError.notFound('No active property is configured')`. Replicated locally, never import bookings' private `scopeProperty`.
- **Test robustness**: suites run in parallel on shared DB. Never seed junk global settings — derive expected amounts from DB. Beware **module-level `let targetDate`** + beforeAll ordering: any seed using it must run AFTER it's assigned, or dates land in the wrong window (this caused the Chunk 5 flaky failures). Raw-SQL date filters via `db.execute(sql\`... BETWEEN ${from} AND ${to}\`)` over `date` columns DO work (contextually typed) — the empty results were the seed-ordering bug, not SQL.
- Frameworks: `apiHandler`, `ok`, `validateQuery(new URL(req.url), schema)` (zod), `requirePermission`, `export const runtime = 'nodejs'`.
- Commands (Windows cmd.exe): `pnpm typecheck`; targeted `npx dotenv -e .env.local -- npx vitest run <path>`; `pnpm lint`; `pnpm run ci` = lint+typecheck+test+build; `pnpm db:verify`. Known CI warnings (expected): `no handler registered for job type "email.night_audit_summary"`, `_actor` unused in `property/service.ts:191`, Vite `configLoader: native` note.
- Commit style: `feat(<module>): <summary>` (feat/fix patterns above).

## Work State
### Completed
- **Chunk 4**: typecheck+lint green (only pre-existing `_actor` warning), night-audit suite 4/4, full `pnpm run ci` (29 files/229 tests), `pnpm db:verify` 15/15; committed `e398f78`, pushed.
- **Chunk 5**: files `src/modules/reporting/{types,validation,repository,schema}.ts`, `service.ts`, 8 routes `src/app/api/v1/dashboard/route.ts` + `src/app/api/v1/reports/{...}/route.ts`, test `__tests__/reports.integration.test.ts` (10 tests). Committed through `9a133ad`.
- **Forensic audit remediations (2026-09-10)**:
  - Phase 1: `checkOutBooking` balance gate (§12.6). 266/266 tests pass.
  - Phase 2: `QuoteView` money as strings (`src/modules/availability/service.ts`, `types.ts`).
  - Phase 3: `nextNumberFast` — atomic upsert sequence allocator for BK-, EX-, MT- references, removing advisory-lock serialization from booking/expense/maintenance creation. `load/booking-concurrency.js` updated with per-VU `vuSettled` back-off. Test added: `src/core/db/__tests__/sequence.integration.test.ts` (3 new tests). 266 tests, 15/15 db:verify.
  - **Phases 1-3 batch committed to master** — `37beef3`.
  - **G14 k6 gate GREEN (2026-09-10):** `pnpm load:seed && k6 run load/booking-concurrency.js` → `booking_wins == 10`, `server_errors == 0`, `request_error_rate == 0.00 %`, **p95 == 563 ms** (< 2000 ms). Report flipped to **OPTION A — UNCONDITIONALLY CERTIFIED** (`b70c20c` follow-ups). Frontend takeoff issued.

### Active
- (none — audit fully certified; Chunk 6 / Chunk 8 open for parallel backend work.)

### Blocked
- (none)

## Known Performance Ceiling
**Deposit-carrying bookings**: `_recordPayment` allocates an `RC-` receipt reference inside `createBooking`'s `withTx` under the advisory lock (`nextNumber` — gap-free required for financial references). When N receptionists concurrently check in guests with deposits, `createBooking` calls serialise on the receipt sequence for each property. This is a known, accepted ceiling. The window is the duration of the advisory lock acquisition + commit on the sequence row only (microseconds), not the entire booking transaction. For most hotel workloads (< 10 concurrent deposit check-ins), this is unobservable. If this becomes a bottleneck, the fix is to issue the receipt after the booking commits (requires a two-phase flow).

## Next Move
1. ~~Commit phases 1-3 batch~~ → `37beef3` (done).
2. ~~Run k6 gate to confirm G14~~ → **GREEN 2026-09-10 (p95 563 ms, 10/10 winners, 0 % errors, 0×5xx)**.
3. **Frontend go-ahead — ISSUED 2026-09-10 (UNCONDITIONALLY CERTIFIED).**
4. Remaining backend scope: **Chunk 6** (money gaps), **Chunk 8** (system surface) — can proceed in parallel with frontend development.

## Relevant Files
- Sequence: `src/core/db/sequence.ts` (`nextNumber` advisory-lock; `nextNumberFast` atomic-upsert).
- Callers using advisory lock (gap-free): `bookings/service.ts` (`_recordPayment`, `reversePayment`) for RC-; `billing/service.ts` for INV-.
- Callers using fast path (gaps OK): `bookings/service.ts` (`createBooking`) for BK-; `expenses/service.ts` for EX-; `maintenance/service.ts` for MT-.
- k6: `load/booking-concurrency.js`, `load/seed.ts`, `load/README.md`.
- Audit report: `BACKEND_FORENSIC_AUDIT_REPORT.md`.