-- Phase 0 bootstrap: extensions, roles, functions, default privileges.
-- Runs as hms_migrator (the migration/schema-owner role), which is trusted
-- to create extensions. hms_app stays a plain login role: full DML on
-- migrator-owned tables/sequences, but never the schema or table owner.
--
-- Extension notes:
--   * btree_gist -- required for anti-double-booking exclusion constraints
--     (rooms_excluded_periods OVERLAPS exclusion) in the bookings module.
--   * pg_trgm    -- ILIKE + trigram GIN index support for name/search.
--   * pgcrypto   -- gen_random_bytes() backing new_id().

-- ---------------------------------------------------------------------------
-- 1. Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Application login role (idempotent; password synced with .env.local)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hms_app') THEN
    CREATE ROLE hms_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD 'dev';
  ELSE
    ALTER ROLE hms_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD 'dev';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Grants for hms_app (DML only; DDL stays with hms_migrator)
-- ---------------------------------------------------------------------------
GRANT CONNECT ON DATABASE hms TO hms_app;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO hms_app;
--> statement-breakpoint
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO hms_app;
--> statement-breakpoint
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO hms_app;
--> statement-breakpoint
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO hms_app;
--> statement-breakpoint

-- Future objects created by the migrator are usable by the app automatically.
ALTER DEFAULT PRIVILEGES FOR ROLE hms_migrator IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO hms_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE hms_migrator IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO hms_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE hms_migrator IN SCHEMA public GRANT ALL PRIVILEGES ON FUNCTIONS TO hms_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. new_id(): UUIDv7 (time-ordered, index-friendly, unguessable-ish)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.new_id()
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SET search_path = public
AS $fn$
DECLARE
  ms bigint;
  rb bytea;
  hex text;
BEGIN
  ms := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;
  rb := gen_random_bytes(10);
  -- 6 bytes timestamp (48-bit, big-endian)
  hex := lpad(to_hex(ms), 12, '0');
  -- byte 6: version = 0111 (v7), low nibble random
  hex := hex || to_hex(((get_byte(rb, 0) & 15) + 112));
  -- byte 7: random
  hex := hex || to_hex(get_byte(rb, 1));
  -- byte 8: variant = 10xx, low 6 bits random
  hex := hex || to_hex(((get_byte(rb, 2) & 63) + 128));
  -- bytes 9..15: random
  FOR i IN 3..9 LOOP
    hex := hex || to_hex(get_byte(rb, i));
  END LOOP;
  RETURN hex::uuid;
END;
$fn$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. set_updated_at(): BEFORE UPDATE trigger for updated_at columns
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$fn$;