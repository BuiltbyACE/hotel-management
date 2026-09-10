import { Pool } from 'pg';

async function main() {
  const p = new Pool({ connectionString: process.env.DATABASE_URL! });
  const q = async (s: string) => (await p.query(s)).rows;
  const prop = (await q(`SELECT id FROM properties WHERE name = 'K6 Load Hotel'`))[0];
  const pid = prop.id as string;
  const last = await q(
    `SELECT max(b.departure_date)::text AS last_dep, count(*) AS n
     FROM bookings b
     JOIN room_allocations ra ON ra.booking_id = b.id
     JOIN rooms r ON r.id = ra.room_id
     WHERE r.room_number LIKE 'K6-%'
       AND r.property_id = '${pid}'
       AND b.status IN ('draft', 'confirmed', 'checked_in')`,
  );
  console.log('max-day rows:', JSON.stringify(last));
  await p.end();
}

void main();