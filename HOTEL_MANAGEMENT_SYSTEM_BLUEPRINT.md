# Hotel Management System — Master Engineering Blueprint

**Version:** 1.0 (build charter)
**Date:** 2026-09-07
**Inputs:** `Hotel Management System Documentation` (functional spec, 21 sections) + `ERP Architecture Forensic Report` (SafariStack Jenga ERP / retail-smart-erp)
**Deployment model:** Single hotel, single tenant, single deploy
**Status:** Approved for build. This document is the source of truth. If code and this document disagree, one of them is a bug — decide which, then fix it and amend here.

---

## 0. How to read this document

This is not a proposal. It is a build charter. It is written so that a developer (or an AI agent) can open it at section 6 and start writing migrations without asking a single clarifying question.

| Part | Sections | Read it when |
|---|---|---|
| **I — Decisions** | 1–4 | Before you write any code. Ever. |
| **II — Foundation** | 5–9 | Setting up the repo, DB, auth |
| **III — The domain** | 10–14 | Building booking, front desk, money |
| **IV — Surfaces** | 15–18 | Building the API and the UI |
| **V — Cross-cutting** | 19–23 | Security, observability, testing, performance |
| **VI — Delivery** | 24–27 | Planning, shipping, operating |
| **VII — Reference** | Appendices A–G | Daily lookup |

**Conventions used below**
- **MUST / MUST NOT** — non-negotiable. A PR violating one is rejected.
- **SHOULD** — default; deviation requires a one-line note in the PR.
- **[P2]** — deliberately deferred past MVP. Schema is designed to accept it; code is not written now.
- **[ERP-DNA]** — a pattern copied deliberately from the ERP because it was proven there.
- **[ERP-FIX]** — a place where the ERP was measurably wrong and we are doing the opposite.

---

# PART I — DECISIONS

## 1. The verdict in one page

The ERP scored **6.4/10** overall in its own forensic audit. It scored **9.5/10** on multi-tenancy, **7.5** on security and deployment, and **5.0** on performance and scalability. That split is the entire story:

> **The ERP's foundations were excellent. Its organisation was not.**

The reason that project "worked out so, so well" was not luck and it was not the framework. It was four specific things, and we are keeping all four:

1. **The database enforced correctness**, not the application code.
2. **A single, identical pipeline on every write path**: auth → permission → validate → scope → transact → broadcast.
3. **Real row-level concurrency control** (`FOR UPDATE`, advisory locks, explicit transactions) instead of hoping.
4. **One deployable app.** No Nx, no Module Federation, no microservices, no service bus.

And it slowed down for four equally specific reasons, all of which we are eliminating on day one:

1. **1,400-line route handlers** that mixed eight bounded contexts in one function.
2. **Money stored as `text`**, parsed with `parseFloat` in application code.
3. **Side effects inside the write transaction** (email, GL posting, AI anomaly checks, audit).
4. **RLS retrofitted across 8+ "fix" migrations** instead of designed in from migration 0001.

### 1.1 Our structural advantage

The ERP carried the full weight of multi-tenancy: ~217 tables, ~150 with forced RLS policies, dual connection pools, a `tenant_id` on every row, subdomain routing, per-tenant permission overrides, cross-tenant admin surfaces, tenant billing, tenant provisioning and teardown.

**We are building for one hotel.** That deletes an entire architectural layer — roughly 25–30% of the ERP's total complexity — and it deletes it from *every* table, *every* query, *every* test and *every* migration.

We are spending exactly **one** of those saved units of complexity on a `property_id` column (§6.3), which buys us multi-branch support later for almost nothing. The other 95% of the saving goes straight into speed, and into the parts of a hotel system that actually earn money: the availability grid, the booking engine, the folio, and the reports.

### 1.2 What makes this product worth real money

A hotel PMS is not a CRUD app. Four things separate a $500 system from a $500,000 one, and all four are in scope:

| Differentiator | Why it's worth money | Section |
|---|---|---|
| **Provable zero double-bookings** | The one failure mode a hotelier will never forgive. We make it *physically impossible at the database level*, not "handled in the code". | §11 |
| **The tape chart** (rooms × dates grid, drag to book) | This is the screen front-desk staff live in. Systems without it lose demos in 30 seconds. | §17.4 |
| **A correct night audit** | Occupancy %, ADR and RevPAR that reconcile to the cent, every night, automatically. This is what a manager buys. | §13 |
| **Money that always balances** | Folio → payments → invoice → reports, all `NUMERIC`, all reconciled, all audited. | §12 |

---

## 2. The 22 binding decisions

Every one of these is settled. Do not reopen them mid-build.

| # | Decision | Rationale | Tag |
|---|---|---|---|
| D1 | **One Next.js 16 App Router application.** One repo, one build, one deploy. | ERP proved a single app serves five distinct surfaces fine. Nx/Module Federation would add weeks and buy nothing. | [ERP-DNA] |
| D2 | **PostgreSQL 18 is the source of truth.** Every invariant that matters is a DB constraint. | The ERP's tenancy scored 9.5 precisely because the DB, not the code, enforced it. | [ERP-DNA] |
| D3 | **Single-tenant. No `tenant_id`. No RLS policies.** | One client. Deleting this layer is our single biggest speed advantage. | [ERP-FIX] |
| D4 | **Keep the least-privilege DB roles anyway.** App connects as a non-superuser `hms_app`; migrations use `hms_migrator`. | Costs 10 minutes, keeps the ERP's fail-closed posture. | [ERP-DNA] |
| D5 | **`property_id` on all operational tables from migration 0001**, seeded with one property. | Multi-branch is an explicit future requirement (spec §20). Retrofitting a scope column later is exactly the "8 fix_rls migrations" mistake. | [ERP-FIX] |
| D6 | **Money is `NUMERIC(14,2)`.** Never `text`, never `float`. All aggregation in SQL. | The ERP's #1 long-term correctness risk. | [ERP-FIX] |
| D7 | **Double-booking is prevented by a Postgres exclusion constraint**, plus row locks, plus idempotency keys. Three independent layers. | Application-level checking always loses a race eventually. | [ERP-FIX] |
| D8 | **All room occupancy lives in one ledger table** (`room_allocations`) covering both reservations and maintenance blocks. | Two tables cannot share one overlap constraint. One table can. | new |
| D9 | **Explicit service layer.** Route handlers MUST be under 80 lines and MUST contain no business logic. | The ERP's `sales/route.ts` was ~1,400 lines. This is the single most expensive mistake to repeat. | [ERP-FIX] |
| D10 | **Side effects go to an outbox, never into the write transaction.** | Emails/PDFs/notifications must never extend a booking lock. | [ERP-FIX] |
| D11 | **No Redis, no BullMQ for MVP.** Job queue is a Postgres table with `FOR UPDATE SKIP LOCKED`. | One hotel does not generate queue pressure. Redis is a Phase 3 swap behind one interface. | [ERP-FIX] |
| D12 | **Better Auth**, not NextAuth/Auth.js. | Auth.js is in maintenance mode and v5 never left beta after ~3 years. Better Auth gives DB sessions, 2FA and RBAC primitives out of the box. See §3.2. | [ERP-FIX] |
| D13 | **Argon2id** password hashing, not bcrypt. | The ERP's own audit recommended it. New build, no migration cost. | [ERP-FIX] |
| D14 | **Zod v4 validation on every mutation**, enforced by a custom ESLint rule that bans raw `request.json()`. | The ERP's best process invention. Copy it verbatim. | [ERP-DNA] |
| D15 | **Server-side permission checks are the only authorization.** UI permission checks are cosmetic. | Non-negotiable. | [ERP-DNA] |
| D16 | **Versioned API from day one:** `/api/v1/*`. RFC 9457 problem-details errors. Idempotency keys on all mutations. | The ERP had none of these and its own audit flagged all three. | [ERP-FIX] |
| D17 | **TanStack Query for all server state.** No ad-hoc `fetch` + `setInterval` polling. | The ERP had 15s polling with no cache invalidation model. | [ERP-FIX] |
| D18 | **Real-time via SSE + Postgres `LISTEN/NOTIFY`.** No WebSocket server for MVP. | One-way updates (room board, arrivals) are all we need; SSE survives proxies and needs no custom server. The ERP built `pg_notify` triggers and never wired them. | [ERP-FIX] |
| D19 | **Private-by-default object storage** with signed URLs. Public bucket only for room photos. | Guest ID scans on a public CDN URL is a data-protection incident waiting to happen. | [ERP-FIX] |
| D20 | **Business dates are `DATE` in the hotel's timezone. Instants are `timestamptz`.** Never mix them. | Booking a room "on the 14th" is a calendar fact, not an instant. Getting this wrong is the #2 source of PMS bugs after double-booking. | new |
| D21 | **A nightly night-audit job is a core feature, not an add-on.** | Occupancy/ADR/RevPAR must be computed and frozen daily, not derived ad hoc from live tables. | new |
| D22 | **Vitest, not Jest.** Playwright and k6 stay. | Faster, native ESM/TS. Playwright + k6 were the ERP's genuinely best-in-class assets. | [ERP-DNA] / [ERP-FIX] |

---

## 3. Verified technology stack (as of 2026-09-07)

Your ERP stack table was audited against live package registries today. **Three entries are materially out of date and one has a critical status change.** Everything else stands.

### 3.1 Deltas from the ERP table

| Item | ERP table said | Reality on 2026-09-07 | Action |
|---|---|---|---|
| **next-auth** | `^5.0.0-beta.32` "Reuse, but pin stable" | **There is no stable.** Auth.js v5 is *still* beta after ~3 years; the project was absorbed by the Better Auth team and is now in maintenance mode (security patches only). Its own maintainers recommend Better Auth for new projects. | **Replace with Better Auth 1.7.x** |
| **PostgreSQL** | `16` | **18.6 is current** (17.11 / 16.15 also supported). PG18 adds `uuidv7()`, temporal constraints and a new async I/O subsystem. | **Upgrade to 18** |
| **Middleware file** | `src/middleware.ts` | **Next.js 16 renamed `middleware.ts` → `proxy.ts`.** | Use `proxy.ts` |
| **Drizzle ORM** | `^0.45.2` | `0.45.2` is still the latest *stable*; `1.0.0-rc.x` is in flight and contains breaking changes (casing API rework). | **Pin `0.45.x`.** Do not adopt 1.0 mid-build. |
| **Jest** | Reuse | Works, but slow and awkward with ESM/TS. | **Vitest** |
| **bcryptjs** | Reuse (argon2 preferred) | Preference is correct. | **Argon2id** |
| **PayHere** | "Avoid — too niche" | Correct, and irrelevant here. | **M-Pesa Daraja + cash. No card gateway in MVP.** |
| **three / @react-three/fiber** | "Avoid for hotel MVP" | Correct. | **Delete entirely** |
| **Redis / BullMQ** | "ADD for hotel" | Correct *for multi-tenant SaaS at scale*. Wrong for one hotel. | **Defer to P2.** Postgres job queue instead. |

> **Note on Node.js 16 vs 18 for Postgres:** PG18's `uuidv7()` gives time-ordered UUIDs, which index far better than random v4 under insert load, and PG18 also adds temporal (`WITHOUT OVERLAPS`) constraints. We use `uuidv7()` for primary keys. If your host only offers PG16/17, everything in this document still works — substitute `gen_random_uuid()` and keep the `EXCLUDE` constraint (which has existed since PG 9.x). **Nothing in this design requires PG18.** It just gets better with it.

### 3.2 Why Better Auth instead of the ERP's NextAuth

This is the one place we deliberately break DNA continuity, so the reasoning is spelled out:

| Concern | NextAuth v5 (ERP) | Better Auth |
|---|---|---|
| Release status | Perpetual beta; maintenance mode | Stable v1, actively developed |
| Session revocation | JWT — the ERP had to revalidate the user on *every single request* to compensate | Real DB sessions; revoke instantly |
| 2FA | Not built in (the ERP audit lists MFA as **MISSING**) | First-party plugin |
| RBAC | Hand-rolled (446 lines in `roles.ts`) | `access` plugin with typed statements |
| Drizzle | Community adapter | First-party adapter |
| Admin ops (impersonate, ban, list users) | Hand-rolled | `admin` plugin |

We still hand-roll the **permission matrix** (§9.3) because our roles are domain-specific and a static, testable, importable object was one of the ERP's genuinely good ideas. Better Auth handles *identity*; our code handles *authority*.

### 3.3 The final stack

| Layer | Choice | Pin | Notes |
|---|---|---|---|
| Runtime | Node.js | `24.x` (Active LTS to 2028-05) | Not 25/26 (Current line) |
| Package manager | pnpm | `10.x` | Faster CI, strict node_modules |
| Framework | Next.js App Router | `16.3.x` | `proxy.ts`, not `middleware.ts` |
| UI | React | `19.2.x` | Server Components first |
| Language | TypeScript | `5.x`, `strict: true`, `noUncheckedIndexedAccess: true` | |
| Database | PostgreSQL | `18.x` (16/17 acceptable) | Extensions: `btree_gist`, `pg_trgm`, `pgcrypto` |
| ORM | Drizzle ORM | `0.45.x` **exact minor** | + `drizzle-kit 0.31.x` |
| DB driver | `pg` | `8.17.x` | Pool max 20 |
| Auth | Better Auth | `1.7.x` | + `admin`, `twoFactor` plugins |
| Hashing | `@node-rs/argon2` | latest | Argon2id, Node runtime only |
| Validation | Zod | `4.x` | + `drizzle-zod` |
| Server state | TanStack Query | `5.x` | **new vs ERP** |
| Forms | react-hook-form + `@hookform/resolvers` | `7.x` | Same Zod schema as the API |
| Styling | Tailwind CSS | `4.x` | |
| Components | shadcn/ui (vendored) | — | Own the source, as the ERP did |
| Tables | TanStack Table | `8.x` | Bookings/guests/expenses grids |
| Charts | Recharts | `2.x` | Dashboards only |
| Dates | `date-fns` + `@date-fns/tz` | `4.x` | Africa/Nairobi business dates |
| Money | `decimal.js-light` | `2.x` | Only where SQL can't do the math |
| Files | Cloudflare R2 via `@aws-sdk/client-s3` | `3.x` | **Private buckets + signed URLs** |
| Email | Resend | `6.x` | Booking confirmations, receipts |
| SMS/Payments | M-Pesa Daraja (STK Push) | — | **[P2]** — manual reference capture in MVP |
| PDF | `@react-pdf/renderer` | `4.x` | Invoices/receipts, no headless browser |
| Excel | `exceljs` | `4.x` | Report exports |
| Errors | `@sentry/nextjs` | `10.x` | |
| Unit/integration tests | Vitest | `3.x` | |
| E2E | Playwright | `1.5x` | Multi-project, as the ERP did |
| Load/concurrency | k6 | `1.x` | **The double-booking test is mandatory** |
| Lint | ESLint 9 flat config + custom rules | — | See §19.1 |
| Deploy | Railway (or Docker on a VPS) | — | Single web service + managed PG |
| Cache | *none* | — | **[P2]** Redis behind `core/cache` interface |
| Queue | Postgres `job_queue` + `SKIP LOCKED` | — | **[P2]** BullMQ behind `core/jobs` interface |

**Explicitly removed from the ERP stack:** `three`, `@react-three/fiber`, PayHere, `@google/generative-ai`, DeepSeek, Artillery (k6 is enough), `zustand` (TanStack Query + React state covers us; add it back only if a genuine cross-tree client store appears).

---

## 4. The ERP DNA transfer table

Read this as the contract between the two systems. Left = what worked. Right = what we build.

| ERP asset | Score | Verdict | How it appears here |
|---|---|---|---|
| RLS + `app.tenant_id` + dual roles + `withTenant()` | 9.5 | **Adapt** | Single-tenant, so no RLS. But we keep the *shape*: least-privilege `hms_app` role, and a `withTx()` wrapper as the only sanctioned DB entry point (§8) |
| Route pipeline: auth → permission → validate → scope → mutate → broadcast | strong | **Copy verbatim** | §16.2 — identical order, enforced by lint |
| `FOR UPDATE` + advisory locks + explicit transactions | strong | **Copy + strengthen** | §11 — plus an exclusion constraint the ERP never had |
| UUID PKs + partial unique indexes | strong | **Copy** | §6.2, upgraded to `uuidv7()` |
| Static permission matrix, server-enforced | strong | **Copy** | §9.3 |
| Zod + enforced `validateBody()` ESLint rule | strong | **Copy verbatim** | §16.4, §19.1 |
| DB-backed rate limiting | strong | **Copy** | §20.4 — survives restarts without Redis |
| Playwright multi-project E2E | strong | **Copy** | §22.3 |
| k6 load tests | strong | **Copy + extend** | §22.4 — new: concurrency test for double-booking |
| R2 + namespaced keys + thumbnails + quota | good | **Copy + fix** | §14 — private by default |
| Denormalized immutable document snapshots | good | **Copy** | Invoices freeze guest/room/rate at issue time (§12.5) |
| Single Next.js app, no MFE | correct | **Copy the restraint** | D1 |
| SSE + WebSocket with auth, limits, heartbeat | good | **Simplify** | SSE only (D18) |
| — | — | — | — |
| Fat 1,400-line route handlers | weak | **Reject** | D9 + a 80-line lint ceiling |
| Money as `text` | weak | **Reject** | D6 |
| Inline side effects (email, GL, AI) in the write txn | weak | **Reject** | D10 |
| Unscoped `db` export that bypasses RLS | **critical** | **Reject** | §8.1 — the pool is not exported at all |
| `DATABASE_URL_ADMIN || DATABASE_URL` fallback | high | **Reject** | Fail closed. Boot aborts on missing config (§8.4) |
| Public CDN reads for private documents | high | **Reject** | D19 |
| Retrofit RLS across 8 fix migrations | weak | **Reject** | Constraints designed in migration 0001 |
| No API versioning / no idempotency / ad-hoc errors | weak | **Reject** | D16 |
| No metrics, no correlation IDs | weak | **Reject** | §21 |
| Backend unit test coverage ≈ 2 files | weak | **Reject** | §22.2 — booking engine has mandatory gold-standard tests |
| PayHere MD5 webhooks | weak | **Reject** | M-Pesa Daraja with proper validation |
| 3D showroom, demo/prod coupling, dead `(dashboard)/` shell | noise | **Reject** | Never created |

