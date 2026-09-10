/**
 * Seed fixtures for the k6 load gate (§22 G14).
 *
 * Idempotently creates a dedicated load-test property, room type, room and a
 * worker user (with credentials signing in through the REAL auth endpoint).
 * Each run picks a two-night window AFTER the last load booking so repeated
 * runs never overlap the same nights. Writes the run contract consumed by the
 * k6 script to load/.load-run.json (gitignored).
 *
 * Usage:
 *   pnpm load:seed
 */
import { hash as argon2Hash } from '@node-rs/argon2';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { Pool } from 'pg';

const PROPERTY_NAME = 'K6 Load Hotel';
const ROOM_TYPE_CODE = 'K6';
const ROOM_TYPE_NAME = 'K6 Standard';
const ROOM_PREFIX = 'K6-';
const ROOM_COUNT = 10;
const WORKER_EMAIL = 'k6worker@hms.test';
const WORKER_PASSWORD = 'k6-load-pass';

type Row = Record<string, unknown>;

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set — run via `pnpm load:seed`');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url });
  const first = async (text: string, params?: unknown[]): Promise<Row | undefined> => {
    const result = await pool.query(text, params);
    return result.rows[0] as Row | undefined;
  };

  // ── property ───────────────────────────────────────────────────────────
  let property = await first('SELECT id FROM properties WHERE name = $1 LIMIT 1', [PROPERTY_NAME]);
  if (!property) {
    property = await first(
      `INSERT INTO properties
         (name, legal_name, address, city, country, timezone, currency, phone, email,
          check_in_time, check_out_time, is_active)
       VALUES ($1, $2, $3, 'Nairobi', 'KE', 'Africa/Nairobi', 'KES', $4, $5, '14:00', '10:00', true)
       RETURNING id`,
      [PROPERTY_NAME, PROPERTY_NAME, 'K6 Load Hotel, Nairobi', '+254700000000', 'k6-load@hms.test'],
    );
  }
  const propertyId = property!.id as string;

  // ── room type ──────────────────────────────────────────────────────────
  let roomTypeId: string | undefined = (
    await first('SELECT id FROM room_types WHERE property_id = $1 AND upper(code) = $2', [
      propertyId,
      ROOM_TYPE_CODE,
    ])
  )?.id as string | undefined;
  if (!roomTypeId) {
    roomTypeId = (
      await first(
        `INSERT INTO room_types (property_id, code, name, base_rate, max_occupancy, max_adults, max_children)
         VALUES ($1, $2, $3, '5000.00', 2, 2, 0)
         RETURNING id`,
        [propertyId, ROOM_TYPE_CODE, ROOM_TYPE_NAME],
      )
    )!.id as string;
  }

  // ── room pool ───────────────────────────────────────────────────────────
  const roomIds: string[] = [];
  for (let i = 1; i <= ROOM_COUNT; i += 1) {
    const number = `${ROOM_PREFIX}${String(i).padStart(3, '0')}`;
    const existing = await first('SELECT id FROM rooms WHERE property_id = $1 AND upper(room_number) = $2', [
      propertyId,
      number,
    ]);
    if (existing) {
      roomIds.push(existing.id as string);
      continue;
    }
    const inserted = await first(
      `INSERT INTO rooms (property_id, room_type_id, room_number, floor, condition, housekeeping, is_active)
       VALUES ($1, $2, $3, 'G', 'available', 'clean', true)
       RETURNING id`,
      [propertyId, roomTypeId, number],
    );
    roomIds.push(inserted!.id as string);
  }

  // ── two-night window after the last active load booking ────────────────
  const today = new Date().toISOString().slice(0, 10);
  const last = await first(
    `SELECT max(b.departure_date)::text AS last_dep
     FROM bookings b
     JOIN room_allocations ra ON ra.booking_id = b.id
     JOIN rooms r ON r.id = ra.room_id
     WHERE r.room_number LIKE $1
       AND b.status IN ('draft', 'confirmed', 'checked_in')`,
    [`${ROOM_PREFIX}%`],
  );
  const arrival = addDays((last?.last_dep as string | undefined) ?? today, 1);
  const departure = addDays(arrival, 2);

  // ── worker user + credential (signs in through /api/auth) ──────────────
  let userId: string | undefined = (
    await first('SELECT id FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL', [WORKER_EMAIL])
  )?.id as string | undefined;
  if (!userId) {
    userId = (
      await first(
        `INSERT INTO users (name, email, role, status, property_id, must_change_password)
         VALUES ('K6 Load Worker', $1, 'receptionist', 'active', $2, false)
         RETURNING id`,
        [WORKER_EMAIL, propertyId],
      )
    )!.id as string;
  }

  const passwordHash = await argon2Hash(WORKER_PASSWORD, { algorithm: 2 });
  const credential = await first('SELECT id FROM account WHERE user_id = $1 AND provider_id = $2', [
    userId,
    'credential',
  ]);
  if (!credential) {
    await pool.query(
      'INSERT INTO account (id, account_id, provider_id, user_id, password) VALUES ($1, $2, $3, $4, $5)',
      [randomUUID(), userId, 'credential', userId, passwordHash],
    );
  } else {
    await pool.query('UPDATE account SET password = $1, updated_at = now() WHERE id = $2', [
      passwordHash,
      credential.id,
    ]);
  }

  await pool.end();

  const baseURL = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';
  const contract = { baseURL, propertyId, roomTypeId, rooms: roomIds, arrival, departure };
  writeFileSync('load/.load-run.json', `${JSON.stringify(contract, null, 2)}\n`);

  console.log('k6 load fixtures ready:');
  console.log(`  property   ${PROPERTY_NAME} (${propertyId})`);
  console.log(`  room type   ${ROOM_TYPE_CODE} (${roomTypeId})`);
  console.log(`  rooms      ${roomIds.length} (${ROOM_PREFIX}001…${ROOM_PREFIX}${String(roomIds.length).padStart(3, '0')})`);
  console.log(`  window      ${arrival} → ${departure} (2 nights)`);
  console.log(`  base URL    ${baseURL}`);
  console.log(`  worker      ${WORKER_EMAIL}`);
  console.log('Contract written to load/.load-run.json');
}

main().catch((e) => {
  console.error('Seed failed:', e);
  process.exit(1);
});