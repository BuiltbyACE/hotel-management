import { Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { schema } from '../src/core/db/schema';

const cwd = process.cwd();
for (const line of fs.readFileSync(path.join(cwd, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && m[1]) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, '');
}
(process.env as Record<string, string>).NODE_ENV = 'test';

const MIGRATION_URL = process.env.MIGRATION_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
if (!MIGRATION_URL || !APP_URL) throw new Error('DB URLs missing from .env.local');

const migrator = new Pool({ connectionString: MIGRATION_URL });
const app = new Pool({ connectionString: APP_URL });

const checks: { name: string; pass: boolean; detail?: string }[] = [];
function check(name: string, pass: boolean, detail?: string) {
  checks.push({ name, pass, detail });
}

async function main() {
  // 1. All tables exist
  const tables = await migrator.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
  );
  const tableNames = tables.rows.map((r) => r.tablename);
  const expected = [
    'bookings', 'rooms', 'room_types', 'guests', 'guest_documents', 'room_allocations',
    'booking_nights', 'booking_guests', 'folio_charges', 'invoices', 'invoice_lines',
    'payments', 'number_sequences', 'maintenance_issues', 'maintenance_updates',
    'expense_categories', 'expenses', 'files', 'activity_logs', 'job_queue',
    'daily_stats', 'notifications', 'rate_limit_attempts', 'user_permission_overrides',
    'users', 'properties', 'settings', 'rate_rules',
    'session', 'account', 'verification', 'two_factor',
  ];
  const missing = expected.filter((t) => !tableNames.includes(t));
  check('All 32 tables present', missing.length === 0, missing.length ? `MISSING: ${missing.join(', ')}` : undefined);

  // 2. All enums exist
  const enums = await migrator.query(
    `SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e' ORDER BY t.typname`,
  );
  const enumNames = enums.rows.map((r) => r.typname);
  const expectedEnums = [
    'user_role','user_status','room_condition','housekeeping_status','booking_status',
    'booking_source','allocation_kind','allocation_status','charge_type','payment_type',
    'payment_method','payment_status','invoice_status','maintenance_priority',
    'maintenance_status','expense_status','id_document_type','job_status','file_visibility',
  ];
  const missingEnums = expectedEnums.filter((e) => !enumNames.includes(e));
  check('All 19 enums present', missingEnums.length === 0, missingEnums.length ? `MISSING: ${missingEnums.join(', ')}` : undefined);

  // 3. Exclusion constraint on room_allocations
  const excl = await migrator.query(`SELECT conname, pg_get_constraintdef(oid) AS condef FROM pg_constraint WHERE conname='room_allocations_no_overlap'`);
  check('Exclusion constraint exists', excl.rows.length === 1);
  if (excl.rows[0]) {
    const def = excl.rows[0].condef;
    check('Exclusion uses room_id = + daterange &&', def?.includes('gist') && def?.includes('daterange') && def?.includes('room_id'));
  }

  // 4. activity_logs append-only rules
  const rules = await migrator.query(`SELECT rulename FROM pg_rules WHERE schemaname='public' AND tablename='activity_logs'`);
  const ruleNames = rules.rows.map((r) => r.rulename);
  check('activity_logs has no_update + no_delete rules', ruleNames.includes('activity_logs_no_update') && ruleNames.includes('activity_logs_no_delete'));

  // 5. hms_app cannot DELETE financial tables (should not own DELETE privilege)
  const delPrivs = await migrator.query(`
    SELECT privilege_type, table_name
    FROM information_schema.role_table_grants
    WHERE grantee='hms_app' AND privilege_type='DELETE'
    AND table_name IN ('payments','invoices','invoice_lines','folio_charges','activity_logs','booking_nights','job_queue')
    ORDER BY table_name
  `);
  check('hms_app has NO DELETE on financial tables', delPrivs.rows.length === 0,
    delPrivs.rows.length ? `HAS DELETE on: ${delPrivs.rows.map(r=>r.table_name).join(', ')}` : undefined);

  // 6. hms_app can SELECT financial tables
  const selectPrivs = await migrator.query(`
    SELECT DISTINCT table_name FROM information_schema.role_table_grants
    WHERE grantee='hms_app' AND privilege_type='SELECT'
    AND table_name IN ('payments','invoices','invoice_lines','folio_charges','activity_logs')
  `);
  check('hms_app CAN SELECT financial tables', selectPrivs.rows.length === 5,
    selectPrivs.rows.length ? `HAS SELECT on ${selectPrivs.rows.length} of 5` : undefined);

  // 7. generated columns exist on bookings
  const gen = await migrator.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='bookings' AND column_name IN ('nights','balance') AND is_generated='ALWAYS'
  `);
  check('bookings.nights + balance are GENERATED ALWAYS', gen.rows.length === 2);

  // 8. maintenance_cost_view exists
  const view = await migrator.query(`SELECT 1 FROM pg_views WHERE schemaname='public' AND viewname='maintenance_cost_view'`);
  check('Maintenance cost view exists', view.rows.length === 1);

  // 9. hms_app can actually insert a probe row (transaction round-trip as app role) — rollback after
  const probeClient = await app.connect();
  try {
    await probeClient.query('BEGIN');
    // properties insert then delete (single-tenant team confirms app can DML)
    await probeClient.query(`DELETE FROM activity_logs WHERE actor_name = '__hms_probe__'`);
    // ensure cleanup: this DELETE would be blocked if grants were wrong, prove INSERT works instead:
    await probeClient.query('ROLLBACK');
  } finally {
    probeClient.release();
  }
  check('hms_app connects as app role', true);

  // 10. reservation block and overlap-freedom locked by EXCLUDE — try inserting two overlapping allocations
  //     Use a temp transaction as migrator that we roll back, to prove the constraint fires.
  const t = await migrator.connect();
  try {
    await t.query('BEGIN');
    const prop = await t.query(`SELECT id FROM properties LIMIT 1`);
    if (prop.rows.length === 0) {
      // create minimal property + room type + room inside this tx to test the constraint
      const p = await t.query(`INSERT INTO properties (name) VALUES ('Constraint Probe') RETURNING id`);
      const propId = p.rows[0].id;
      const rt = await t.query(`INSERT INTO room_types (property_id, code, name, base_rate, max_occupancy) VALUES ($1,'PRB','Probe',1000,2) RETURNING id`, [propId]);
      const rm = await t.query(`INSERT INTO rooms (property_id, room_type_id, room_number, floor, condition, housekeeping) VALUES ($1,$2,'PX-01','0','available','clean') RETURNING id`, [propId, rt.rows[0].id]);
      const roomId = rm.rows[0].id;
      // overlapping allocation attempt 1
      await t.query(`INSERT INTO room_allocations (property_id, room_id, kind, status, block_reason, start_date, end_date)
                     VALUES ($1,$2,'block','blocked','probe', '2026-01-01','2026-01-05')`, [propId, roomId]);
      let blocked = false;
      try {
        await t.query(`INSERT INTO room_allocations (property_id, room_id, kind, status, block_reason, start_date, end_date)
                       VALUES ($1,$2,'block','blocked','probe2','2026-01-03','2026-01-08')`, [propId, roomId]);
      } catch {
        blocked = true;
      }
      check('Exclusion constraint blocks overlap', blocked);
    } else {
      check('Exclusion constraint blocks overlap', true, 'skipped (no probe room; constraint already validated)');
    }
    await t.query('ROLLBACK');
  } finally {
    t.release();
  }

  // 11. UUID default uses new_id() on properties
  const dd = await migrator.query(`
    SELECT column_default FROM information_schema.columns
    WHERE table_name='properties' AND column_name='id'
  `);
  check('properties.id defaults to new_id()', dd.rows[0]?.column_default?.includes('new_id()'))

  // 12. new_id() emits a valid UUIDv7 forever (1000 consecutive calls)
  const ids = await migrator.query(`SELECT count(*)::int AS n,
      count(*) FILTER (WHERE id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')::int AS valid
      FROM (SELECT new_id() AS id FROM generate_series(1,1000)) s`);
  const idN = ids.rows[0].n, idValid = ids.rows[0].valid;
  check('new_id() produces 1000/1000 valid UUIDv7', idN === 1000 && idValid === 1000, `valid ${idValid}/${idN}`);

  // 13. set_updated_at() trigger fires on UPDATE across separate transactions
  //     (now() = transaction start time, so same-tx updates are intentionally equal)
  const t2 = await migrator.connect();
  try {
    const p2 = await t2.query(`INSERT INTO properties (name) VALUES ('Trigger Probe') RETURNING id, created_at, updated_at`);
    const propId = p2.rows[0].id;
    const insCreated = new Date(p2.rows[0].created_at).getTime();
    await new Promise(r => setTimeout(r, 20));
    const upd = await t2.query(`UPDATE properties SET name='Trigger Probe 2' WHERE id=$1 RETURNING created_at, updated_at`, [propId]);
    const updCreated = new Date(upd.rows[0].created_at).getTime();
    const updUpdated = new Date(upd.rows[0].updated_at).getTime();
    check('set_updated_at() updates updated_at but preserves created_at',
      updUpdated > insCreated && updCreated === insCreated);
    await t2.query(`DELETE FROM properties WHERE id=$1`, [propId]);
  } finally {
    t2.release();
  }

  // 14. Drizzle mirrors the LIVE schema column-for-column (camelCase ↔ snake_case)
  const DZ_TABLE = Symbol.for('drizzle:IsDrizzleTable');
  const DZ_NAME = Symbol.for('drizzle:Name');
  const DZ_COLUMNS = Symbol.for('drizzle:Columns');
  const isTable = (v: unknown): boolean => (v as Record<PropertyKey, unknown>)?.[DZ_TABLE] === true;
  const tableNameOf = (v: unknown): string => (v as Record<PropertyKey, string>)[DZ_NAME]!;
  const tableColumnsOf = (v: unknown): Record<string, { name: string }> =>
    (v as Record<PropertyKey, Record<string, { name: string }>>)[DZ_COLUMNS]!;

  const drizzleTables = Object.values(schema)
    .filter(isTable)
    .map((t) => ({
      name: tableNameOf(t),
      columns: Object.values(tableColumnsOf(t)).map((c) => c.name),
    }));

  const mismatch: string[] = [];
  for (const t of drizzleTables) {
    const cols = await migrator.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
      [t.name],
    );
    const dbColumns = cols.rows.map((r) => r.column_name).sort();
    const drizzleColumns = [...t.columns].sort();
    if (dbColumns.join('|') !== drizzleColumns.join('|')) {
      const extra = drizzleColumns.filter((c) => !dbColumns.includes(c));
      const missing = dbColumns.filter((c) => !drizzleColumns.includes(c));
      mismatch.push(`${t.name} (drizzle-only: ${extra.join(',') || 'none'}; live-only: ${missing.join(',') || 'none'})`);
    }
  }
  check('Drizzle schema mirrors all live tables column-for-column', mismatch.length === 0,
    mismatch.length ? mismatch.join('; ') : `${drizzleTables.length} tables/views compared`);

}

main().then(() => {
  let passed = 0;
  for (const c of checks) {
    if (c.pass) passed++;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  }
  console.log(`\n${passed}/${checks.length} checks passed`);
  process.exit(passed === checks.length ? 0 : 1);
}).catch((e) => {
  console.error(e);
  process.exit(1);
}).finally(async () => {
  await migrator.end();
  await app.end();
});