---

# PART II — FOUNDATION

## 5. Repository structure

One package. One build. Bounded contexts are folders **with enforced import rules** (§19.1) — the ERP's fatal flaw was folders with no enforcement.

```
hotel-management-system/
├── src/
│   ├── proxy.ts                     # Next 16 (was middleware.ts): security headers, auth gate
│   ├── app/
│   │   ├── (auth)/                  # login, forgot-password, reset-password
│   │   ├── (app)/                   # authenticated shell: sidebar + topbar
│   │   │   ├── dashboard/
│   │   │   ├── front-desk/          # today board: arrivals, departures, in-house
│   │   │   ├── availability/        # THE TAPE CHART (rooms x dates)
│   │   │   ├── bookings/
│   │   │   ├── guests/
│   │   │   ├── rooms/               # rooms, room types, rates
│   │   │   ├── housekeeping/
│   │   │   ├── maintenance/
│   │   │   ├── expenses/
│   │   │   ├── finance/             # payments, invoices, receipts
│   │   │   ├── reports/
│   │   │   └── settings/            # hotel, users, categories, audit log
│   │   └── api/
│   │       ├── auth/[...all]/       # Better Auth handler
│   │       └── v1/                  # every business endpoint (§16)
│   │
│   ├── modules/                     # ── BOUNDED CONTEXTS ──
│   │   ├── identity/                # users, roles, permissions, sessions
│   │   ├── property/                # property, room-types, rooms, rates, amenities
│   │   ├── guests/                  # guest profiles, documents, dedupe
│   │   ├── availability/            # the allocation ledger, search, calendar
│   │   ├── bookings/                # reservation lifecycle  ← CORE
│   │   ├── frontdesk/               # check-in, check-out, room moves, night audit
│   │   ├── billing/                 # folio, payments, invoices, receipts
│   │   ├── housekeeping/            # room status board
│   │   ├── maintenance/             # issues, updates, assignment
│   │   ├── expenses/                # categories, expenses, approval
│   │   ├── reporting/               # read models, daily stats, exports
│   │   └── audit/                   # activity log writer + reader
│   │
│   │   # Each module is EXACTLY this shape:
│   │   #   <module>/
│   │   #     schema.ts        Drizzle tables for tables THIS module owns
│   │   #     types.ts         domain types, enums, state machines
│   │   #     validation.ts    Zod schemas (request + domain)
│   │   #     repository.ts    all SQL for this module. Nothing else touches its tables.
│   │   #     service.ts       use-cases. The ONLY place business rules live.
│   │   #     events.ts        event names + payload types this module emits
│   │   #     __tests__/       unit + integration tests
│   │
│   ├── core/                        # ── CROSS-CUTTING INFRASTRUCTURE ──
│   │   ├── db/                      # pool, withTx, schema barrel, error mapping
│   │   ├── auth/                    # Better Auth config, session helpers, requirePermission
│   │   ├── api/                     # handler wrapper, problem-details, pagination, idempotency
│   │   ├── jobs/                    # outbox writer, worker loop, job handlers
│   │   ├── events/                  # typed event bus (in-proc dispatch → outbox)
│   │   ├── realtime/                # SSE hub + LISTEN/NOTIFY bridge
│   │   ├── files/                   # R2 client, signed URLs, thumbnails
│   │   ├── mail/                    # Resend templates
│   │   ├── money/                   # Money type, rounding, tax math
│   │   ├── dates/                   # business date, night ranges, timezone
│   │   ├── config/                  # env parsing (Zod), fail-closed boot
│   │   ├── logger/                  # structured JSON + correlation id
│   │   └── cache/                   # in-process memo now; Redis later [P2]
│   │
│   ├── components/
│   │   ├── ui/                      # shadcn primitives (vendored, owned)
│   │   ├── layout/                  # shell, sidebar, topbar, breadcrumbs
│   │   ├── data/                    # DataTable, Pagination, EmptyState, Filters
│   │   ├── booking/                 # TapeChart, AvailabilitySearch, BookingWizard
│   │   ├── frontdesk/               # ArrivalsList, DeparturesList, RoomStatusBoard
│   │   └── finance/                 # FolioTable, PaymentDialog, InvoicePreview
│   │
│   ├── hooks/                       # useSession, usePermission, useRealtime, query hooks
│   └── lib/                         # tiny pure helpers only. NO business logic. NO db.
│
├── drizzle/                         # numbered SQL migrations + seeds
├── e2e/                             # Playwright: smoke, critical, workflows
├── load/                            # k6: booking-concurrency.js, api-baseline.js
├── scripts/                         # create-admin, seed-demo, night-audit-manual, backup
├── docs/                            # this file + ADRs + runbooks
├── eslint.config.mjs                # includes custom architecture rules
├── drizzle.config.ts
├── vitest.config.ts
├── playwright.config.ts
└── package.json
```

### 5.1 Module import rules (enforced by ESLint, not by hope)

```
app/api/v1/**      →  may import: modules/*/service, modules/*/validation, core/*
modules/X/service  →  may import: modules/X/*, core/*, and OTHER MODULES' service.ts only
modules/X/repository → may import: modules/X/schema, core/db, core/money, core/dates
components/**      →  may import: components/*, hooks/*, lib/*   (NEVER modules/*/repository, NEVER core/db)
lib/**             →  may import: nothing but node/std + other lib
```

**MUST NOT:** import another module's `repository.ts` or `schema.ts`. If module A needs module B's data, it calls B's service. This one rule is what prevents the ERP's `sales/route.ts` — a file that imported ten domains and became unmaintainable.

**Escape hatch:** cross-module reads that are genuinely just joins (e.g. a booking list showing guest names) go in `modules/reporting/repository.ts`, which is the *one* module explicitly allowed to read across schemas. Reporting reads. It never writes.

---

## 6. Database design

### 6.1 The twelve schema commandments

1. **Every invariant that would ruin a hotelier's day is a DB constraint**, not a code check.
2. Primary keys are `uuid` defaulting to `uuidv7()` (PG18) or `gen_random_uuid()` (PG16/17).
3. **Money is `NUMERIC(14,2)`.** Never `text`. Never `float`. Never "minor units in an integer" — Postgres does exact decimal arithmetic natively and `SUM()` must work.
4. **Currency is stored once**, in `settings`. Money columns carry no currency column in MVP (single hotel, single currency); the column is added when multi-currency is.
5. **Calendar facts are `date`. Instants are `timestamptz`.** `check_in_date` is a `date`. `checked_in_at` is a `timestamptz`. Both exist and they mean different things.
6. Every table has `created_at timestamptz NOT NULL DEFAULT now()` and `updated_at timestamptz NOT NULL DEFAULT now()`, with `updated_at` maintained by **a trigger**, never by application code. [ERP-FIX]
7. Every table that participates in operations has `property_id uuid NOT NULL REFERENCES properties(id)`.
8. **Soft delete is uniform**: `deleted_at timestamptz` on entities a user can "delete" (guests, rooms, room types, expense categories). Financial records (payments, invoices, folio charges) are **never** deleted — they are voided/reversed.
9. Enums are Postgres `ENUM` types, mirrored in Drizzle and in TypeScript from a single source.
10. Every foreign key has an index. Every date range column pair used in lookups has a GiST index.
11. Uniqueness that should be per-property is a **partial unique index scoped by `property_id`**, matching the ERP's best schema pattern. [ERP-DNA]
12. No table is created without its constraints in the *same* migration. There will be no `fix_constraints_0043.sql`. [ERP-FIX]

### 6.2 Extensions and global objects

```sql
-- 0000_extensions.sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid() fallback
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- REQUIRED: uuid equality inside a GiST exclusion
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- fuzzy guest name search

-- Universal updated_at trigger (applied to every table)
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- PG18: use uuidv7() for time-ordered keys. PG16/17: use gen_random_uuid().
-- Define once so migrations stay portable:
CREATE OR REPLACE FUNCTION new_id() RETURNS uuid AS $$
  SELECT uuidv7();      -- PG16/17: SELECT gen_random_uuid();
$$ LANGUAGE sql VOLATILE;
```

### 6.3 The `property_id` decision, justified

Multi-branch support is listed in the functional spec (§20, Future Enhancements). Three options were considered:

| Option | Cost now | Cost to add multi-branch later |
|---|---|---|
| No property concept | 0 | Rewrite every table, every query, every test — the ERP's retrofit-RLS disaster |
| `property_id` everywhere, one seeded row | ~1 column + 1 FK per operational table, one helper | Add rows, add a property switcher, add scope to auth. Days, not months. |
| Full multi-tenant RLS | Weeks | 0 |

**We choose option 2.** In MVP, `property_id` is resolved once at boot from `settings.default_property_id` and injected by `core/db`; developers rarely type it.

### 6.4 Enumerated types

```sql
CREATE TYPE user_role            AS ENUM ('admin','manager','receptionist');
CREATE TYPE user_status          AS ENUM ('active','suspended','disabled');

-- PHYSICAL condition of a room. NOT its reservation state.
CREATE TYPE room_condition       AS ENUM ('available','occupied','cleaning','maintenance','out_of_order');
CREATE TYPE housekeeping_status  AS ENUM ('clean','dirty','inspected','out_of_service');

CREATE TYPE booking_status       AS ENUM ('draft','confirmed','checked_in','checked_out','cancelled','no_show');
CREATE TYPE booking_source       AS ENUM ('walk_in','phone','email','front_desk','online','ota','corporate');

CREATE TYPE allocation_kind      AS ENUM ('reservation','block');
CREATE TYPE allocation_status    AS ENUM ('held','confirmed','checked_in','checked_out','blocked','released');

CREATE TYPE charge_type          AS ENUM ('room','tax','levy','extra','service','discount','adjustment');
CREATE TYPE payment_type         AS ENUM ('payment','deposit','refund');
CREATE TYPE payment_method       AS ENUM ('cash','mpesa','card','bank_transfer','cheque','other');
CREATE TYPE payment_status       AS ENUM ('pending','completed','failed','reversed');
CREATE TYPE invoice_status       AS ENUM ('draft','issued','partially_paid','paid','void');

CREATE TYPE maintenance_priority AS ENUM ('low','medium','high','urgent');
CREATE TYPE maintenance_status   AS ENUM ('reported','pending','in_progress','resolved','closed');

CREATE TYPE expense_status       AS ENUM ('recorded','approved','rejected');
CREATE TYPE id_document_type     AS ENUM ('national_id','passport','driving_licence','military','other');
CREATE TYPE job_status           AS ENUM ('pending','processing','completed','failed','dead');
CREATE TYPE file_visibility      AS ENUM ('public','private');
```

> **Critical modelling decision — "Reserved" is not a room status.**
> The functional spec lists room statuses as *Available, Reserved, Occupied, Cleaning, Maintenance*. Storing "Reserved" on the room row is a trap: a room is only reserved *relative to a date range*, and a stored flag drifts out of sync the moment a booking is cancelled, moved or its dates change.
>
> **We store the room's physical condition** (`room_condition`) and **derive** "Reserved / Arriving / Departing / Stayover" from the allocation ledger for whatever date the user is looking at. The UI shows all five (and more) statuses exactly as the spec requires. The database never lies. This is the same lesson as the ERP's "the DB is the source of truth, not a cached flag".

### 6.5 Full schema

Presented as SQL because SQL is unambiguous; the Drizzle definitions mirror it 1:1 in each module's `schema.ts`.

> **Migration ordering.** The tables below are grouped by domain for readability, not by dependency order. When writing migrations, create in this order — `extensions → properties → users → settings → files → room_types → rooms → guests → guest_documents → maintenance_issues → bookings → room_allocations → booking_nights → booking_guests → folio_charges → invoices → invoice_lines → payments → expense_categories → expenses → rate_rules → number_sequences → activity_logs → job_queue → daily_stats → notifications` — and add the handful of circular foreign keys (`settings.updated_by`, `payments.invoice_id`, `room_allocations.maintenance_issue_id`, `properties.logo_file_id`) with `ALTER TABLE … ADD CONSTRAINT` at the end of the same migration. One migration, all constraints. [ERP-FIX]

#### 6.5.1 Property & settings

```sql
CREATE TABLE properties (
  id            uuid PRIMARY KEY DEFAULT new_id(),
  name          text NOT NULL,
  legal_name    text,
  address       text,
  city          text,
  country       text NOT NULL DEFAULT 'KE',
  timezone      text NOT NULL DEFAULT 'Africa/Nairobi',
  currency      char(3) NOT NULL DEFAULT 'KES',
  phone         text,
  email         text,
  tax_pin       text,                          -- KRA PIN / VAT number on invoices
  logo_file_id  uuid,
  check_in_time time NOT NULL DEFAULT '14:00',
  check_out_time time NOT NULL DEFAULT '10:00',
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Typed key/value app configuration. One row per setting, audited like everything else.
CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  description text,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- Seeded keys: default_property_id, vat_rate, levy_rate, invoice_prefix, booking_ref_prefix,
--              cancellation_policy_hours, no_show_hour, deposit_percent, receipt_footer
```

**Tax note:** VAT and any tourism/catering levy are stored as **settings**, applied per folio line, and snapshotted onto invoices. Rates are configured by the client's accountant at go-live — the code MUST NOT hardcode any percentage.

#### 6.5.2 Identity

Better Auth owns `user`, `session`, `account`, `verification` (generate with its CLI, then commit the generated Drizzle schema). We extend with our own profile/authority columns.

```sql
-- Better Auth core table, extended with additionalFields:
CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT new_id(),
  name              text NOT NULL,
  email             text NOT NULL UNIQUE,
  email_verified    boolean NOT NULL DEFAULT false,
  image             text,
  -- our extensions --
  role              user_role NOT NULL DEFAULT 'receptionist',
  status            user_status NOT NULL DEFAULT 'active',
  phone             text,
  property_id       uuid REFERENCES properties(id),  -- home property (multi-branch ready)
  must_change_password boolean NOT NULL DEFAULT true,
  password_changed_at  timestamptz,
  last_login_at     timestamptz,
  two_factor_enabled boolean NOT NULL DEFAULT false,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email)) WHERE deleted_at IS NULL;

-- Per-user permission overrides. Copies the ERP's most flexible RBAC idea. [ERP-DNA]
CREATE TABLE user_permission_overrides (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission text NOT NULL,
  allowed    boolean NOT NULL,
  granted_by uuid REFERENCES users(id),
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission)
);

-- DB-backed throttling: survives restarts, needs no Redis. [ERP-DNA]
CREATE TABLE rate_limit_attempts (
  id          bigserial PRIMARY KEY,
  bucket      text NOT NULL,           -- 'login:user@x.com' | 'api:POST /v1/bookings:<userId>'
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_limit_bucket_time_idx ON rate_limit_attempts (bucket, attempted_at DESC);
```

#### 6.5.3 Inventory: room types, rooms, rates

```sql
CREATE TABLE room_types (
  id              uuid PRIMARY KEY DEFAULT new_id(),
  property_id     uuid NOT NULL REFERENCES properties(id),
  code            text NOT NULL,                       -- 'SGL','DBL','DLX','STE'
  name            text NOT NULL,                       -- Single, Double, Deluxe, Suite
  description     text,
  base_rate       numeric(14,2) NOT NULL CHECK (base_rate >= 0),
  max_occupancy   smallint NOT NULL CHECK (max_occupancy BETWEEN 1 AND 20),
  max_adults      smallint NOT NULL DEFAULT 2,
  max_children    smallint NOT NULL DEFAULT 0,
  extra_bed_rate  numeric(14,2) NOT NULL DEFAULT 0,
  amenities       text[] NOT NULL DEFAULT '{}',
  photo_file_ids  uuid[] NOT NULL DEFAULT '{}',
  display_order   smallint NOT NULL DEFAULT 0,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE UNIQUE INDEX room_types_code_uq ON room_types (property_id, upper(code)) WHERE deleted_at IS NULL;
CREATE INDEX room_types_amenities_gin ON room_types USING gin (amenities);

CREATE TABLE rooms (
  id             uuid PRIMARY KEY DEFAULT new_id(),
  property_id    uuid NOT NULL REFERENCES properties(id),
  room_type_id   uuid NOT NULL REFERENCES room_types(id),
  room_number    text NOT NULL,
  floor          text,
  condition      room_condition NOT NULL DEFAULT 'available',
  housekeeping   housekeeping_status NOT NULL DEFAULT 'clean',
  notes          text,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
-- Per-property uniqueness, partial on soft-delete. The ERP's best index pattern. [ERP-DNA]
CREATE UNIQUE INDEX rooms_number_uq ON rooms (property_id, upper(room_number)) WHERE deleted_at IS NULL;
CREATE INDEX rooms_type_idx ON rooms (room_type_id);
CREATE INDEX rooms_condition_idx ON rooms (property_id, condition) WHERE deleted_at IS NULL;

-- [P2] Seasonal / day-of-week pricing. Table exists from day one; UI ships in Phase 2.
CREATE TABLE rate_rules (
  id            uuid PRIMARY KEY DEFAULT new_id(),
  property_id   uuid NOT NULL REFERENCES properties(id),
  room_type_id  uuid REFERENCES room_types(id),        -- NULL = all types
  name          text NOT NULL,
  valid_from    date NOT NULL,
  valid_to      date NOT NULL,
  days_of_week  smallint[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  min_nights    smallint NOT NULL DEFAULT 1,
  rate          numeric(14,2) NOT NULL CHECK (rate >= 0),
  priority      smallint NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to >= valid_from)
);
CREATE INDEX rate_rules_lookup_idx ON rate_rules (property_id, room_type_id, valid_from, valid_to)
  WHERE is_active;
```

#### 6.5.4 Guests

