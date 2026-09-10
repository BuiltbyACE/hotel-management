/**
 * k6 load gate (§22 G14) — booking concurrency.
 *
 * 50 VUs fire concurrent `POST /api/v1/bookings` across a pool of rooms and
 * the SAME two nights. Each VU is pinned to one (room, nights) combination so
 * ~5 VUs contend per combo. The availability exclusion constraint allows
 * exactly one booking through per combo; every other attempt must return
 * 409 ROOM_UNAVAILABLE.
 *
 * Acceptance criteria (hard gate):
 *   - exactly 1 x 201 per room-night combination   → booking_wins == 1
 *   - zero 5xx responses                           → server_errors == 0
 *   - error rate < 1%                              → error_rate < 0.01
 *   - p95 response time < 2,000 ms                 → http_req_duration p(95) < 2000
 *
 * Run from the repo root:
 *   pnpm load:seed          # idempotent fixtures → load/.load-run.json
 *   k6 run load/booking-concurrency.js
 *
 * `open('load/.load-run.json')` resolves relative to the working directory, so
 * run this from the repository root as documented in load/README.md.
 */
import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const run = JSON.parse(open('.load-run.json'));
export const BASE_URL = __ENV.BASE_URL ?? run.baseURL;
const ROOM_POOL = run.rooms;
const ARRIVAL = run.arrival;
const DEPARTURE = run.departure;

const LOGIN_EMAIL = 'k6worker@hms.test';
const LOGIN_PASSWORD = 'k6-load-pass';

const bookingWins = new Counter('booking_wins');
const serverErrors = new Counter('server_errors');
const requestErrorRate = new Rate('request_error_rate');

// Per-VU flag: true once this VU has won or confirmed the room is taken.
// k6 module-level `let` persists across iterations within the same VU context.
let vuSettled = false;

export const options = {
  scenarios: {
    hammer: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 50 },
        { duration: '40s', target: 50 },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    // One confirmed booking per (room, nights) combination — 10 rooms, 10 winners.
    booking_wins: [`count==${ROOM_POOL.length}`],
    server_errors: ['count==0'],
    request_error_rate: ['rate<0.01'],
    http_req_duration: ['p(95)<2000'],
  },
};

/** Real credential sign-in through Better Auth — the worker is seeded by load/seed.ts. */
export function setup() {
  const res = http.post(
    `${BASE_URL}/api/auth/sign-in/email`,
    JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
    { headers: { 'Content-Type': 'application/json' }, responseType: 'text' },
  );
  if (res.status !== 200) {
    fail(`sign-in failed: ${res.status} ${res.body}`);
  }
  const names = Object.keys(res.cookies);
  if (names.length === 0) {
    fail('sign-in returned no session cookies');
  }
  return { cookie: names.map((n) => `${n}=${res.cookies[n][0].value}`).join('; ') };
}

export default function (data) {
  // Back off once this VU has resolved its outcome — reduces pointless retries
  // against an already-booked room and keeps the queue shallow.
  if (vuSettled) {
    sleep(5 + Math.random() * 5);
    return;
  }

  // Each VU hammers ONE (room, nights) combo; 50 VUs / 10 rooms → 5 contenders each.
  const roomId = ROOM_POOL[__VU % ROOM_POOL.length];
  const payload = JSON.stringify({
    guest: { fullName: `K6 Load Guest ${__VU}`, phone: '+254700000001' },
    source: 'front_desk',
    rooms: [{ roomId, arrival: ARRIVAL, departure: DEPARTURE, adults: 2, children: 0 }],
    specialRequests: `k6 vu=${__VU} iter=${__ITER}`,
  });

  const res = http.post(`${BASE_URL}/api/v1/bookings`, payload, {
    headers: { 'Content-Type': 'application/json', Cookie: data.cookie },
    tags: { class: 'confirm-booking', room: roomId },
    timeout: '10s',
  });

  if (res.status === 201) {
    bookingWins.add(1, { room: roomId });
    requestErrorRate.add(false);
    check(res, { 'winner confirmed (201)': (r) => r.status === 201 });
    vuSettled = true;
  } else if (res.status === 409) {
    let code = null;
    try {
      code = res.json().code;
    } catch {
      // keep null → counted as an error below
    }
    const expected = code === 'ROOM_UNAVAILABLE';
    requestErrorRate.add(!expected); // ROOM_UNAVAILABLE is expected business output
    if (res.status >= 500) serverErrors.add(1);
    check(res, { 'room unavailable (409 ROOM_UNAVAILABLE)': (r) => r.status === 409 && expected });
    if (expected) vuSettled = true;
  } else {
    requestErrorRate.add(true);
    if (res.status >= 500) serverErrors.add(1);
    check(res, { 'no unexpected status': (r) => r.status === 201 || r.status === 409 });
  }

  // Brief stagger during the active (pre-settled) phase only.
  sleep(Math.random() * 0.2);
}