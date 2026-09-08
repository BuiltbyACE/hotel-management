# Hotel Management System (HMS)

A single-hotel Property Management System being built backend-first. The product differentiators — provable zero double-bookings, a tape-chart availability grid, a correct nightly audit, and money that always balances to the cent — are enforced at the **database level**, not in application code.

The build is driven by [`HOTEL_MANAGEMENT_SYSTEM_BLUEPRINT.md`](./HOTEL_MANAGEMENT_SYSTEM_BLUEPRINT.md), which is the source of truth. If code and the blueprint disagree, one of them is a bug: fix the right one and amend the other.

**Status:** Identity & auth complete (all tests green). Property module is next; build order follows blueprint §25.

## Modules

The system covers 12 modules. Schema and database constraints already exist for all of them; services, routes and tests are being built module by module.

| Module | Route prefix | Status |
|---|---|---|
| Identity & RBAC | `/api/v1/users` | Done — service, routes, 21 integration + unit tests |
| Property (room types, rooms, rate rules) | `/api/v1/room-types`, `/api/v1/rooms`, `/api/v1/rate-rules` | Next |
| Guests | `/api/v1/guests` | Pending |
| Availability | `/api/v1/availability` | Pending (zero overbooking, enforced in DB) |
| Bookings | `/api/v1/bookings` | Pending (k6 concurrency gate) |
| Front Desk / Housekeeping / Billing / Expenses / Maintenance / Reporting / Audit | — | Pending |

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router) on React 19, TypeScript 5.9 |
| Database | PostgreSQL 18 (Docker) |
| ORM / migrations | drizzle-orm 0.45 + drizzle-kit |
| Auth | better-auth 1.7 (email/password, DB-backed sessions), @node-rs/argon2 |
| Validation | zod 4 |
| Testing | vitest 5 (unit + integration against a real Postgres) |
| Misc | pino logging, resend (email), Cloudflare R2 (files), Sentry, Playwright (e2e, future) |

## Architecture

```
src/
├─ core/            Cross-cutting foundation (no module knowledge)
│  ├─ db/           PG pool + transactions, drizzle schema barrel, sequence IDs,
│  │                schema verifier, roles, better-auth table mirrors
│  ├─ api/          Route toolkit: apiHandler, problem+json errors, pagination,
│  │                validateBody
│  ├─ auth/         better-auth config + login-status gate
│  ├─ events/       in-memory domain event bus
│  ├─ jobs/         outbox table + worker (side effects leave the write transaction)
│  ├─ rate-limit.ts DB-backed rate limiter
│  └─ cache/ files/ mail/ realtime/
├─ modules/         One folder per module: schema, repository, service, validation,
│  │                events, and (module) __tests__
├─ app/api/v1/      HTTP surface: permission-first route handlers
└─ app/api/auth/    better-auth + login throttle wrapper
```

The pipeline is identical on every write path: **auth → permission → validate → scope → transact → broadcast** (blueprint §1.0.2).

## Database

- **Two DB roles with real separation:** `hms_app` (DML only, used by the app) and `hms_migrator` (schema owner, migrations only). The app role is intentionally not a superuser and not the schema owner.
- **Auth tables** are the classic better-auth set: `users`, `sessions`, `accounts` (credential = `providerId: "credential"`, `accountId = user_id`), `verifications`, `two_factors`.
- **Sequences** are app-managed `bigserial`-like, generated via `src/core/db/sequence.ts` (no identity columns).
- `pnpm db:verify` (`scripts/verify-schema.ts`) checks every expected table, column, type, and index against the live DB (currently 15/15 green).

## Identity, Auth & Security

- **RBAC:** 3 roles with a strict hierarchy — `admin` (100), `manager` (50), `receptionist` (10) — and a fixed catalogue of 62 permissions (`roomtypes.*`, `rooms.*`, `rates.*`, etc.). Every route is permission-first via `requirePermission` (`src/modules/identity/auth-guard.ts`). Admins can only be edited by a strictly-higher actor; the last active admin cannot be deactivated.
- **Passwords:** argon2id with unique per-user salts; hashes start with `$argon2`.
- **Login hardening:** a status gate rejects non-active users (`ACCOUNT_DISABLED` / `ACCOUNT_SUSPENDED`, 403) before any session is created, and a DB-backed throttle returns `429 + Retry-After` after 5 failed attempts per `login:<email>` and `login:ip:<ip>` within 15 minutes. Unknown emails return the same 401 as wrong passwords — no existence oracle.
- **Deactivation & resets** revoke all of the user's sessions.

## API conventions

- All business endpoints live under `/api/v1/*`.
- Errors are RFC 7807 `application/problem+json` with machine-readable `code` fields.
- List endpoints are paginated (`limit`/`offset`) and support search/filter query params.
- Route handlers are kept small (`apiHandler` + `validateBody`); ESLint boundaries forbid routes from importing module internals beyond `service`, `validation`, and `guards` — logic lives in the service, not the route.

## Getting started

Prerequisites: Node 20+, pnpm 11, Docker.

```bash
# 1. Start Postgres 18
docker compose up -d

# 2. Environment
cp .env.example .env.local
#   set BETTER_AUTH_SECRET / CRON_SECRET to random 32+ char strings

pnpm install

# 3. Migrations + schema check
pnpm db:migrate
pnpm db:verify        # expect: 15/15 schema checks green

# 4. Run
pnpm dev
```

## Scripts

| Script | What it does |
|---|---|
| `pnpm dev` | Next dev server |
| `pnpm build` / `pnpm start` | Production build / serve |
| `pnpm lint` | ESLint (includes import-boundary rules) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | vitest (unit + integration, needs the Docker DB + `.env.local`) |
| `pnpm db:migrate` | apply migrations |
| `pnpm db:verify` | verify schema matches the code |
| `pnpm db:generate` / `pnpm db:studio` | drizzle-kit codegen / explorer |
| `pnpm run ci` | lint + typecheck + test + build — the full pre-merge gate |

**Testing notes:** integration tests hit a real Postgres, so `docker compose up -d` and `.env.local` are required. Argon2 is intentionally CPU-bound, so the auth/identity integration tests run with a raised timeout (30s) to stay reliable on loaded machines.

## Development workflow

1. Pick the next module in blueprint §25 order (currently **property**).
2. Blueprint schema (§6–§8) already exists in `drizzle/0001_full_schema.sql` and `src/modules/<module>/schema.ts` — the DB is the contract.
3. Build service → validation → routes → tests, mirroring the identity module (`src/modules/identity/`).
4. Pass the full gate (`pnpm run ci` + `pnpm db:verify`) before ticking the milestone.

See the blueprint's §25 build order, §9.3 permission catalogue, and §16.3 route catalogue for the source of truth on sequencing.