```sql
CREATE TABLE guests (
  id              uuid PRIMARY KEY DEFAULT new_id(),
  property_id     uuid NOT NULL REFERENCES properties(id),
  full_name       text NOT NULL,
  phone           text,
  email           text,
  id_type         id_document_type,
  id_number       text,
  nationality     text,
  date_of_birth   date,
  address         text,
  company         text,
  notes           text,                 -- staff-visible preferences
  is_blacklisted  boolean NOT NULL DEFAULT false,
  blacklist_reason text,
  stay_count      integer NOT NULL DEFAULT 0,     -- maintained by night audit, not on the write path
  lifetime_value  numeric(14,2) NOT NULL DEFAULT 0,
  last_stay_date  date,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
-- Two guests may share a name; they may not share an ID document.
CREATE UNIQUE INDEX guests_id_number_uq ON guests (property_id, id_type, upper(id_number))
  WHERE id_number IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX guests_name_trgm ON guests USING gin (full_name gin_trgm_ops);
CREATE INDEX guests_phone_idx ON guests (property_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX guests_email_idx ON guests (property_id, lower(email)) WHERE email IS NOT NULL;

CREATE TABLE guest_documents (
  id          uuid PRIMARY KEY DEFAULT new_id(),
  guest_id    uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  file_id     uuid NOT NULL REFERENCES files(id),
  doc_type    id_document_type NOT NULL,
  uploaded_by uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

#### 6.5.5 Bookings and the allocation ledger — the heart of the system

```sql
CREATE TABLE bookings (
  id                 uuid PRIMARY KEY DEFAULT new_id(),
  property_id        uuid NOT NULL REFERENCES properties(id),
  reference          text NOT NULL,                    -- 'BK-2026-000412', human-facing
  guest_id           uuid NOT NULL REFERENCES guests(id),
  status             booking_status NOT NULL DEFAULT 'draft',
  source             booking_source NOT NULL DEFAULT 'front_desk',

  -- Denormalised span across all rooms on the booking; maintained by the service, used for list views.
  arrival_date       date NOT NULL,
  departure_date     date NOT NULL,
  nights             integer GENERATED ALWAYS AS (departure_date - arrival_date) STORED,
  adults             smallint NOT NULL DEFAULT 1,
  children           smallint NOT NULL DEFAULT 0,

  -- Immutable snapshots for reporting/history. [ERP-DNA: denormalised document history]
  guest_name_snapshot  text NOT NULL,
  guest_phone_snapshot text,

  -- Money. Derived from folio_charges; recomputed inside the transaction, never trusted from client.
  total_charges      numeric(14,2) NOT NULL DEFAULT 0,
  total_paid         numeric(14,2) NOT NULL DEFAULT 0,
  balance            numeric(14,2) GENERATED ALWAYS AS (total_charges - total_paid) STORED,

  special_requests   text,
  internal_notes     text,
  cancellation_reason text,
  cancelled_at       timestamptz,
  cancelled_by       uuid REFERENCES users(id),
  checked_in_at      timestamptz,
  checked_in_by      uuid REFERENCES users(id),
  checked_out_at     timestamptz,
  checked_out_by     uuid REFERENCES users(id),

  idempotency_key    text,                             -- guards double-submit  [ERP-FIX]
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CHECK (departure_date > arrival_date),
  CHECK (adults >= 1)
);
CREATE UNIQUE INDEX bookings_reference_uq ON bookings (property_id, reference);
CREATE UNIQUE INDEX bookings_idempotency_uq ON bookings (property_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX bookings_arrival_idx   ON bookings (property_id, arrival_date, status);
CREATE INDEX bookings_departure_idx ON bookings (property_id, departure_date, status);
CREATE INDEX bookings_guest_idx     ON bookings (guest_id, created_at DESC);
CREATE INDEX bookings_status_idx    ON bookings (property_id, status) WHERE status IN ('confirmed','checked_in');
```

```sql
-- ═══════════════════════════════════════════════════════════════════════
-- THE ALLOCATION LEDGER
-- One table holds BOTH reservations and maintenance blocks, so that ONE
-- exclusion constraint can guarantee a room is never occupied twice —
-- including "booked over a room that is out of order".
-- Two separate tables cannot share a constraint. This is why they are one.
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE room_allocations (
  id                   uuid PRIMARY KEY DEFAULT new_id(),
  property_id          uuid NOT NULL REFERENCES properties(id),
  room_id              uuid NOT NULL REFERENCES rooms(id),
  kind                 allocation_kind NOT NULL,
  status               allocation_status NOT NULL,

  booking_id           uuid REFERENCES bookings(id) ON DELETE CASCADE,
  maintenance_issue_id uuid REFERENCES maintenance_issues(id) ON DELETE SET NULL,
  block_reason         text,

  start_date           date NOT NULL,      -- first night occupied
  end_date             date NOT NULL,      -- departure date  (EXCLUSIVE — see below)

  rate_snapshot        numeric(14,2),      -- nightly rate agreed at confirmation
  room_type_snapshot   uuid REFERENCES room_types(id),
  adults               smallint NOT NULL DEFAULT 1,
  children             smallint NOT NULL DEFAULT 0,

  held_until           timestamptz,        -- [P2] online-portal holds
  released_at          timestamptz,
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT alloc_dates_valid CHECK (end_date > start_date),
  CONSTRAINT alloc_kind_shape CHECK (
    (kind = 'reservation' AND booking_id IS NOT NULL)
    OR (kind = 'block' AND booking_id IS NULL AND block_reason IS NOT NULL)
  )
);

-- ★★★ THE CONSTRAINT THAT MAKES DOUBLE-BOOKING PHYSICALLY IMPOSSIBLE ★★★
-- '[)' semantics: a stay of 10th→12th occupies the nights of the 10th and 11th.
-- A new guest CAN arrive on the 12th. Using '[]' (as naive designs do) would
-- wrongly block the departure day and lose the hotel a night's revenue.
ALTER TABLE room_allocations
  ADD CONSTRAINT room_allocations_no_overlap
  EXCLUDE USING gist (
    room_id WITH =,
    daterange(start_date, end_date, '[)') WITH &&
  )
  WHERE (status IN ('held','confirmed','checked_in','checked_out','blocked'));

CREATE INDEX allocations_booking_idx ON room_allocations (booking_id);
CREATE INDEX allocations_room_dates_idx ON room_allocations (room_id, start_date, end_date);
CREATE INDEX allocations_property_dates_idx ON room_allocations (property_id, start_date, end_date)
  WHERE status IN ('confirmed','checked_in','checked_out','blocked');
CREATE INDEX allocations_held_expiry_idx ON room_allocations (held_until)
  WHERE status = 'held';
```

**Why `checked_out` still blocks:** on early departure we *shorten* `end_date` to the actual departure date and then set `checked_out`. The freed nights become bookable immediately, and history stays truthful — you can never produce a report showing two guests in one room on one night. Statuses `released` (cancelled / expired hold / no-show) do not block.

```sql
-- One row per room per night. Written when a booking is confirmed.
-- This is what makes occupancy, ADR and RevPAR a trivial GROUP BY instead of
-- a date-range gymnastics exercise, and it makes revenue recognition per-night correct.
CREATE TABLE booking_nights (
  id             uuid PRIMARY KEY DEFAULT new_id(),
  property_id    uuid NOT NULL REFERENCES properties(id),
  booking_id     uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  allocation_id  uuid NOT NULL REFERENCES room_allocations(id) ON DELETE CASCADE,
  room_id        uuid NOT NULL REFERENCES rooms(id),
  room_type_id   uuid NOT NULL REFERENCES room_types(id),
  stay_date      date NOT NULL,
  rate           numeric(14,2) NOT NULL CHECK (rate >= 0),
  is_posted      boolean NOT NULL DEFAULT false,   -- has the night audit charged it to the folio?
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX booking_nights_uq ON booking_nights (allocation_id, stay_date);
CREATE INDEX booking_nights_date_idx ON booking_nights (property_id, stay_date);
CREATE INDEX booking_nights_unposted_idx ON booking_nights (property_id, stay_date) WHERE NOT is_posted;

-- Additional occupants (spec: "Assign a guest and room" + group stays)
CREATE TABLE booking_guests (
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  guest_id   uuid NOT NULL REFERENCES guests(id),
  is_primary boolean NOT NULL DEFAULT false,
  PRIMARY KEY (booking_id, guest_id)
);
```

#### 6.5.6 Money: folio, payments, invoices

```sql
-- The guest folio: every charge that will appear on the bill.
CREATE TABLE folio_charges (
  id            uuid PRIMARY KEY DEFAULT new_id(),
  property_id   uuid NOT NULL REFERENCES properties(id),
  booking_id    uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  charge_type   charge_type NOT NULL,
  description   text NOT NULL,
  quantity      numeric(10,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_amount   numeric(14,2) NOT NULL,
  tax_rate      numeric(5,2) NOT NULL DEFAULT 0,          -- percent, snapshotted from settings
  tax_amount    numeric(14,2) NOT NULL DEFAULT 0,
  total_amount  numeric(14,2) NOT NULL,
  charge_date   date NOT NULL,                            -- business date the charge belongs to
  source_night_id uuid REFERENCES booking_nights(id),     -- set for auto-posted room charges
  is_voided     boolean NOT NULL DEFAULT false,
  voided_by     uuid REFERENCES users(id),
  voided_reason text,
  posted_by     uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX folio_booking_idx ON folio_charges (booking_id) WHERE NOT is_voided;
CREATE INDEX folio_date_idx ON folio_charges (property_id, charge_date) WHERE NOT is_voided;
CREATE UNIQUE INDEX folio_room_night_uq ON folio_charges (source_night_id)
  WHERE source_night_id IS NOT NULL AND NOT is_voided;   -- a night can be charged exactly once

CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT new_id(),
  property_id     uuid NOT NULL REFERENCES properties(id),
  booking_id      uuid REFERENCES bookings(id),
  invoice_id      uuid REFERENCES invoices(id),
  receipt_number  text NOT NULL,
  payment_type    payment_type NOT NULL DEFAULT 'payment',
  amount          numeric(14,2) NOT NULL CHECK (amount > 0),   -- always positive; type carries direction
  method          payment_method NOT NULL,
  status          payment_status NOT NULL DEFAULT 'completed',
  reference       text,                       -- M-Pesa code, cheque no, bank ref, card auth
  payer_name      text,
  paid_at         timestamptz NOT NULL DEFAULT now(),
  business_date   date NOT NULL,              -- which hotel day it belongs to
  notes           text,
  reversal_of     uuid REFERENCES payments(id),
  reversed_by     uuid REFERENCES users(id),
  reversed_reason text,
  idempotency_key text,
  recorded_by     uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payments_receipt_uq ON payments (property_id, receipt_number);
CREATE UNIQUE INDEX payments_idempotency_uq ON payments (property_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
-- M-Pesa/bank references must be unique per method: prevents entering the same code twice.
CREATE UNIQUE INDEX payments_reference_uq ON payments (property_id, method, upper(reference))
  WHERE reference IS NOT NULL AND reference <> '' AND status = 'completed';
CREATE INDEX payments_booking_idx ON payments (booking_id);
CREATE INDEX payments_date_idx ON payments (property_id, business_date, method);

CREATE TABLE invoices (
  id              uuid PRIMARY KEY DEFAULT new_id(),
  property_id     uuid NOT NULL REFERENCES properties(id),
  booking_id      uuid NOT NULL REFERENCES bookings(id),
  invoice_number  text NOT NULL,
  status          invoice_status NOT NULL DEFAULT 'draft',
  issued_at       timestamptz,
  due_date        date,
  -- Frozen snapshots. An issued invoice NEVER changes because a guest was renamed. [ERP-DNA]
  bill_to_name    text NOT NULL,
  bill_to_address text,
  bill_to_tax_pin text,
  subtotal        numeric(14,2) NOT NULL DEFAULT 0,
  tax_total       numeric(14,2) NOT NULL DEFAULT 0,
  discount_total  numeric(14,2) NOT NULL DEFAULT 0,
  grand_total     numeric(14,2) NOT NULL DEFAULT 0,
  amount_paid     numeric(14,2) NOT NULL DEFAULT 0,
  currency        char(3) NOT NULL DEFAULT 'KES',
  pdf_file_id     uuid REFERENCES files(id),
  void_reason     text,
  issued_by       uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX invoices_number_uq ON invoices (property_id, invoice_number);
CREATE INDEX invoices_booking_idx ON invoices (booking_id);

CREATE TABLE invoice_lines (
  id           uuid PRIMARY KEY DEFAULT new_id(),
  invoice_id   uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  charge_id    uuid REFERENCES folio_charges(id),
  description  text NOT NULL,
  quantity     numeric(10,2) NOT NULL,
  unit_amount  numeric(14,2) NOT NULL,
  tax_rate     numeric(5,2) NOT NULL DEFAULT 0,
  tax_amount   numeric(14,2) NOT NULL DEFAULT 0,
  total_amount numeric(14,2) NOT NULL,
  sort_order   smallint NOT NULL DEFAULT 0
);

-- Gap-free human-readable numbering. Advisory-locked, exactly as the ERP did invoices. [ERP-DNA]
CREATE TABLE number_sequences (
  property_id uuid NOT NULL REFERENCES properties(id),
  name        text NOT NULL,          -- 'booking' | 'invoice' | 'receipt' | 'maintenance' | 'expense'
  prefix      text NOT NULL,
  period      text NOT NULL,          -- '2026' or '2026-09' — resets per period
  next_value  bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (property_id, name, period)
);
```

#### 6.5.7 Maintenance & expenses

```sql
CREATE TABLE maintenance_issues (
  id             uuid PRIMARY KEY DEFAULT new_id(),
  property_id    uuid NOT NULL REFERENCES properties(id),
  reference      text NOT NULL,                    -- 'MT-2026-0087'
  title          text NOT NULL,
  description    text NOT NULL,
  room_id        uuid REFERENCES rooms(id),
  location       text,                             -- for non-room areas: lobby, pool, kitchen
  priority       maintenance_priority NOT NULL DEFAULT 'medium',
  status         maintenance_status NOT NULL DEFAULT 'reported',
  assigned_to    text,                             -- staff name or external service provider
  assigned_user_id uuid REFERENCES users(id),
  estimated_cost numeric(14,2) CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
  -- NOTE: there is deliberately NO actual_cost column. Actual cost is the sum of
  -- linked expenses and is exposed by maintenance_cost_view below. A stored column
  -- would drift the moment an expense is edited or voided.
  takes_room_offline boolean NOT NULL DEFAULT false,
  reported_by    uuid NOT NULL REFERENCES users(id),
  reported_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  resolved_by    uuid REFERENCES users(id),
  resolution_notes text,
  closed_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((room_id IS NOT NULL) OR (location IS NOT NULL))
);
CREATE UNIQUE INDEX maintenance_reference_uq ON maintenance_issues (property_id, reference);
CREATE INDEX maintenance_open_idx ON maintenance_issues (property_id, status, priority)
  WHERE status NOT IN ('resolved','closed');
CREATE INDEX maintenance_room_idx ON maintenance_issues (room_id);

-- "Track repair progress" (spec §10) needs a history, not just a status field.
CREATE TABLE maintenance_updates (
  id          uuid PRIMARY KEY DEFAULT new_id(),
  issue_id    uuid NOT NULL REFERENCES maintenance_issues(id) ON DELETE CASCADE,
  from_status maintenance_status,
  to_status   maintenance_status,
  note        text,
  file_ids    uuid[] NOT NULL DEFAULT '{}',
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE expense_categories (
  id          uuid PRIMARY KEY DEFAULT new_id(),
  property_id uuid NOT NULL REFERENCES properties(id),
  name        text NOT NULL,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE UNIQUE INDEX expense_categories_uq ON expense_categories (property_id, lower(name))
  WHERE deleted_at IS NULL;

CREATE TABLE expenses (
  id                   uuid PRIMARY KEY DEFAULT new_id(),
  property_id          uuid NOT NULL REFERENCES properties(id),
  reference            text NOT NULL,                  -- 'EX-2026-0451'
  category_id          uuid NOT NULL REFERENCES expense_categories(id),
  maintenance_issue_id uuid REFERENCES maintenance_issues(id),   -- the spec §12 link
  description          text NOT NULL,
  amount               numeric(14,2) NOT NULL CHECK (amount > 0),
  expense_date         date NOT NULL,
  method               payment_method NOT NULL,
  reference_number     text,
  vendor               text,
  status               expense_status NOT NULL DEFAULT 'recorded',
  receipt_file_id      uuid REFERENCES files(id),
  recorded_by          uuid NOT NULL REFERENCES users(id),
  approved_by          uuid REFERENCES users(id),
  approved_at          timestamptz,
  rejection_reason     text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz
);
CREATE UNIQUE INDEX expenses_reference_uq ON expenses (property_id, reference);
CREATE INDEX expenses_date_idx ON expenses (property_id, expense_date, category_id) WHERE deleted_at IS NULL;
CREATE INDEX expenses_maintenance_idx ON expenses (maintenance_issue_id) WHERE maintenance_issue_id IS NOT NULL;

-- Actual repair cost = sum of linked expenses. A view, never a denormalised column that drifts.
CREATE VIEW maintenance_cost_view AS
SELECT m.id AS issue_id,
       m.property_id,
       m.estimated_cost,
       COALESCE(SUM(e.amount) FILTER (WHERE e.deleted_at IS NULL), 0) AS actual_cost,
       COUNT(e.id) FILTER (WHERE e.deleted_at IS NULL) AS expense_count
FROM maintenance_issues m
LEFT JOIN expenses e ON e.maintenance_issue_id = m.id
GROUP BY m.id, m.property_id, m.estimated_cost;
```

#### 6.5.8 Cross-cutting: files, audit, jobs, stats

```sql
CREATE TABLE files (
  id           uuid PRIMARY KEY DEFAULT new_id(),
  property_id  uuid NOT NULL REFERENCES properties(id),
  storage_key  text NOT NULL UNIQUE,        -- 'private/guests/ab/<uuid>.jpg'
  visibility   file_visibility NOT NULL DEFAULT 'private',
  original_name text NOT NULL,
  mime_type    text NOT NULL,
  size_bytes   bigint NOT NULL,
  checksum     text,
  thumbnail_key text,
  entity_type  text,                        -- 'guest' | 'expense' | 'maintenance' | 'room_type'
  entity_id    uuid,
  uploaded_by  uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX files_entity_idx ON files (entity_type, entity_id);

-- Append-only. No UPDATE, no DELETE. Enforced by a trigger and by revoked grants.
CREATE TABLE activity_logs (
  id          bigserial PRIMARY KEY,
  property_id uuid REFERENCES properties(id),
  actor_id    uuid REFERENCES users(id),
  actor_name  text NOT NULL,               -- snapshot: the log survives user deletion
  actor_role  user_role,
  action      text NOT NULL,               -- 'booking.created', 'payment.reversed'
  entity_type text NOT NULL,
  entity_id   uuid,
  summary     text NOT NULL,               -- human sentence for the UI
  changes     jsonb,                       -- { field: { from, to } }
  ip_address  inet,
  user_agent  text,
  request_id  text,                        -- correlation id, ties to logs & Sentry
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_entity_idx ON activity_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX activity_actor_idx  ON activity_logs (actor_id, created_at DESC);
CREATE INDEX activity_action_idx ON activity_logs (action, created_at DESC);

CREATE RULE activity_logs_no_update AS ON UPDATE TO activity_logs DO INSTEAD NOTHING;
CREATE RULE activity_logs_no_delete AS ON DELETE TO activity_logs DO INSTEAD NOTHING;

-- Transactional outbox + job queue in one table. No Redis. [ERP-FIX]
CREATE TABLE job_queue (
  id            bigserial PRIMARY KEY,
  property_id   uuid REFERENCES properties(id),
  job_type      text NOT NULL,             -- 'email.booking_confirmation'
  payload       jsonb NOT NULL,
  status        job_status NOT NULL DEFAULT 'pending',
  priority      smallint NOT NULL DEFAULT 5,
  run_after     timestamptz NOT NULL DEFAULT now(),
  attempts      smallint NOT NULL DEFAULT 0,
  max_attempts  smallint NOT NULL DEFAULT 5,
  last_error    text,
  dedupe_key    text,                      -- idempotency for side effects
  locked_at     timestamptz,
  locked_by     text,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_queue_ready_idx ON job_queue (status, run_after, priority)
  WHERE status IN ('pending','processing');
CREATE UNIQUE INDEX job_queue_dedupe_uq ON job_queue (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status <> 'dead';

-- Frozen nightly metrics. Reports read this, not the live tables. [ERP-FIX: no cached aggregates]
CREATE TABLE daily_stats (
  property_id      uuid NOT NULL REFERENCES properties(id),
  business_date    date NOT NULL,
  rooms_total      integer NOT NULL,
  rooms_sellable   integer NOT NULL,        -- total minus out-of-order
  rooms_sold       integer NOT NULL,
  occupancy_pct    numeric(5,2) NOT NULL,
  room_revenue     numeric(14,2) NOT NULL,
  other_revenue    numeric(14,2) NOT NULL,
  total_revenue    numeric(14,2) NOT NULL,
  adr              numeric(14,2) NOT NULL,  -- room_revenue / rooms_sold
  revpar           numeric(14,2) NOT NULL,  -- room_revenue / rooms_sellable
  arrivals         integer NOT NULL,
  departures       integer NOT NULL,
  in_house         integer NOT NULL,
  no_shows         integer NOT NULL,
  cancellations    integer NOT NULL,
  expenses_total   numeric(14,2) NOT NULL,
  payments_total   numeric(14,2) NOT NULL,
  computed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, business_date)
);

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT new_id(),
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  role       user_role,                   -- broadcast to a role when user_id is null
  type       text NOT NULL,
  title      text NOT NULL,
  body       text,
  link       text,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_unread_idx ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
```

### 6.6 Spec table → implementation mapping

Proof that nothing in the functional spec (§16) was dropped:

| Spec table | Implemented as | Changes and why |
|---|---|---|
| `USERS` | `users` + Better Auth `session`/`account` + `user_permission_overrides` | Real sessions, per-user grants, 2FA-ready |
| `ROOM_TYPES` | `room_types` | + amenities array, occupancy limits, photos |
| `ROOMS` | `rooms` | `status` split into physical `condition` + `housekeeping` (§6.4) |
| `GUESTS` | `guests` + `guest_documents` | + dedupe index on ID, trigram search, stay history |
| `BOOKINGS` | `bookings` + **`room_allocations`** + `booking_nights` + `booking_guests` | One booking may hold several rooms; allocations carry the anti-overlap constraint; nights make reporting exact |
| `PAYMENTS` | `payments` (+ `folio_charges` for the other side of the ledger) | Charges and payments are different things; the spec merged them implicitly |
| `EXPENSE_CATEGORIES` | `expense_categories` | Seeded with the spec's 11 categories |
| `EXPENSES` | `expenses` | + approval workflow, vendor, receipt file |
| `MAINTENANCE_ISSUES` | `maintenance_issues` + `maintenance_updates` + `maintenance_cost_view` | Progress history; actual cost derived from linked expenses, never a drifting column |
| `ACTIVITY_LOGS` | `activity_logs` | Append-only enforced by rules; field-level diffs; correlation ids |
| *(new)* | `invoices`, `invoice_lines`, `number_sequences`, `files`, `job_queue`, `daily_stats`, `notifications`, `settings`, `rate_rules`, `rate_limit_attempts`, `properties` | Required by spec sections 9, 13, 14, 19 that had no table listed |

---

## 7. Dates, times and the business day

The single most under-specified area of every hotel spec, and a top-two source of production bugs.

```ts
// core/dates/business-date.ts
// A "business date" is the hotel's calendar day in ITS timezone (Africa/Nairobi),
// not the server's, not the browser's, and not UTC.

export function businessDate(at: Date = new Date(), tz = HOTEL_TZ): DateOnly
export function nightsBetween(arrival: DateOnly, departure: DateOnly): DateOnly[]
export function isStayover(a: Allocation, on: DateOnly): boolean
export function nightCount(arrival: DateOnly, departure: DateOnly): number
```

**Rules (MUST):**
1. `arrival_date`, `departure_date`, `stay_date`, `expense_date`, `charge_date`, `business_date` are `date`. They are never converted to `Date` objects with a time component in application code — use a `DateOnly` string type (`'2026-09-14'`).
2. A stay of arrival `D1` to departure `D2` occupies **nights `D1 … D2-1`**. `nights = D2 - D1`. A one-night stay has `D2 = D1 + 1`.
3. Nothing in the system ever uses `new Date().toISOString().slice(0,10)` on the server. That is UTC and it is wrong for three hours a day in Nairobi.
4. Timestamps of *events* (`checked_in_at`, `paid_at`, `created_at`) are `timestamptz` and are stored as instants.
5. The **business day rolls at the night audit**, not at midnight, so late-night activity is attributed correctly. Configurable via `settings.night_audit_hour` (default `03:00`).

---

## 8. Data access layer

### 8.1 The pool is not exported

The ERP's single **critical** finding was an exported `db` proxy that bypassed row-level security, used in routes and cron. We structurally prevent the equivalent mistake.

```ts
// core/db/client.ts
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

const pool = new Pool({
  connectionString: env.DATABASE_URL,     // role: hms_app (NOT superuser, NOT owner)
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 15_000,              // [ERP-FIX] no runaway queries
});

const _db = drizzle(pool, { schema });

// NOT EXPORTED. The only way to reach the database is through the wrappers below.
```

```ts
// core/db/index.ts  — the ONLY database surface the app may import

/** Read-only / single-statement access. */
export async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T>;

/** Transactional access. Everything that writes MUST use this. [ERP-DNA: withTenant shape] */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;

/** Serialise a critical section by name (e.g. number sequences). [ERP-DNA: advisory locks] */
export async function withAdvisoryLock<T>(tx: Tx, key: string, fn: () => Promise<T>): Promise<T>;

export { schema };
export type { Db, Tx };
```

An ESLint rule (`hms/no-raw-db`) bans importing `pg`, `drizzle-orm/node-postgres` or `core/db/client` anywhere except `core/db/*`. [ERP-FIX]

### 8.2 Postgres error translation

Constraint violations are the *design*, so they must surface as clean API errors, never 500s.

```ts
// core/db/errors.ts
export const PG = {
  UNIQUE_VIOLATION:    '23505',
  EXCLUSION_VIOLATION: '23P01',   // ← double-booking attempt
  FK_VIOLATION:        '23503',
  CHECK_VIOLATION:     '23514',
  SERIALIZATION:       '40001',
  DEADLOCK:            '40P01',
  LOCK_TIMEOUT:        '55P03',
};

export function translateDbError(e: unknown): AppError {
  if (!isPgError(e)) return AppError.internal(e);
  switch (e.code) {
    case PG.EXCLUSION_VIOLATION:
      if (e.constraint === 'room_allocations_no_overlap')
        return AppError.conflict('ROOM_UNAVAILABLE',
          'That room was just taken for one or more of those nights.');
      return AppError.conflict('OVERLAP', 'Conflicting record.');
    case PG.UNIQUE_VIOLATION:
      return uniqueMessages[e.constraint!] ?? AppError.conflict('DUPLICATE', 'Record already exists.');
    case PG.SERIALIZATION:
    case PG.DEADLOCK:
      return AppError.retryable('CONTENTION', 'Please try again.');
    default:
      return AppError.internal(e);
  }
}
```

### 8.3 Database roles (least privilege, kept from the ERP)

```sql
CREATE ROLE hms_migrator LOGIN PASSWORD '...';   -- owns the schema, runs migrations
CREATE ROLE hms_app      LOGIN PASSWORD '...';   -- the application. No DDL. No superuser.

GRANT CONNECT ON DATABASE hms TO hms_app;
GRANT USAGE ON SCHEMA public TO hms_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO hms_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hms_app;

-- Financial history is append-only for the application role:
REVOKE DELETE ON payments, invoices, invoice_lines, folio_charges, activity_logs, booking_nights FROM hms_app;
ALTER DEFAULT PRIVILEGES FOR ROLE hms_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO hms_app;
```

### 8.4 Fail-closed configuration

The ERP silently degraded when `DATABASE_URL_ADMIN` was unset (it fell back to the runtime URL). We do the opposite: **the process refuses to boot on invalid configuration.**

```ts
// core/config/env.ts
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development','test','production']),
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  HOTEL_TIMEZONE: z.string().default('Africa/Nairobi'),
  R2_ACCOUNT_ID: z.string(), R2_ACCESS_KEY_ID: z.string(), R2_SECRET_ACCESS_KEY: z.string(),
  R2_BUCKET_PRIVATE: z.string(), R2_BUCKET_PUBLIC: z.string(),
  RESEND_API_KEY: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
  CRON_SECRET: z.string().min(32),
  JOB_WORKER_ENABLED: z.coerce.boolean().default(true),
});

export const env = EnvSchema.parse(process.env);   // throws at import time → process dies. Good.
```

In production, `SENTRY_DSN` and `RESEND_API_KEY` are additionally **required** by a refinement. No silent degradation. [ERP-FIX]

---

## 9. Authentication and authorization

### 9.1 Authentication (Better Auth)

```ts
// core/auth/config.ts
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,      // staff accounts are created by an admin
    password: {
      hash:  (p) => argon2.hash(p, { algorithm: argon2.Algorithm.Argon2id }),
      verify:(d,p) => argon2.verify(d.hash, p),
    },
    resetPasswordTokenExpiresIn: 60 * 30,
  },
  session: {
    expiresIn: 60 * 60 * 12,              // 12h — one shift
    updateAge: 60 * 15,
    freshAge: 60 * 10,                    // sensitive ops require a fresh session
    cookieCache: { enabled: true, maxAge: 60 },
  },
  user: {
    additionalFields: {
      role: { type: 'string', defaultValue: 'receptionist', input: false },
      status: { type: 'string', defaultValue: 'active', input: false },
      propertyId: { type: 'string', input: false },
      mustChangePassword: { type: 'boolean', defaultValue: true, input: false },
    },
  },
  plugins: [
    admin({ defaultRole: 'receptionist', adminRoles: ['admin'] }),
    twoFactor({ issuer: 'Hotel Management System' }),   // TOTP — the ERP had no MFA
  ],
  rateLimit: { enabled: true, window: 60, max: 20 },
  advanced: { useSecureCookies: env.NODE_ENV === 'production' },
});
```

**Session rules:**
- DB sessions → an admin disabling a user kills their access **immediately**. No 24h JWT window.
- `status !== 'active'` is checked in `requireSession()` on every request. [ERP-DNA]
- Changing a password revokes all other sessions for that user. [ERP-DNA]
- 2FA is optional per user; **required for `admin`** in production.
- Login throttling: 5 attempts / 15 minutes per email **and** per IP, DB-backed. [ERP-DNA]

### 9.2 Session helpers

```ts
// core/auth/session.ts
export async function getActor(): Promise<Actor | null>;      // null when signed out
export async function requireActor(): Promise<Actor>;          // throws 401
export async function requirePermission(p: Permission): Promise<Actor>;  // throws 403
export function can(actor: Actor, p: Permission): boolean;     // pure, testable, usable in UI

export type Actor = {
  id: string; name: string; email: string;
  role: UserRole; propertyId: string;
  permissions: ReadonlySet<Permission>;   // role matrix + per-user overrides, resolved once
};
```

### 9.3 The permission matrix

A single static, importable, unit-tested object. [ERP-DNA — this was one of the ERP's genuinely excellent ideas.]

```ts
// modules/identity/permissions.ts
export const PERMISSIONS = [
  // Users & system
  'users.read','users.create','users.update','users.deactivate','users.reset_password',
  'settings.read','settings.update','audit.read',
  // Inventory
  'rooms.read','rooms.create','rooms.update','rooms.delete','rooms.change_condition',
  'roomtypes.read','roomtypes.create','roomtypes.update','roomtypes.delete',
  'rates.read','rates.update',
  // Guests
  'guests.read','guests.create','guests.update','guests.merge','guests.delete','guests.blacklist',
  'guests.view_documents',
  // Bookings
  'bookings.read','bookings.create','bookings.update','bookings.cancel','bookings.move_room',
  'bookings.override_rate','bookings.backdate',
  'frontdesk.check_in','frontdesk.check_out','frontdesk.night_audit',
  // Money
  'payments.read','payments.record','payments.reverse','payments.refund',
  'folio.read','folio.post_charge','folio.void_charge','folio.discount',
  'invoices.read','invoices.issue','invoices.void',
  // Operations
  'housekeeping.read','housekeeping.update',
  'maintenance.read','maintenance.report','maintenance.update','maintenance.assign','maintenance.close',
  'expenses.read','expenses.create','expenses.update','expenses.approve','expenses.delete',
  // Insight
  'reports.operational','reports.financial','reports.export',
] as const;
export type Permission = typeof PERMISSIONS[number];

export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  admin: PERMISSIONS,                              // everything
  manager: [ /* see Appendix C */ ],
  receptionist: [ /* see Appendix C */ ],
};

export const ROLE_LEVEL: Record<UserRole, number> = { admin: 100, manager: 50, receptionist: 10 };

/** A user may only modify users strictly below their level. [ERP-DNA: canModifyUser] */
export function canModifyUser(actor: Actor, target: { role: UserRole }): boolean {
  return ROLE_LEVEL[actor.role] > ROLE_LEVEL[target.role];
}
```

**The rule that matters (MUST):** `requirePermission()` on the server is the *only* authorization. `<Can permission="...">` in React is cosmetic — it hides buttons, it does not protect data. Every single `/api/v1` mutation calls `requirePermission` as its second statement. [ERP-DNA]

### 9.4 Dangerous-action rules

| Action | Requirement |
|---|---|
| Reverse a payment | `payments.reverse` + reason (min 10 chars) + audit entry + fresh session |
| Void an invoice | `invoices.void` + reason + audit; the invoice is never deleted |
| Override a room rate | `bookings.override_rate` + reason; original rate is snapshotted |
| Backdate a booking or expense | `bookings.backdate` / manager approval; blocked past a closed business date |
| Delete a guest | Soft delete only; blocked if the guest has any booking |
| Deactivate a user | Cannot deactivate yourself; cannot deactivate the last active admin |
| Change hotel settings | `settings.update`; every change is diffed into `activity_logs` |

---

# PART III — THE DOMAIN

## 10. Availability

Availability is its own bounded context, not a field on `rooms`. Everything reads it; only the booking service writes it.

### 10.1 Search: which rooms are free for a date range

```sql
-- modules/availability/repository.ts :: findAvailableRooms
SELECT r.id, r.room_number, r.floor, rt.id AS room_type_id, rt.name AS room_type,
       rt.base_rate, rt.max_occupancy
FROM rooms r
JOIN room_types rt ON rt.id = r.room_type_id
WHERE r.property_id = $1
  AND r.deleted_at IS NULL
  AND r.is_active
  AND r.condition <> 'out_of_order'
  AND ($4::uuid IS NULL OR r.room_type_id = $4)
  AND ($5::smallint IS NULL OR rt.max_occupancy >= $5)
  AND NOT EXISTS (
    SELECT 1
    FROM room_allocations a
    WHERE a.room_id = r.id
      AND a.status IN ('held','confirmed','checked_in','checked_out','blocked')
      AND ($6::uuid IS NULL OR a.booking_id IS DISTINCT FROM $6)   -- ignore self when editing
      AND daterange(a.start_date, a.end_date, '[)')
          && daterange($2::date, $3::date, '[)')
  )
ORDER BY rt.display_order, r.room_number;
```

The GiST index created by the exclusion constraint serves this `&&` predicate directly. **Target: < 30 ms p95** even at 500 rooms × 2 years of allocations.

### 10.2 Availability counts per room type per day (the calendar strip)

```sql
WITH days AS (
  SELECT d::date AS stay_date FROM generate_series($2::date, ($3::date - 1), '1 day') d
),
sellable AS (
  SELECT room_type_id, COUNT(*)::int AS total
  FROM rooms
  WHERE property_id = $1 AND deleted_at IS NULL AND is_active AND condition <> 'out_of_order'
  GROUP BY room_type_id
),
sold AS (
  SELECT r.room_type_id, d.stay_date, COUNT(*)::int AS taken
  FROM days d
  JOIN room_allocations a
    ON a.property_id = $1
   AND a.status IN ('held','confirmed','checked_in','checked_out','blocked')
   AND d.stay_date >= a.start_date AND d.stay_date < a.end_date
  JOIN rooms r ON r.id = a.room_id
  GROUP BY r.room_type_id, d.stay_date
)
SELECT rt.id, rt.name, d.stay_date,
       s.total,
       COALESCE(so.taken, 0) AS sold,
       s.total - COALESCE(so.taken, 0) AS available
FROM days d
CROSS JOIN room_types rt
JOIN sellable s ON s.room_type_id = rt.id
LEFT JOIN sold so ON so.room_type_id = rt.id AND so.stay_date = d.stay_date
WHERE rt.property_id = $1 AND rt.deleted_at IS NULL
ORDER BY rt.display_order, d.stay_date;
```

### 10.3 Rate quoting

```ts
// modules/availability/service.ts
export async function quoteStay(input: {
  roomTypeId: string; arrival: DateOnly; departure: DateOnly; adults: number; children: number;
}): Promise<Quote>

// Quote = {
//   nights: [{ date, rate, ruleId? }],
//   roomSubtotal, taxBreakdown: [{ name, rate, amount }], total
// }
```

Resolution order (highest priority wins): manual override (needs `bookings.override_rate`) → active `rate_rules` match by priority → `room_types.base_rate`.
**MUST:** the quote is recomputed server-side inside the booking transaction. A price posted by the client is a suggestion, never a fact. [ERP-DNA — the ERP re-validated sale totals server-side; keep that instinct.]

---

## 11. ★ The booking engine and double-booking prevention

This is the section to read twice. Everything else in the system can be rebuilt in a week; this is the part that must be right on the first day.

### 11.1 Three independent layers

| Layer | Mechanism | What it stops |
|---|---|---|
| **1. Database constraint** | `EXCLUDE USING gist (room_id WITH =, daterange(...) WITH &&)` | *Everything.* Two overlapping live allocations for one room cannot exist. Not "unlikely" — impossible. Even a bug, a manual `psql` INSERT, or a future integration cannot create one. |
| **2. Row locks in the transaction** | `SELECT … FROM rooms WHERE id = ANY($1) ORDER BY id FOR UPDATE` | Serialises concurrent attempts on the same rooms so they queue instead of colliding, and makes the failure deterministic and fast. [ERP-DNA] |
| **3. Idempotency key** | Unique index on `bookings(property_id, idempotency_key)` | Double-clicks, retried requests, flaky mobile networks creating two identical bookings. [ERP-FIX] |

A fourth, softer layer — a stale-read pre-check before the transaction — exists purely for UX (so the receptionist sees "taken" before filling the form). It is **never** trusted. The ERP's own code comment said it best: the pre-check is a snapshot that may be stale; the authoritative check happens inside the transaction.

### 11.2 The confirm-booking transaction

```ts
// modules/bookings/service.ts
export async function createBooking(input: CreateBookingInput, actor: Actor): Promise<Booking> {
  return withTx(async (tx) => {
    // ── 1. Idempotency: same key ⇒ return the original, do not create a second booking.
    if (input.idempotencyKey) {
      const existing = await bookingRepo.findByIdempotencyKey(tx, input.idempotencyKey);
      if (existing) return existing;
    }

    // ── 2. Guest: resolve or create (dedupe on ID document, then phone).
    const guest = await guestService.resolveOrCreate(tx, input.guest, actor);
    if (guest.isBlacklisted) throw AppError.forbidden('GUEST_BLACKLISTED', guest.blacklistReason);

    // ── 3. Lock the rooms. ORDER BY id is not decoration — consistent lock ordering
    //       is what prevents deadlocks between two concurrent multi-room bookings.
    const roomIds = [...new Set(input.rooms.map(r => r.roomId))].sort();
    const rooms = await roomRepo.lockForUpdate(tx, roomIds);          // SELECT … FOR UPDATE
    assertAllRoomsExistAndAreSellable(rooms, roomIds);

    // ── 4. Price the stay SERVER-SIDE. Never trust a client total.
    const quotes = await Promise.all(input.rooms.map(r =>
      availabilityService.quoteStay(tx, {
        roomTypeId: rooms.get(r.roomId)!.roomTypeId,
        arrival: r.arrival, departure: r.departure,
        adults: r.adults, children: r.children,
        overrideRate: r.overrideRate ? assertCan(actor, 'bookings.override_rate') && r.overrideRate : undefined,
      })));

    // ── 5. Reference number. Advisory lock scoped to the SEQUENCE only,
    //       never to the whole booking — the ERP serialised all sales behind one
    //       invoice lock and throttled its own POS. [ERP-FIX]
    const reference = await withAdvisoryLock(tx, `seq:booking:${propertyId}`,
      () => sequenceRepo.next(tx, 'booking'));

    // ── 6. Insert the booking header.
    const booking = await bookingRepo.insert(tx, { …, reference, status: 'confirmed' });

    // ── 7. Insert allocations. THE EXCLUSION CONSTRAINT IS THE ARBITER.
    //       If any overlap exists, Postgres raises 23P01 and the whole
    //       transaction rolls back. There is no partial booking. Ever.
    try {
      await allocationRepo.insertMany(tx, input.rooms.map(...));
    } catch (e) {
      throw translateDbError(e);   // → 409 ROOM_UNAVAILABLE with the conflicting room
    }

    // ── 8. Materialise nights (one row per room per night) for reporting + posting.
    await nightsRepo.insertMany(tx, expandNights(allocations, quotes));

    // ── 9. Post any immediate charges (deposit-driven, or non-room extras).
    //       Room charges are posted nightly by the night audit, not up front (§13.3).
    await folioService.postInitialCharges(tx, booking, quotes);

    // ── 10. Audit + outbox. NOTHING that talks to the network happens here. [ERP-FIX]
    await auditRepo.log(tx, { action: 'booking.created', entityId: booking.id, actor, changes });
    await outbox.enqueue(tx, [
      { type: 'email.booking_confirmation', payload: { bookingId: booking.id },
        dedupeKey: `confirm:${booking.id}` },
      { type: 'realtime.broadcast', payload: { channel: 'availability', bookingId: booking.id } },
    ]);

    return booking;
  });
}
```

**Transaction budget: this transaction must complete in under 250 ms p95 and hold no more than the rooms it is booking.** It does not send email. It does not render a PDF. It does not call an AI model. Those were exactly the things that made the ERP's sale transaction a bottleneck.

### 11.3 The concurrency proof (mandatory test)

```js
// load/booking-concurrency.js  — k6
// 50 virtual users attempt to book THE SAME room for THE SAME nights, simultaneously.
// PASS CRITERIA (hard gate, blocks release):
//   • exactly 1  response with status 201
//   • exactly 49 responses with status 409 + code ROOM_UNAVAILABLE
//   • 0 responses with status 500
//   • SELECT count(*) FROM room_allocations WHERE room_id = X AND status IN (...) = 1
export const options = {
  scenarios: { thunder: { executor: 'shared-iterations', vus: 50, iterations: 50, maxDuration: '30s' } },
  thresholds: { 'http_req_duration{status:201}': ['p(95)<250'], 'checks': ['rate==1.0'] },
};
```

This test runs in CI on every PR that touches `modules/bookings`, `modules/availability` or `drizzle/`. **A hotel PMS that has not proven this is not sellable.**

### 11.4 Booking state machine

```
              ┌──────────────────────────── cancel ──────────────────────────┐
              │                                                              ▼
   [draft] ──confirm──▶ [confirmed] ──check_in──▶ [checked_in] ──check_out──▶ [checked_out]
              │              │                                                     │
              │              └── no_show (night audit, after cutoff) ──▶ [no_show]  │
              └── cancel ──▶ [cancelled]                                            │
                                                                       (terminal, invoice issued)
```

| Transition | Guard | Effects |
|---|---|---|
| `draft → confirmed` | rooms available (constraint), guest not blacklisted | allocations `confirmed`, nights created, confirmation email queued |
| `confirmed → checked_in` | today ≥ arrival − 0 days; room `condition` is `available`; deposit rule satisfied | allocations `checked_in`, room → `occupied`, `checked_in_at` set |
| `checked_in → checked_out` | balance rule satisfied (see §12.6) | allocation `end_date` trimmed to today if early; room → `cleaning`, housekeeping → `dirty`; invoice issued |
| `confirmed → cancelled` | `bookings.cancel`; reason required | allocations `released`; cancellation-fee charge posted if inside policy window |
| `confirmed → no_show` | night audit after `settings.no_show_hour` | allocations `released` from today forward; no-show fee posted per policy |
| any → `draft` | **forbidden** | there is no un-confirming |

**MUST:** transitions are executed only by `bookings/service.ts`. No route handler, no component, no script sets `status` directly. Illegal transitions throw `AppError.conflict('INVALID_TRANSITION')` and the allowed set is a pure, unit-tested function.

### 11.5 Room moves, extensions, shortening

These are the operations that break naive systems. All three are simply **allocation edits guarded by the same constraint**:

| Operation | Implementation |
|---|---|
| Move room (guest complains about noise) | In one tx: lock both rooms in id order, update `room_allocations.room_id`, re-point future `booking_nights`, log `booking.room_moved`. Constraint rejects the move if the target is taken. |
| Extend stay | Update `end_date` forward, insert new `booking_nights`. Constraint rejects if the next guest is already booked in. Returns `409 ROOM_UNAVAILABLE` with the blocking date. |
| Shorten stay / early departure | Trim `end_date`, delete unposted future `booking_nights`, void unposted future room charges, recompute totals. Nights already posted are **not** removed — apply a credit `adjustment` charge instead so the audit trail survives. |
| Split stay across rooms | Two allocations on one booking. Already supported by the model — nothing special to build. |

---

## 12. Money: folio, payments, invoices

### 12.1 The money rules

1. **`NUMERIC(14,2)` in the database. Always.** `SUM()`, `ROUND()`, and comparisons happen in SQL.
2. In TypeScript, money crossing a boundary is a **string** (`"12500.00"`), never a JS `number`. Drizzle returns `numeric` as string — keep it that way. Parse to `Decimal` only inside `core/money`. [ERP-FIX]
3. Rounding is half-up to 2 dp, applied **once**, at the line level, then summed. Never sum-then-round-then-sum.
4. Tax is stored per line with the rate snapshotted at posting time. Changing the VAT setting never rewrites history.
5. `bookings.total_charges` and `total_paid` are **derived caches** recomputed inside the same transaction that changes a charge or payment. `balance` is a generated column. A nightly reconciliation job asserts they still match the ledger and raises an alert if not.

```ts
// core/money/index.ts
export type Money = string;                       // "1250.00"
export const M = {
  of(v: string | number): Money,
  add(...xs: Money[]): Money,
  sub(a: Money, b: Money): Money,
  mul(a: Money, qty: number): Money,
  pct(a: Money, rate: number): Money,             // tax
  cmp(a: Money, b: Money): -1 | 0 | 1,
  isZero(a: Money): boolean,
  format(a: Money, currency = 'KES'): string,     // "KES 1,250.00"
};
```

### 12.2 The folio

Every booking has exactly one folio: the set of its `folio_charges`. Charges arrive from four sources:

| Source | When | Type |
|---|---|---|
| Night audit | nightly, per `booking_nights` row | `room` + `tax`/`levy` |
| Manual posting | receptionist adds laundry, bar, transfer | `extra`, `service` |
| Policy | cancellation fee, no-show fee, late checkout | `adjustment` |
| Manager | discount, goodwill credit | `discount` (needs `folio.discount`) |

Charges are **never deleted**. They are voided (`is_voided = true` + reason + who), and voiding is a permissioned, audited action. The folio view always shows voided lines struck through — that is what an auditor expects to see.

### 12.3 Payments

Supports every method in the spec: cash, M-Pesa, card, bank transfer, cheque. `amount` is always positive; `payment_type` carries direction.

**Recording a payment (transaction):**
```
lock booking row FOR UPDATE
 → insert payment (idempotency_key unique; reference unique per method)
 → recompute booking.total_paid from the payments ledger  (SUM in SQL)
 → if an invoice is attached, recompute invoice.amount_paid and status
 → audit 'payment.recorded'
 → outbox: email/SMS receipt
```

**Reversal, not deletion.** A wrong payment is corrected by inserting a `reversal_of` row. `payments` has `DELETE` revoked from `hms_app` at the database level (§8.3), so it is not a policy — it is not possible.

**M-Pesa in MVP:** the receptionist enters the M-Pesa transaction code as `reference`. The unique index on `(property_id, method, upper(reference))` makes entering the same code twice impossible — which is the single most common cash-handling fraud/error in Kenyan hospitality. **[P2]** Daraja STK Push + C2B callback reconciliation slots in behind the same `payments` table with `status = 'pending'` until the callback confirms.

### 12.4 Deposits

Configurable via `settings.deposit_percent`. On confirmation, a deposit *expectation* is displayed (not a charge). Check-in is blocked if `total_paid < required_deposit`, unless the actor holds `payments.record` and explicitly overrides with a reason — this is a real front-desk need and blocking it absolutely gets the system uninstalled.

### 12.5 Invoices and receipts

- An invoice is issued at check-out (or on demand for corporate accounts).
- Issuing **freezes** a snapshot: bill-to name, address, tax PIN, and a copy of every live folio line into `invoice_lines`. Renaming a guest afterwards does not alter an issued invoice. [ERP-DNA]
- `invoice_number` comes from `number_sequences` under an advisory lock → gap-free, per-period, `INV-2026-000318`.
- The PDF is rendered **asynchronously by a job** (`invoice.render_pdf`), stored in the private R2 bucket, and linked via `pdf_file_id`. The UI shows an inline HTML preview immediately and swaps in the PDF link when it lands. [ERP-FIX — the ERP generated large documents synchronously in the request.]
- Receipts are issued per payment, numbered from the `receipt` sequence, and are printable to a 80 mm thermal roll via a print stylesheet.
- Voiding an invoice requires `invoices.void` + reason, sets `status='void'`, and leaves the row forever.

### 12.6 Check-out balance policy

```
balance > 0  →  block check-out UNLESS actor has 'payments.record' AND records
                a settlement, OR actor has 'folio.discount' AND writes off with a reason.
balance < 0  →  refund flow (payment_type='refund') or carry to a future booking.
balance = 0  →  proceed.
```

The UI shows the balance in large type on the check-out screen, with the three resolution buttons. No silent check-outs with money outstanding — that is how hotels lose revenue.

---

## 13. Front desk operations and the night audit

### 13.1 Check-in

```
verify booking exists and status = 'confirmed'
 → verify arrival date (early arrival needs a manager override)
 → verify/complete guest record: ID document REQUIRED at check-in (spec §5.5)
 → verify assigned room: condition must be 'available' (not 'cleaning', not 'maintenance')
    · if the assigned room is dirty → offer to swap to any clean room of the same type
 → deposit rule check (§12.4)
 → TX: booking→checked_in, allocation→checked_in, room.condition→'occupied',
       housekeeping→'dirty', checked_in_at/by set, audit, outbox(welcome email)
```

### 13.2 Check-out

```
load folio → show charges, payments, balance
 → resolve balance (§12.6)
 → TX: trim allocation.end_date to today if departing early
       allocation→checked_out, booking→checked_out
       room.condition→'cleaning', housekeeping→'dirty'
       issue invoice (freeze lines), guest stay_count++, last_stay_date
       audit, outbox(invoice PDF render, thank-you email)
```

Housekeeping then flips `cleaning → available` once the room is cleaned and inspected (`housekeeping.update`), exactly as the spec describes.

### 13.3 ★ The night audit

A single job that runs daily at `settings.night_audit_hour` (default 03:00 Africa/Nairobi), plus a manual "Run night audit" button for managers. It is idempotent and safe to re-run.

```
FOR business_date D:
 1. NO-SHOWS      confirmed bookings with arrival_date = D-1 that never checked in
                  → status 'no_show', allocations 'released' from D forward,
                    post no-show fee per policy
 2. POST ROOM REVENUE
                  every booking_nights row with stay_date = D-1 and is_posted = false
                  belonging to a checked_in/checked_out booking
                  → insert folio_charges (type 'room') + tax/levy lines, mark is_posted
                    (the unique index folio_room_night_uq makes double-posting impossible)
 3. STATUS SWEEP  departures that never checked out → flag for manager review (never auto-close)
                  expired holds (held_until < now) → 'released'
 4. RECONCILE     recompute bookings.total_charges / total_paid; alert on any mismatch
 5. SNAPSHOT      compute and upsert daily_stats for D-1:
                    rooms_sold, occupancy_pct, room_revenue, ADR, RevPAR,
                    arrivals, departures, in_house, no_shows, cancellations,
                    expenses_total, payments_total
 6. REPORT        queue the manager's daily summary email
```

**Why this matters commercially:** ADR and RevPAR computed live from transactional tables drift the moment someone voids a charge or moves a booking. Freezing them nightly is what every real PMS does, and it is what turns "a booking app" into "a hotel management system a GM will pay for."

```
occupancy_pct = rooms_sold / rooms_sellable × 100
ADR           = room_revenue / rooms_sold           (0 when rooms_sold = 0)
RevPAR        = room_revenue / rooms_sellable       ( = ADR × occupancy )
```

### 13.4 Housekeeping board

A grid of every room with its `condition` + `housekeeping` status and today's activity flag (Arrival / Departure / Stayover / Vacant), derived from the allocation ledger. One tap changes status. Updates broadcast over SSE so the front desk sees a room go clean in real time. This is the module the spec lists as a *future* enhancement — we get 80% of it free because `housekeeping_status` and the allocation ledger already exist.

---

## 14. Maintenance and expenses

### 14.1 Maintenance flow (spec §10, §15)

```
Reported → Pending → In Progress → Resolved → Closed
   │           │          │            │
   └───────────┴──────────┴────────────┴──▶ every transition writes a maintenance_updates row
```

- Any role may **report** (`maintenance.report`) — receptionists are the ones who see broken things.
- Manager/admin **assign** and **close**.
- `takes_room_offline = true` creates a `room_allocations` row with `kind='block'` covering the repair window. **The room becomes unbookable through the same constraint that stops double-booking** — no separate code path, no way to book a broken room. This is the payoff for D8.
- Closing an issue with `takes_room_offline` releases the block and sets the room to `cleaning`.

### 14.2 Expenses (spec §11, §12)

- Seeded with the spec's 11 categories (Appendix D).
- Optional `maintenance_issue_id` link. When present, the expense appears on the maintenance issue and feeds `maintenance_cost_view.actual_cost`.
- Receipt image upload → private R2 bucket.
- Optional approval: `recorded → approved | rejected`. Managers approve; a setting toggles whether approval is required above a threshold amount.
- Expenses are **never** mixed into revenue. Reports present them side by side (§18.3) but they live in separate tables with separate permissions, exactly as the spec demands.

### 14.3 The relationship the spec asked for

> *Broken Air Conditioner → Maintenance Issue Reported → Repair Approved → Repair Completed → Repair Cost Recorded as an Expense*

Implemented literally:
```
POST /v1/maintenance                    → issue MT-2026-0087, room 204, takes_room_offline=true
                                          ⇒ allocation block created, room unbookable
PATCH /v1/maintenance/{id}  status=in_progress, assigned_to='Cool Air Ltd'
POST /v1/expenses  { maintenanceIssueId: '…', categoryId: 'Maintenance and Repairs',
                     amount: '18500.00', receiptFileId: '…' }
PATCH /v1/maintenance/{id}  status=resolved  ⇒ block released, room → cleaning
GET  /v1/reports/maintenance-costs        ⇒ estimated vs actual, by room, by month
```

---

# PART IV — SURFACES

## 15. Services, events and background work

### 15.1 The service layer rule

> **A route handler is a translator between HTTP and a service call. It contains no business logic. Ever.**

The ERP's `sales/route.ts` was ~1,400 lines and orchestrated eight contexts. Ours are capped:

| Layer | Hard limit | Contains |
|---|---|---|
| `app/api/v1/**/route.ts` | **80 lines** (lint-enforced) | auth, permission, parse, call service, shape response |
| `modules/*/service.ts` | 400 lines per file, functions < 80 lines | business rules, transactions, orchestration |
| `modules/*/repository.ts` | no limit | SQL only. No `if` statements about business rules. |

### 15.2 The outbox

Side effects **never** run inside the write transaction. They are enqueued in the *same* transaction (so they cannot be lost, and cannot fire for a rolled-back booking) and executed by a worker.

```ts
// core/jobs/outbox.ts
export async function enqueue(tx: Tx, jobs: JobSpec[]): Promise<void>;

// core/jobs/worker.ts — runs in-process (MVP) or as a separate service [P2]
// Poll loop, every 2s:
UPDATE job_queue SET status='processing', locked_at=now(), locked_by=$worker, attempts=attempts+1
WHERE id IN (
  SELECT id FROM job_queue
  WHERE status='pending' AND run_after <= now()
  ORDER BY priority, id
  FOR UPDATE SKIP LOCKED            -- ← the whole reason we don't need Redis
  LIMIT 10
) RETURNING *;
```

- **Retries:** exponential backoff `2^attempts` minutes, up to `max_attempts` (default 5), then `dead`. A dead-letter list is visible in Settings → System.
- **Idempotency:** `dedupe_key` unique index means "send booking confirmation for BK-000412" can be enqueued twice and sent once.
- **Failure isolation:** a broken email provider cannot fail a booking. It fails a job.

### 15.3 The event catalogue

| Event | Emitted when | Synchronous effects (in the tx) | Async jobs |
|---|---|---|---|
| `booking.created` | booking confirmed | allocations, nights, initial charges, audit | confirmation email, availability broadcast |
| `booking.modified` | dates/rooms/rates changed | allocations updated, nights recomputed, audit | modification email, broadcast |
| `booking.cancelled` | cancel | allocations released, fee charge, audit | cancellation email, broadcast |
| `booking.checked_in` | check-in | statuses, room condition, audit | welcome email/SMS, housekeeping broadcast |
| `booking.checked_out` | check-out | statuses, invoice issued, audit | invoice PDF render, thank-you email, broadcast |
| `booking.no_show` | night audit | released, fee, audit | manager notification |
| `payment.recorded` | payment saved | totals recomputed, audit | receipt email, broadcast |
| `payment.reversed` | reversal | totals recomputed, audit | manager notification |
| `invoice.issued` | check-out / manual | lines frozen, audit | PDF render, email |
| `maintenance.reported` | issue created | block allocation if offline, audit | notify manager; notify housekeeping if urgent |
| `maintenance.resolved` | resolved | block released, room → cleaning | notify reporter |
| `expense.recorded` | expense saved | audit | notify manager if above approval threshold |
| `room.condition_changed` | any status change | audit | broadcast to housekeeping board |
| `nightaudit.completed` | job finishes | `daily_stats` upserted | manager daily summary email |

### 15.4 Scheduled jobs

Run by a cron caller hitting `POST /api/cron/{name}` with `Authorization: Bearer $CRON_SECRET` (the ERP's pattern, kept — it is simple and it works), or by the in-process scheduler when `JOB_WORKER_ENABLED`.

| Job | Schedule | Purpose |
|---|---|---|
| `night-audit` | 03:00 daily | §13.3 |
| `release-expired-holds` | every 5 min | `held_until < now()` → `released` **[P2]** |
| `arrival-reminders` | 09:00 daily | email guests arriving tomorrow **[P2]** |
| `reconcile-totals` | 04:00 daily | assert folio/payment caches match the ledger; alert on drift |
| `purge-rate-limits` | hourly | delete `rate_limit_attempts` older than 24h |
| `backup-verify` | 05:00 daily | confirm last night's DB backup exists and restores |

---

## 16. API contract

### 16.1 Global conventions

- **Base path:** `/api/v1`. Versioned from the first commit. [ERP-FIX]
- **Auth:** session cookie. No API keys in MVP.
- **Success envelope:** `{ "data": … }`, and for lists `{ "data": [...], "pagination": { page, pageSize, total, totalPages } }`. **Never a bare array** — the ERP mixed both and it broke clients. [ERP-FIX]
- **Errors:** RFC 9457 `application/problem+json`:
```json
{ "type": "https://hms.local/errors/room-unavailable",
  "title": "Room unavailable",
  "status": 409,
  "code": "ROOM_UNAVAILABLE",
  "detail": "Room 204 is already booked for 14–16 Sep 2026.",
  "instance": "/api/v1/bookings",
  "requestId": "01J9…",
  "errors": { "rooms.0.roomId": ["Not available for the selected dates"] } }
```
- **Pagination:** `?page=1&pageSize=25`, `pageSize` hard-capped at **100**. No `all=true` escape hatch — exports go through the export endpoint. [ERP-FIX]
- **Idempotency:** every `POST` that creates money or inventory accepts `Idempotency-Key`. Required on `POST /bookings` and `POST /payments`.
- **Correlation:** every response carries `X-Request-Id`, echoed into logs, `activity_logs.request_id` and Sentry.
- **Rate limits:** per-user, per-endpoint-class, DB-backed. `429` with `Retry-After`.

### 16.2 The mandatory route pipeline [ERP-DNA]

Every mutation route is exactly this shape. No exceptions, no clever shortcuts.

```ts
// app/api/v1/bookings/route.ts
export const POST = apiHandler(async (req, ctx) => {
  const actor = await requirePermission('bookings.create');        // 1. auth + 2. authorize
  const body  = await validateBody(req, createBookingSchema);      // 3. validate (lint-enforced)
  const idem  = ctx.idempotencyKey;                                // 4. idempotency
  const booking = await bookingService.createBooking({ ...body, idempotencyKey: idem }, actor);
  return created(booking, `/api/v1/bookings/${booking.id}`);       // 5. respond
});
```

`apiHandler` supplies: request id, structured logging, timing metric, `translateDbError`, problem-details serialisation, and a hard 15 s timeout.

### 16.3 Endpoint catalogue

**Auth** (Better Auth mounts `/api/auth/*`)
```
POST   /api/auth/sign-in/email
POST   /api/auth/sign-out
POST   /api/auth/forget-password        POST /api/auth/reset-password
POST   /api/auth/two-factor/*           GET  /api/auth/get-session
```

**Rooms & inventory**
```
GET    /v1/room-types                       ?active=&search=
POST   /v1/room-types                       roomtypes.create
GET    /v1/room-types/{id}
PATCH  /v1/room-types/{id}                  roomtypes.update
DELETE /v1/room-types/{id}                  roomtypes.delete   (soft, blocked if rooms exist)
GET    /v1/rooms                            ?typeId=&condition=&floor=&search=&page=
POST   /v1/rooms                            rooms.create
PATCH  /v1/rooms/{id}                       rooms.update
PATCH  /v1/rooms/{id}/condition             rooms.change_condition  { condition, note }
DELETE /v1/rooms/{id}                       rooms.delete (soft, blocked if future allocations)
GET    /v1/rate-rules                       rates.read           [P2]
POST   /v1/rate-rules                       rates.update         [P2]
```

**Availability**
```
GET    /v1/availability/rooms      ?arrival=&departure=&roomTypeId=&occupancy=&excludeBookingId=
GET    /v1/availability/calendar   ?from=&to=&roomTypeId=          → per-type per-day counts
GET    /v1/availability/tape       ?from=&to=                      → per-ROOM per-day allocations
POST   /v1/availability/quote      { roomTypeId, arrival, departure, adults, children }
```

**Guests**
```
GET    /v1/guests                  ?search=&page=      (trigram name + phone + ID)
POST   /v1/guests                  guests.create
GET    /v1/guests/{id}             includes stay history + lifetime value
PATCH  /v1/guests/{id}             guests.update
POST   /v1/guests/{id}/documents   guests.update       multipart → private bucket
GET    /v1/guests/{id}/documents/{docId}/url   guests.view_documents → 5-min signed URL
POST   /v1/guests/{id}/blacklist   guests.blacklist    { reason }
POST   /v1/guests/merge            guests.merge        { keepId, mergeIds[] }
```

**Bookings**
```
GET    /v1/bookings                ?status=&from=&to=&guestId=&roomId=&q=&page=
POST   /v1/bookings                bookings.create   [Idempotency-Key REQUIRED]
GET    /v1/bookings/{id}           full aggregate: allocations, nights, folio, payments, invoice
PATCH  /v1/bookings/{id}           bookings.update   (guest details, notes, occupancy)
POST   /v1/bookings/{id}/rooms     bookings.update   add a room to the booking
PATCH  /v1/bookings/{id}/rooms/{allocationId}   bookings.move_room | extend | shorten
POST   /v1/bookings/{id}/cancel    bookings.cancel   { reason, waiveFee? }
POST   /v1/bookings/{id}/check-in  frontdesk.check_in  { roomAssignments[], idDocument }
POST   /v1/bookings/{id}/check-out frontdesk.check_out { settlement? }
GET    /v1/bookings/{id}/folio
POST   /v1/bookings/{id}/charges   folio.post_charge  { type, description, qty, unitAmount }
POST   /v1/bookings/{id}/charges/{chargeId}/void   folio.void_charge { reason }
```

**Front desk**
```
GET    /v1/frontdesk/today         arrivals, departures, in-house, vacant, occupancy at a glance
GET    /v1/frontdesk/arrivals      ?date=
GET    /v1/frontdesk/departures    ?date=
GET    /v1/frontdesk/in-house
POST   /v1/frontdesk/walk-in       creates guest + booking + check-in in ONE transaction
GET    /v1/housekeeping/board      ?date=
PATCH  /v1/housekeeping/rooms/{id} housekeeping.update { housekeeping, condition? }
```

**Money**
```
GET    /v1/payments                ?bookingId=&method=&from=&to=&page=
POST   /v1/payments                payments.record  [Idempotency-Key REQUIRED]
POST   /v1/payments/{id}/reverse   payments.reverse { reason }
GET    /v1/payments/{id}/receipt   → HTML/PDF
GET    /v1/invoices                ?status=&from=&to=
POST   /v1/invoices                invoices.issue   { bookingId }
GET    /v1/invoices/{id}
GET    /v1/invoices/{id}/pdf       → signed URL (renders on demand if the job hasn't finished)
POST   /v1/invoices/{id}/void      invoices.void    { reason }
```

**Maintenance & expenses**
```
GET    /v1/maintenance             ?status=&priority=&roomId=&page=
POST   /v1/maintenance             maintenance.report
GET    /v1/maintenance/{id}        includes updates timeline + linked expenses + cost view
PATCH  /v1/maintenance/{id}        maintenance.update | assign | close
POST   /v1/maintenance/{id}/updates  maintenance.update { note, status?, fileIds[] }
GET    /v1/expense-categories      POST /v1/expense-categories  (admin)
GET    /v1/expenses                ?categoryId=&from=&to=&status=&maintenanceIssueId=&page=
POST   /v1/expenses                expenses.create
PATCH  /v1/expenses/{id}           expenses.update
POST   /v1/expenses/{id}/approve   expenses.approve { approved: bool, reason? }
```

**Reports, admin, system**
```
GET    /v1/reports/occupancy         ?from=&to=&groupBy=day|week|month
GET    /v1/reports/revenue           ?from=&to=&breakdown=roomType|source|method
GET    /v1/reports/arrivals-departures ?date=
GET    /v1/reports/outstanding-balances
GET    /v1/reports/expenses          ?from=&to=&groupBy=category
GET    /v1/reports/maintenance-costs ?from=&to=
GET    /v1/reports/profit-summary    ?from=&to=      revenue − expenses
GET    /v1/reports/{name}/export     ?format=xlsx|csv    → queued job → signed URL
GET    /v1/dashboard                 role-shaped payload for the landing screen
GET    /v1/users  POST /v1/users  PATCH /v1/users/{id}  POST /v1/users/{id}/reset-password
GET    /v1/settings  PATCH /v1/settings
GET    /v1/activity-logs             ?entityType=&entityId=&actorId=&action=&from=&to=&page=
GET    /v1/notifications             PATCH /v1/notifications/{id}/read
GET    /v1/events                    SSE stream (§17.6)
GET    /api/health                   liveness    GET /api/ready  readiness (DB + migrations)
POST   /api/cron/{job}               Bearer CRON_SECRET
```

### 16.4 Validation

```ts
// core/api/validate.ts
export async function validateBody<T extends ZodType>(req: Request, schema: T): Promise<z.infer<T>>;
export function validateQuery<T extends ZodType>(url: URL, schema: T): z.infer<T>;
```

Raw `request.json()` is banned by the custom ESLint rule `hms/no-direct-request-json` — the ERP's single best process invention, copied verbatim. [ERP-DNA]

```ts
// modules/bookings/validation.ts
export const createBookingSchema = z.object({
  guest: z.union([
    z.object({ guestId: z.uuid() }),
    z.object({
      fullName: z.string().min(2).max(200),
      phone: z.string().min(7).max(20).optional(),
      email: z.email().optional(),
      idType: z.enum(ID_DOCUMENT_TYPES).optional(),
      idNumber: z.string().max(50).optional(),
      nationality: z.string().length(2).optional(),
    }),
  ]),
  rooms: z.array(z.object({
    roomId: z.uuid(),
    arrival: dateOnly(),
    departure: dateOnly(),
    adults: z.number().int().min(1).max(20),
    children: z.number().int().min(0).max(20).default(0),
    overrideRate: money().optional(),       // requires bookings.override_rate
  })).min(1).max(20),
  source: z.enum(BOOKING_SOURCES).default('front_desk'),
  specialRequests: z.string().max(2000).optional(),
})
.refine(b => b.rooms.every(r => r.departure > r.arrival), 'Departure must be after arrival')
.refine(b => b.rooms.every(r => nightCount(r.arrival, r.departure) <= 365), 'Stay too long');
```

The same schemas power react-hook-form on the client — one definition, both sides. [ERP-FIX: the ERP validated only server-side and hand-wrote client forms.]

---

## 17. Frontend architecture

### 17.1 Principles

1. **Server Components by default.** Pages fetch through the service layer server-side and stream. `'use client'` only for interactivity. [ERP-DNA]
2. **TanStack Query owns all client-side server state.** Every mutation invalidates specific query keys. No 15-second polling as a correctness mechanism. [ERP-FIX]
3. **One typed API client** generated from the Zod schemas — no inline `fetch` scattered through components. [ERP-FIX]
4. **The design system is vendored.** shadcn/ui components live in `components/ui` and we own them, exactly as the ERP did with its 44 primitives. [ERP-DNA]
5. **Optimistic UI is forbidden for anything that can fail on a constraint.** A booking either succeeded in Postgres or it did not. Show a spinner, then the truth.

### 17.2 Screen inventory

| Route | Primary role | Notes |
|---|---|---|
| `/login` | all | + forgot/reset, forced password change on first login |
| `/dashboard` | all (role-shaped) | KPIs, today's numbers, alerts |
| `/front-desk` | receptionist | **The default landing page for receptionists.** Arrivals / Departures / In-house / Vacant tabs, one-click check-in & check-out |
| `/availability` | receptionist, manager | **The tape chart** (§17.4) |
| `/bookings` · `/bookings/[id]` · `/bookings/new` | receptionist | List + full aggregate view + wizard |
| `/guests` · `/guests/[id]` | receptionist | Search-first; profile shows stay history & lifetime value |
| `/housekeeping` | all staff | Room status board, tap to change |
| `/rooms` · `/rooms/types` · `/rooms/rates` | manager, admin | Configuration |
| `/maintenance` · `/maintenance/[id]` | all (report), manager (manage) | Kanban by status + detail timeline |
| `/expenses` · `/expenses/categories` | manager, admin | Table + approval queue |
| `/finance/payments` · `/finance/invoices` · `/finance/invoices/[id]` | manager, admin (receptionist: record only) | |
| `/reports/*` | manager, admin | Occupancy, revenue, expenses, maintenance, profit |
| `/settings/hotel` · `/users` · `/settings/system` · `/audit` | admin | |

### 17.3 Role-shaped landing pages

| Role | Lands on | Dashboard shows |
|---|---|---|
| Receptionist | `/front-desk` | Today's arrivals/departures, rooms ready, in-house count, quick "New booking" |
| Manager | `/dashboard` | Occupancy %, ADR, RevPAR, revenue vs expenses, open maintenance, outstanding balances |
| Admin | `/dashboard` | Manager view + user activity, system health, dead jobs, backup status |

### 17.4 ★ The tape chart

The screen that sells the product. Rooms down the left, dates across the top, allocation bars in the grid.

```
              Mon 14  Tue 15  Wed 16  Thu 17  Fri 18  Sat 19
 101 Single   ▓▓▓▓ J. Kamau ▓▓▓▓│        │███ Walk-in ███│
 102 Single           │░░ HELD ░░│        │               │
 103 Double   ▓▓▓ A. Otieno ▓▓▓▓▓▓▓▓▓▓▓▓▓│               │
 104 Deluxe   ▒▒▒▒▒ MAINTENANCE — MT-0087 ▒▒▒▒▒│          │
 201 Suite            │        │        │███ Corporate ███
```

Requirements:
- Server-rendered from `GET /v1/availability/tape` in a single query; **no N+1**.
- Colour by booking status; hatched for maintenance blocks; a "today" rule line.
- **Click an empty cell → new booking pre-filled** with that room and date.
- **Drag across cells → date range selection.** Drag an existing bar → room move or date shift, which calls the same guarded endpoint and shows a clear `409` toast if the target is taken.
- Horizontal virtualisation for 90-day windows; sticky room column.
- Live-updates over SSE when anyone else books.

Build this in Phase 4 and demo it first. It is the difference between "a database with forms" and a product.

### 17.5 Query key conventions

```ts
['bookings', { filters }]                 ['booking', id]
['availability', { arrival, departure }]  ['tape', { from, to }]
['guests', { search }]                    ['guest', id]
['frontdesk', 'today']                    ['housekeeping', 'board', date]
['folio', bookingId]                      ['payments', { bookingId }]
['maintenance', { filters }]              ['expenses', { filters }]
['reports', name, params]                 ['dashboard', role]
```
A booking mutation invalidates: `['bookings']`, `['booking', id]`, `['availability']`, `['tape']`, `['frontdesk','today']`, `['dashboard']`. This invalidation map is written down in `hooks/queryKeys.ts` and kept honest by a test.

### 17.6 Real-time (SSE + LISTEN/NOTIFY)

```
DB trigger on room_allocations / rooms / bookings
   → pg_notify('hms_events', json)
      → one LISTEN connection in the Node process
         → in-memory SSE hub
            → GET /v1/events  (EventSource, authenticated by session cookie)
               → client invalidates the matching TanStack Query keys
```

- Events carry **no payload data**, only `{ type, entity, id }`. The client refetches through the normal, permission-checked API. This means the SSE stream can never leak data a user is not allowed to see.
- Heartbeat comment every 25 s to defeat proxy timeouts. [ERP-DNA]
- Connection cap of 5 per user, 100 total. [ERP-DNA — and it fixes the ERP's uncapped SSE, which its own audit flagged as a DoS surface.]
- The ERP built `pg_notify` triggers and never connected them. **We connect them.** [ERP-FIX]

### 17.7 Files

- **Two R2 buckets**: `hms-public` (room/room-type photos, hotel logo — CDN-served) and `hms-private` (guest ID scans, expense receipts, invoice PDFs, maintenance photos).
- Private objects are **never** exposed by URL. Access goes through `GET /v1/files/{id}/url`, which checks permission and returns a **5-minute pre-signed URL**. [ERP-FIX — the ERP's public-CDN-only model made guest documents readable by anyone with the link.]
- Keys: `private/<entity>/<yyyy>/<mm>/<uuid>.<ext>`.
- Uploads: server-side validation of MIME + magic bytes + size (10 MB images, 20 MB PDFs), `sharp` thumbnails for images. [ERP-DNA]
- Deleting an entity soft-deletes its files; a monthly job purges objects for records deleted > 90 days ago.

---

## 18. Reporting and analytics

### 18.1 Read from `daily_stats`, not from live tables

Every trend report (occupancy, ADR, RevPAR, revenue by day) reads `daily_stats`, which the night audit froze. Only *today* is computed live. This is the single biggest performance decision in the reporting layer and it directly fixes the ERP's "global search / reports without cached aggregates" finding.

### 18.2 Report catalogue (spec §13, complete)

| Report | Source | Key columns |
|---|---|---|
| Daily / weekly / monthly bookings | `bookings` + `daily_stats` | count, nights, value, by source |
| Room occupancy | `daily_stats` | occupancy %, rooms sold, ADR, RevPAR, trend chart |
| Available vs occupied rooms | live allocation ledger | as-of-date snapshot |
| Arrivals & departures | `bookings` | date, guest, room, balance, ETA |
| Revenue | `folio_charges` + `daily_stats` | by day / room type / booking source |
| Payments & outstanding balances | `payments`, `bookings.balance` | aged balance, by method (cash vs M-Pesa vs card) |
| Expenses by category | `expenses` | amount, count, % of total, MoM change |
| Maintenance issues | `maintenance_issues` | open/closed, by priority, mean time to resolve |
| Maintenance costs | `maintenance_cost_view` | estimated vs actual, by room, by category |
| Revenue vs expense | joined by month | with a bar chart |
| Estimated profit summary | revenue − expenses | with margin % |

### 18.3 Exports

`GET /v1/reports/{name}/export?format=xlsx` enqueues a job, renders with `exceljs`, stores to private R2, returns a signed URL and an in-app notification when ready. **Never synchronous.** [ERP-FIX — the ERP generated large exports inside the request and risked timeouts.]

### 18.4 Dashboard payload

One endpoint, one query per card, all bounded:
```
occupancy today · rooms sold / sellable · arrivals · departures · in-house
revenue today / MTD · payments today by method · outstanding balance total
open maintenance by priority · expenses MTD · profit MTD
7-day occupancy sparkline (from daily_stats)
```

---

# PART V — CROSS-CUTTING

## 19. Enforced engineering rules

### 19.1 Custom ESLint rules (the guardrails that make the architecture real)

Folders do not enforce boundaries. Lint rules do. The ERP had folders and no rules, and its contexts bled into each other.

| Rule | Blocks | Fixes ERP finding |
|---|---|---|
| `hms/no-direct-request-json` | `request.json()` outside `core/api` | copied verbatim [ERP-DNA] |
| `hms/no-raw-db` | importing `pg`/drizzle client outside `core/db` | the **critical** unscoped `db` export |
| `hms/no-cross-module-repository` | `modules/a/**` importing `modules/b/repository` or `modules/b/schema` | fat cross-context handlers |
| `hms/route-handler-max-lines` | route files over 80 lines | the 1,400-line handler |
| `hms/no-money-number` | arithmetic operators on values typed `Money` | money-as-text bugs |
| `hms/no-side-effects-in-tx` | `mail.*`, `fetch(`, `r2.*`, `renderPdf` inside a `withTx` callback | inline side effects in the write path |
| `hms/require-permission` | an exported `POST/PATCH/PUT/DELETE` in `app/api/v1` with no `requirePermission` call | missing authorization |
| `hms/no-client-db` | `core/db` imported from a `'use client'` file or `components/**` | leaking server code to the bundle |

`pnpm run ci` = `lint && typecheck && test && build` (note: `pnpm ci` on its own is pnpm's built-in install command, so the script must be invoked as `pnpm run ci`). A red rule fails the PR. No overrides without an ADR.

### 19.2 Definition of Done for any feature

- [ ] Zod schema for every input, shared with the form
- [ ] `requirePermission` on every mutation, permission added to the matrix
- [ ] Service function under 80 lines; no SQL in the service; no business rules in the repository
- [ ] Any invariant that matters expressed as a DB constraint, not an `if`
- [ ] Audit log entry with a human-readable summary
- [ ] Side effects enqueued, never inline
- [ ] Unit tests for the rules; integration test against a real Postgres; Playwright test if it is a user journey
- [ ] Empty state, loading state, error state, and permission-denied state all designed
- [ ] Works on a 1366×768 front-desk screen and on a tablet

---

## 20. Security

The ERP scored 7.5/10 with three actionable debts. All three are closed here by design.

| ERP finding | Severity | Closed by |
|---|---|---|
| Unscoped `db` export bypassing RLS | **CRITICAL** | Pool not exported; lint-enforced (§8.1) |
| No authorization on file reads (public CDN) | HIGH | Private buckets + signed URLs (§17.7) |
| Admin pool silently falling back to the runtime URL | HIGH | Fail-closed env parsing; process refuses to boot (§8.4) |
| No MFA | MED | Better Auth `twoFactor`, mandatory for admins (§9.1) |
| No per-endpoint rate limiting | MED | DB-backed limiter on every mutation class (§20.4) |
| Money in text, client-parsed | MED | `NUMERIC` + server-side re-pricing (§12.1) |
| Weak JWT revocation | MED | Real DB sessions (§9.1) |
| MD5 webhook verification | MED | No PayHere. M-Pesa Daraja validated properly when added |
| Uncapped SSE connections | MED | Per-user and global caps (§17.6) |

### 20.1 Application security checklist

- [ ] Argon2id hashing; password policy: min 10 chars, breach-list check on set
- [ ] Forced password change on first login; admin-issued temporary passwords expire in 48 h
- [ ] Session cookies: `httpOnly`, `secure`, `sameSite=lax`; 12-hour expiry
- [ ] Password change revokes all other sessions
- [ ] CSRF: Better Auth's token + `sameSite`; all mutations are non-GET
- [ ] Security headers in `proxy.ts`: HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, and a CSP without `unsafe-eval` [ERP-DNA]
- [ ] **Route protection is checked in the handler, not only in `proxy.ts`.** Next.js middleware-only auth has been bypassable before (CVE-2025-29927); `proxy.ts` is a UX redirect, `requirePermission` is the gate
- [ ] All queries parameterised via Drizzle; zero string-concatenated SQL
- [ ] File uploads: MIME + magic-byte validation, size caps, no executable types, stored outside the web root
- [ ] Guest ID documents and expense receipts are private-bucket only, signed-URL access, and every access is audited
- [ ] Rate limits: login 5/15 min; mutations 60/min/user; reports 20/min/user; exports 5/hour/user
- [ ] Dependency scanning in CI (`pnpm audit`, Dependabot)
- [ ] Secrets only in the platform's secret store; `.env` never committed; `.env.example` is exhaustive

### 20.2 Data protection (Kenya DPA 2019 / GDPR-shaped)

- Guest ID numbers and documents are personal data: private storage, permission-gated, access-logged.
- Retention setting for guest documents (default: purge scans 24 months after last stay; keep financial records 7 years).
- Right to erasure: a guest can be anonymised (name/phone/email/ID replaced with tokens) while **financial records and their snapshots survive** — that is why invoices freeze their own bill-to fields.
- Backups are encrypted at rest.
- The privacy posture is documented in `docs/data-protection.md` and handed to the client at go-live.

### 20.3 Audit log (spec §14, exceeded)

Everything in the spec's list is logged, plus every state transition, permission change, setting change, file access and login. Entries are append-only (§6.5.8), carry actor snapshots so they survive user deletion, and record field-level diffs plus the request id. Admins browse `/audit` with filters by entity, actor, action and date. Log entries are **never** editable through the application or by the application's DB role.

### 20.4 Rate limiting

```sql
-- DB-backed, multi-instance safe, no Redis. [ERP-DNA]
SELECT count(*) FROM rate_limit_attempts
WHERE bucket = $1 AND attempted_at > now() - ($2 || ' seconds')::interval;
```
Buckets: `login:<email>`, `login:ip:<ip>`, `mutate:<userId>`, `report:<userId>`, `export:<userId>`. Swept hourly.

---

## 21. Observability

The ERP scored **5.5** here — Sentry and nothing else. Fixed cheaply:

| Signal | Tool | Detail |
|---|---|---|
| Errors | Sentry | server + client, source maps uploaded at build [ERP-DNA] |
| Logs | `pino` → JSON to stdout | every line carries `requestId`, `userId`, `route`, `durationMs` [ERP-FIX] |
| Correlation | `X-Request-Id` | request → log → `activity_logs.request_id` → Sentry tag |
| Metrics | `/api/metrics` (Prometheus text) | `booking_confirm_duration_ms`, `booking_conflicts_total`, `db_query_count_per_request`, `job_queue_depth`, `job_failures_total`, `sse_connections`, `night_audit_duration_ms` |
| Health | `/api/health` (liveness) · `/api/ready` (DB reachable + migrations applied) | |
| Alerts | email/SMS to the ops owner | night audit failed · job in `dead` · reconciliation mismatch · error rate > 1%/5 min · backup missing |
| Query budget | dev middleware | logs a warning when a request exceeds **10 queries** and fails the test suite over 15 [ERP-FIX: N+1] |

**The four alerts that matter to a hotelier:** night audit did not run; a booking conflict spiked (someone is fighting the system); the daily backup is missing; folio totals do not reconcile.

---

## 22. Testing strategy

The ERP had excellent Playwright and k6 assets and **two** backend unit tests against ~568 routes. We invert that ratio where it counts.

### 22.1 The testing pyramid

| Level | Tool | Target | Scope |
|---|---|---|---|
| Unit (pure) | Vitest | **95%** on `modules/*/service` rules, state machines, `core/money`, `core/dates` | no DB |
| Integration | Vitest + real Postgres (Docker/Testcontainers) | **90%** on repositories + transactions | real constraints |
| E2E | Playwright | every critical journey | real browser |
| Concurrency/load | k6 | booking engine | 50 VUs |

**Global coverage gate: 80%, with `modules/bookings`, `modules/availability` and `modules/billing` gated at 95%.** Unlike the ERP's aspirational 70% that was never met, this gate is enforced from Phase 1, when the codebase is small enough to make it painless.

### 22.2 Gold-standard tests (must exist before the booking module is considered done)

```
✓ books a room for 2 nights, occupying the correct 2 nights and freeing the departure day
✓ rejects an overlapping booking for the same room               → 409 ROOM_UNAVAILABLE
✓ ALLOWS a new arrival on the previous guest's departure day     ← the '[)' correctness test
✓ rejects a booking over a maintenance block
✓ 50 concurrent identical bookings → exactly 1 succeeds          ← the money test
✓ the same Idempotency-Key twice → one booking, two 201s with the same id
✓ cancel frees the nights immediately for rebooking
✓ early check-out trims the allocation and frees tonight
✓ extend-stay fails when the next guest is already booked, with the blocking date named
✓ room move to an occupied room fails and leaves the original allocation intact
✓ a rolled-back booking transaction leaves no allocation, no night, no charge, no job
✓ night audit is idempotent: running it twice posts each night exactly once
✓ night audit ADR/RevPAR match a hand-computed fixture to the cent
✓ folio totals always equal SUM(non-voided charges); balance equals charges − payments
✓ voiding a charge recomputes totals and leaves the original row visible
✓ a receptionist cannot reverse a payment, override a rate, or read financial reports (403)
✓ a disabled user's existing session stops working on the very next request
✓ guest document URLs are signed, expire, and are refused without permission
```

### 22.3 Playwright projects [ERP-DNA]

`smoke` (login, dashboard loads) · `critical` (book → check-in → charge → pay → check-out → invoice) · `workflows` (maintenance→expense; cancellation; walk-in; room move) · `permissions` (all three roles against all routes) · `mobile` (tablet viewport for housekeeping).

### 22.4 Load tests

`booking-concurrency.js` (the hard gate, §11.3) · `availability-search.js` (p95 < 30 ms at 500 rooms × 2 years of data) · `api-baseline.js` (list endpoints under 20 concurrent users) · `tape-chart.js` (90-day window render).

### 22.5 Seed data for testing and demos

`scripts/seed-demo.ts` builds a believable hotel: 1 property, 4 room types, 40 rooms, 200 guests, 18 months of bookings with realistic seasonality, payments in every method, 60 maintenance issues, 400 expenses, and a fully populated `daily_stats`. **This is also the demo dataset** — a sales demo with three fake bookings is why systems don't sell.

---

## 23. Performance budgets

Measured with k6 + the query-count middleware. Every number is a CI gate, not an aspiration.

| Operation | Budget (p95) | Query budget |
|---|---|---|
| Availability search (single range) | **< 30 ms** server | 1 |
| Tape chart, 30-day × 100-room window | **< 120 ms** | 2 |
| Booking confirmation transaction | **< 250 ms** | ≤ 12 |
| Check-in / check-out | < 200 ms | ≤ 10 |
| Record a payment | < 150 ms | ≤ 6 |
| List endpoints (25 rows) | < 150 ms | ≤ 3 |
| Dashboard | < 400 ms | ≤ 8 |
| Report from `daily_stats` (12 months) | < 200 ms | 1 |
| Night audit (100 rooms) | < 30 s total | — |
| Concurrent booking confirmations | > 50/s with 0 errors | — |
| First contentful paint, front desk | < 1.5 s on hotel wifi | — |

**Hard rule: no request may issue more than 15 queries.** Exceeding it fails the test run. This is the discipline the ERP lacked (its sale route ran a `findFirst` per cart item inside the transaction).

**Deliberately absent:** Redis. At one hotel — realistically under 200 rooms, under 50 concurrent staff sessions — Postgres with correct indexes beats every one of these budgets with room to spare. `core/cache` exists as an interface with an in-process LRU behind it; swapping in Redis is a one-file change if a second property or an online booking portal ever changes the traffic shape.

---

# PART VI — DELIVERY

## 24. Deployment and operations

### 24.1 Topology

```
                    Internet
                       │  (HTTPS, custom domain)
                 Cloudflare  ── caches /  public bucket assets
                       │
          ┌────────────▼────────────┐
          │  Railway / Docker VPS   │
          │  ┌───────────────────┐  │
          │  │  web  (Next.js)   │  │  ← app + API + SSE + in-process job worker
          │  │  next start       │  │     healthcheck: /api/ready
          │  └───────────────────┘  │
          │  ┌───────────────────┐  │
          │  │  cron (scheduler) │  │  ← curls /api/cron/* with CRON_SECRET
          │  └───────────────────┘  │
          └────────────┬────────────┘
                       │
        ┌──────────────▼──────────────┐        ┌──────────────────────┐
        │ PostgreSQL 18 (managed)     │        │ Cloudflare R2        │
        │  hms_app     (runtime)      │        │  hms-public (CDN)    │
        │  hms_migrator(deploy only)  │        │  hms-private(signed) │
        │  PITR + nightly dumps       │        └──────────────────────┘
        └─────────────────────────────┘
```

**When to split the worker into its own service:** when night audit exceeds 60 s, or when a second property is added. Not before. [ERP-DNA — the ERP's single-service deploy was the right call and its audit said so.]

### 24.2 Environments

| Env | Purpose | Data |
|---|---|---|
| local | development | `docker-compose` Postgres + seeded demo data |
| staging | UAT with the client | anonymised copy of production |
| production | live | real |

### 24.3 Migrations

- Numbered, forward-only, generated by `drizzle-kit` then **hand-reviewed** — never blindly applied.
- Run at deploy by `hms_migrator`, gated by `REQUIRE_MIGRATIONS=true`; the app refuses to serve if migrations are pending. [ERP-DNA]
- Every migration is reviewed for lock impact. `CREATE INDEX CONCURRENTLY` once the table has real data.
- **No migration ever adds a table without its constraints.** There will be no `fix_constraints_00xx.sql`. [ERP-FIX]

### 24.4 Backup & recovery (spec §19)

| Control | Detail |
|---|---|
| PITR | Managed Postgres continuous archiving, 7-day window |
| Nightly logical dump | `pg_dump` → private R2, 30 daily + 12 monthly retained, encrypted |
| Restore drill | **Monthly**, into staging, timed and recorded. A backup that has never been restored is not a backup. |
| Verification job | `backup-verify` alerts if last night's dump is missing or under-sized |
| RPO / RTO | RPO ≤ 5 min (PITR) · RTO ≤ 1 h |
| Object storage | R2 versioning enabled on the private bucket |

### 24.5 Go-live runbook

1. Provision Postgres 18 + both DB roles; enable `btree_gist`, `pg_trgm`, `pgcrypto`.
2. Set every env var; boot once and confirm the config parser passes.
3. Run migrations; verify `/api/ready`.
4. `scripts/create-admin.ts` → the client's first admin; force 2FA enrolment.
5. Configure the property: name, tax PIN, currency, timezone, check-in/out times, VAT/levy rates, invoice + booking prefixes, deposit and cancellation policy.
6. Load real inventory: room types, rates, rooms. Import existing guests from CSV if any.
7. **Load any in-flight bookings** — the hotel does not stop trading on cutover.
8. Run the night audit manually once to establish `daily_stats` from the cutover date.
9. Train: receptionists on `/front-desk` + tape chart (2 h), manager on reports + expenses (1 h), admin on users + settings (1 h).
10. Run parallel with the old process for 7 days, reconciling revenue daily.
11. Verify the first automatic night audit and the first automatic backup.

### 24.6 Support model

- Error budget: 99.5% monthly availability during 06:00–23:00 local.
- On-call for: night audit failure, booking conflicts spike, payment recording failure, backup failure.
- `docs/runbooks/`: night-audit-failed, restore-from-backup, stuck-job, room-shows-wrong-status, guest-charged-twice.

---

## 25. Build plan

Sized for a small, focused team using this document as the spec. Each phase ends with something demonstrable.

| Phase | Days | Deliverable | Gate to pass |
|---|---|---|---|
| **0 — Foundation** | 3 | Repo, TS strict, Tailwind, shadcn, ESLint custom rules, `core/db`, `core/config`, `core/api`, `core/money`, `core/dates`, CI, Docker Postgres | `pnpm run ci` green; custom rules actually fail a bad file |
| **1 — Identity** | 4 | Better Auth, users CRUD, permission matrix, `requirePermission`, login/reset/forced-change, 2FA, audit writer, rate limiting | Permission tests pass for all three roles |
| **2 — Inventory** | 4 | Property + settings, room types, rooms, condition/housekeeping, photos, `rate_rules` schema | Manager configures a 40-room hotel end to end |
| **3 — Guests** | 3 | Guest CRUD, trigram search, dedupe, documents to private storage, signed URLs | Search 200 guests in < 100 ms; docs are not publicly readable |
| **4 — ★ Booking engine** | **10** | Allocation ledger + exclusion constraint, availability search & calendar, quoting, booking lifecycle, cancel, move/extend/shorten, **tape chart**, booking wizard | **The 50-VU concurrency test passes.** All gold-standard tests pass. |
| **5 — Front desk** | 5 | Today board, check-in, check-out, walk-in, room assignment, housekeeping board, SSE live updates | Full journey in Playwright |
| **6 — Money** | 7 | Folio, charges, void, payments (all methods), reversal, receipts, invoices with frozen snapshots, PDFs via jobs, balance policy | Money reconciles to the cent under the fuzz test |
| **7 — Night audit** | 3 | The job, `daily_stats`, no-show handling, reconciliation, manager summary email | Idempotency + hand-computed ADR/RevPAR fixture |
| **8 — Maintenance & expenses** | 4 | Issues + updates + offline blocks, categories, expenses, approval, maintenance↔expense link | The spec's air-conditioner scenario, end to end |
| **9 — Reporting** | 5 | All 11 reports, dashboards per role, Excel/CSV export jobs, charts | Every spec §13 report renders on the demo dataset |
| **10 — Hardening** | 5 | Observability, metrics, alerts, security checklist, empty/error states, mobile/tablet passes, load tests, docs | Security checklist 100%; budgets met |
| **11 — UAT & go-live** | 5 | Staging with the client, training, data migration, cutover, parallel run | §24.5 runbook completed |
| | **≈ 58 working days** | | |

**Sequencing rules:**
- Phase 4 does not start until Phases 0–1 are gated. Building the booking engine on a shaky foundation is how a project becomes a rewrite.
- The tape chart is demoed to the client at the end of Phase 4. Feedback there is worth more than feedback at the end.
- Reporting (Phase 9) is fast only because `daily_stats` was designed in Phase 7. Do not reorder.

### 25.1 Parallelisation

With two developers: one takes the vertical spine (0 → 1 → 4 → 5 → 7), the other takes the breadth (2 → 3 → 6 → 8 → 9). They meet at Phase 6, which depends on both bookings and inventory.

---

## 26. Definition of Done for the product

The system ships when every line is true:

**Correctness**
- [ ] The 50-VU concurrency test yields exactly one booking, zero 500s
- [ ] A guest can arrive on the day a previous guest departs
- [ ] A room under maintenance cannot be booked, through any path
- [ ] Night audit is idempotent and its ADR/RevPAR match a hand-computed fixture
- [ ] Folio totals reconcile to the payment ledger after 10,000 fuzzed operations
- [ ] No financial record can be deleted by the application role

**Completeness (against the functional spec)**
- [ ] All 3 roles with the exact permissions in spec §4
- [ ] All 11 core modules in spec §5–§14
- [ ] All 11 reports in spec §13
- [ ] All 6 audit event types in spec §14, and more
- [ ] All 11 expense categories in spec §11 seeded
- [ ] All 4 maintenance priorities and 5 statuses
- [ ] The full workflow in spec §15 walkable in the UI without a dead end

**Quality**
- [ ] Coverage: 80% global, 95% on bookings/availability/billing
- [ ] All performance budgets met (§23)
- [ ] Security checklist 100% (§20.1)
- [ ] Zero `any` in `modules/**`; zero ESLint errors
- [ ] Every screen has loading, empty, error and no-permission states
- [ ] Runbooks written; a restore drill has actually been performed

**Handover**
- [ ] Admin/manager/receptionist user guides
- [ ] This document updated to match the built system
- [ ] Client owns the DB credentials, R2 buckets, domain and repo access

---

## 27. Roadmap after v1

Ordered by (value ÷ effort). Every one of these was anticipated in the schema; none requires a rewrite.

| # | Feature | Enabled by | Effort |
|---|---|---|---|
| 1 | **M-Pesa Daraja STK Push + C2B reconciliation** | `payments.status='pending'` + `reference` unique index already exist | M |
| 2 | **Email & SMS notifications** (confirmation, reminder, receipt) | outbox + job queue already exist | S |
| 3 | **Seasonal & day-of-week rates** | `rate_rules` table already exists, UI only | S |
| 4 | **Online guest booking portal** | availability API + `held` allocation status + `held_until` already exist | L |
| 5 | **Full housekeeping module** (assignments, checklists, mobile) | `housekeeping_status` + board already exist | M |
| 6 | **Multi-branch / multi-property** | `property_id` is already on every table | M |
| 7 | **Restaurant / room service POS posting to the folio** | `folio_charges` accepts any charge type | L |
| 8 | **Inventory & supplier management** | new module, expenses already model spend | L |
| 9 | **Channel manager / OTA sync** | allocation ledger is the correct integration point; needs idempotency (present) | XL |
| 10 | **Advanced analytics** (pace, pickup, forecast) | `daily_stats` is the fact table | M |
| 11 | **Redis + separate worker service** | `core/cache` and `core/jobs` are already interfaces | S |

**Turning this into a product for many hotels:** re-introduce the ERP's tenancy DNA — `tenant_id`, forced RLS policies, `withTenant()`, a non-superuser runtime role — on top of a codebase that already has `property_id` everywhere. That is the one thing the ERP did at 9.5/10, and it is waiting, documented, if the business case appears. **Do not build it before it is sold.**

---

# PART VII — APPENDICES

## Appendix A — Environment variables

```bash
NODE_ENV=production
APP_URL=https://hotel.example.com

# Database — hms_app is NOT a superuser and NOT the schema owner
DATABASE_URL=postgres://hms_app:***@host:5432/hms
MIGRATION_DATABASE_URL=postgres://hms_migrator:***@host:5432/hms   # deploy step only
REQUIRE_MIGRATIONS=true

# Auth
BETTER_AUTH_SECRET=<32+ random bytes>
BETTER_AUTH_URL=https://hotel.example.com

# Hotel
HOTEL_TIMEZONE=Africa/Nairobi
DEFAULT_CURRENCY=KES

# Storage
R2_ACCOUNT_ID=…            R2_ACCESS_KEY_ID=…        R2_SECRET_ACCESS_KEY=…
R2_BUCKET_PRIVATE=hms-private
R2_BUCKET_PUBLIC=hms-public
R2_PUBLIC_BASE_URL=https://cdn.hotel.example.com

# Email
RESEND_API_KEY=…           MAIL_FROM="Hotel <no-reply@hotel.example.com>"

# Jobs & cron
CRON_SECRET=<32+ random bytes>
JOB_WORKER_ENABLED=true
NIGHT_AUDIT_HOUR=3

# Observability
SENTRY_DSN=…               LOG_LEVEL=info

# [P2]
# REDIS_URL=
# MPESA_CONSUMER_KEY=  MPESA_CONSUMER_SECRET=  MPESA_SHORTCODE=  MPESA_PASSKEY=  MPESA_CALLBACK_URL=
```

## Appendix B — Seeded settings

| Key | Default | Notes |
|---|---|---|
| `default_property_id` | *(the seeded property)* | |
| `vat_rate` | `16.00` | **Confirm with the client's accountant before go-live.** Never hardcoded. |
| `levy_rate` | `2.00` | Tourism/catering levy, if applicable |
| `tax_inclusive_pricing` | `false` | Whether displayed rates already include tax |
| `booking_ref_prefix` | `BK` | |
| `invoice_prefix` | `INV` | |
| `receipt_prefix` | `RCP` | |
| `maintenance_prefix` | `MT` | |
| `expense_prefix` | `EX` | |
| `deposit_percent` | `0` | 0 = no deposit required at check-in |
| `cancellation_free_hours` | `24` | Free cancellation window before arrival |
| `cancellation_fee_nights` | `1` | Nights charged inside the window |
| `no_show_fee_nights` | `1` | |
| `night_audit_hour` | `3` | Local time |
| `no_show_hour` | `6` | Hour after which un-arrived bookings become no-shows |
| `expense_approval_threshold` | `0` | 0 = no approval required |
| `guest_document_retention_months` | `24` | |
| `receipt_footer` | *(hotel text)* | |

## Appendix C — Permission matrix

| Permission group | Admin | Manager | Receptionist |
|---|:--:|:--:|:--:|
| `users.*` | ● | read only | — |
| `settings.read` / `settings.update` | ● / ● | ● / — | — / — |
| `audit.read` | ● | ● | — |
| `rooms.read` | ● | ● | ● |
| `rooms.create/update/delete` | ● | ● | — |
| `rooms.change_condition` | ● | ● | ● |
| `roomtypes.*` | ● | ● | read only |
| `rates.read` / `rates.update` | ● / ● | ● / ● | ● / — |
| `guests.read/create/update` | ● | ● | ● |
| `guests.view_documents` | ● | ● | ● |
| `guests.merge/delete/blacklist` | ● | ● | — |
| `bookings.read/create/update` | ● | ● | ● |
| `bookings.cancel` | ● | ● | ● |
| `bookings.move_room` | ● | ● | ● |
| `bookings.override_rate` | ● | ● | — |
| `bookings.backdate` | ● | ● | — |
| `frontdesk.check_in/check_out` | ● | ● | ● |
| `frontdesk.night_audit` | ● | ● | — |
| `folio.read/post_charge` | ● | ● | ● |
| `folio.void_charge` | ● | ● | — |
| `folio.discount` | ● | ● | — |
| `payments.read/record` | ● | ● | ● |
| `payments.reverse/refund` | ● | ● | — |
| `invoices.read/issue` | ● | ● | ● |
| `invoices.void` | ● | ● | — |
| `housekeeping.read/update` | ● | ● | ● |
| `maintenance.read/report` | ● | ● | ● |
| `maintenance.update/assign/close` | ● | ● | — |
| `expenses.read` | ● | ● | — |
| `expenses.create/update` | ● | ● | — |
| `expenses.approve/delete` | ● | ● (approve) | — |
| `reports.operational` | ● | ● | own-shift summary only |
| `reports.financial` | ● | ● | — |
| `reports.export` | ● | ● | — |

*Per-user exceptions are handled by `user_permission_overrides` — e.g. granting one trusted senior receptionist `payments.reverse` without promoting them to manager.*

## Appendix D — Seeded expense categories (spec §11)

Maintenance and Repairs · Electricity and Utilities · Water · Internet and Communication · Cleaning Supplies · Hotel Supplies · Furniture and Equipment · Transport · Marketing · Licenses and Administration · Miscellaneous Expenses

## Appendix E — Glossary

| Term | Meaning |
|---|---|
| **Allocation** | One room held for one date range for one reason (a reservation or a maintenance block) |
| **Business date** | The hotel's calendar day in its own timezone; rolls at the night audit |
| **Folio** | The running bill for a booking |
| **Night** | One `stay_date`; a stay from D1 to D2 has nights D1 … D2−1 |
| **Night audit** | The nightly job that posts room revenue, resolves no-shows and freezes statistics |
| **ADR** | Average Daily Rate = room revenue ÷ rooms sold |
| **RevPAR** | Revenue per Available Room = room revenue ÷ sellable rooms |
| **Stayover** | A guest staying tonight who neither arrived nor departs today |
| **Tape chart** | The rooms × dates availability grid |
| **Outbox** | Jobs written in the same transaction as the data change, executed later |
| **[P2]** | Deliberately deferred; the schema already supports it |

## Appendix F — Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Double-booking in production | Catastrophic to trust | DB exclusion constraint + row locks + idempotency + a CI concurrency gate (§11) |
| Money doesn't reconcile | Client stops paying | `NUMERIC`, server-side pricing, nightly reconciliation job with alerting, fuzz tests |
| Timezone/date-boundary bugs | Wrong occupancy, wrong charges | `DateOnly` type, `'[)'` ranges, business-date helper, explicit tests |
| Scope creep into a full PMS | Missed deadline | This document is the scope; everything else is §27 and requires a written change |
| Drizzle 1.0 lands mid-build | Churn | Pinned to `0.45.x`; upgrade is a post-v1 task with its own branch |
| Better Auth minor upgrades shift plugin APIs | Breakage | Pin exact versions; read release notes; auth is covered by E2E tests |
| Client changes tax rules at go-live | Rework | Tax is a setting, snapshotted per line; never hardcoded |
| The single server dies | Downtime | PITR + tested restore + a documented 1-hour RTO; the app is stateless and redeployable |
| Staff resist the new system | Adoption failure | Front-desk-first UI, tape chart, 7-day parallel run, hands-on training (§24.5) |

## Appendix G — Sources for the version audit (verified 2026-09-07)

- `npmjs.com/package/next` — Next.js 16.3.4 current
- `authjs.dev/getting-started/migrating-to-v5` — Auth.js now part of Better Auth; `middleware.ts` renamed to `proxy.ts` in Next 16
- `better-auth.com/blog/authjs-joins-better-auth` and `github.com/nextauthjs/next-auth/discussions/13252` — Better Auth recommended for new projects
- `npmjs.com/package/better-auth` — 1.7.3 current
- `npmjs.com/package/drizzle-orm` — 0.45.2 latest stable; 1.0.0-rc in progress
- `postgresql.org/docs/current` — PostgreSQL 18.6 current; 18 adds `uuidv7()` and temporal constraints
- `endoflife.date/nodejs` — Node 24 "Krypton" is Active LTS through 2028-05

---

## Closing note

The ERP's own forensic report ended with the right question: *what do we copy, what do we redesign, what do we eliminate?*

**Copied:** database-enforced correctness, the route pipeline, row locks and advisory locks, UUID keys with partial unique indexes, a server-enforced static permission matrix, DB-backed rate limiting, enforced Zod validation, denormalised document snapshots, one Next.js app, and the Playwright + k6 discipline.

**Redesigned:** explicit modules with lint-enforced boundaries, a real service layer, an outbox instead of inline side effects, `NUMERIC` money, real DB sessions with 2FA, private file storage, structured logs with metrics, and a versioned API with idempotency.

**Eliminated:** the unscoped DB export, money as text, fat transactions, retrofitted constraints, the 3D showpiece, the niche payment gateway, and — because there is exactly one client — the entire multi-tenancy layer.

What is left is a system whose hardest guarantee, *this room cannot be booked twice*, is enforced by one line of DDL that no bug, no race and no future integration can defeat. Everything else is craft on top of that.

**Build the constraint first. Then build the tape chart. Then sell it.**
