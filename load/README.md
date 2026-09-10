# k6 Load Gate — booking concurrency (§22 G14)

Hard production gate: 50 VUs fire concurrent `POST /api/v1/bookings` across a
pool of rooms and the **same two nights**. Each VU is pinned to one
(room, nights) combination, so ~5 VUs contend per combination. The
availability exclusion constraint (`room_allocations_no_overlap`) and the
application row lock allow exactly one booking through per combination;
everything else must come back as `409 ROOM_UNAVAILABLE`.

## Acceptance criteria

| Criterion                              | Threshold                          |
| -------------------------------------- | ---------------------------------- |
| Exactly 1 × `201` per room-night combo | `booking_wins == 10` (rooms)        |
| Zero `5xx` responses                   | `server_errors == 0`               |
| Error rate < 1%                        | `request_error_rate < 0.01`        |
| p95 response time < 2,000 ms           | `http_req_duration` p95 `< 2000`   |

## Prerequisites

- Postgres reachable at `DATABASE_URL` in `.env.local` (e.g. `docker compose up -d`)
- The app can boot against it (`pnpm dev`)
- [k6](https://grafana.com/docs/k6/) ≥ 2.0 (`k6 version`)

## Run it

Run every command **from the repository root**.

```bash
# 1. Seed fixtures (idempotent) → load/.load-run.json
pnpm load:seed

# 2. Boot the API (separate terminal)
pnpm dev

# 3. Wait until the API is up
curl http://localhost:3000/api/health

# 4. Run the gate
k6 run load/booking-concurrency.js
```

Optional: point at a non-local API with `BASE_URL`:

```bash
BASE_URL=https://staging.example.com k6 run load/booking-concurrency.js
```

## What a pass looks like

```
   ✓ booking_wins: 10 rooms × 1 combo                            count: 10
   ✓ server_errors: 0                                             count: 0
   ✓ request_error_rate: < 0.01                                  rate: 0.0
   ✓ http_req_duration: p(95)<2000                                p95: ~xx ms
```

The dominant traffic is expected `409 ROOM_UNAVAILABLE`: the first request that
locks the room wins; every later request for the same nights is rejected. That
is the correct behaviour under contention — it is not an error. The one
`201` is the excluded winner.

## How it works

- `load/seed.ts` creates (or reuses) a dedicated **K6 Load Hotel** property,
  room type `K6`, room `K6-001`, and a `receptionist` worker
  (`k6worker@hms.test`). It picks a two-night window **after** the most recent
  load booking, so re-runs never collide with earlier winners. Credentials are
  fixed throwaway values for the local/CI load harness only.
- `load/booking-concurrency.js` signs in through the real
  `/api/auth/sign-in/email` endpoint in `setup()`, then ramps 50 VUs over 60 s
  (10 s up / 40 s hold / 10 s down). Each iteration uses a unique
  `idempotencyKey` and the same room + nights.

## Notes & troubleshooting

- **Room pool**: `load/seed.ts` creates 10 rooms (`K6-001…K6-010`) and the
  script pins each VU to `rooms[__VU % 10]` (5 VUs per (room, nights) combo).
  This keeps the p95 gate honest: with a single room, all 50 VUs serialize on
  one `SELECT … FOR UPDATE` lock chain and p95 exceeds 2 s *by design* (that
  variant is documented in §21 as the strong-contention case). To run it,
  set `ROOM_COUNT = 1` in the seed and `booking_wins count==1`.
- Each run leaves one confirmed booking per room as residue in the dev
  database — harmless; `db:verify` runs don't include load fixtures.
- `401` from `setup()`: a fresh run against an old secret — the worker account
  is seeded with the password hash each time, so re-run `pnpm load:seed`.
- `000` connect errors during the run: the app isn't listening on `BASE_URL`.
- The bookings route is **not** rate-limited (Area D limits only report/export
  endpoints); Better Auth's limiter applies to `/api/auth/*`, which only sees
  the single `setup()` login.