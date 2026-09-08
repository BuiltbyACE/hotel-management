-- Phase 1: Full schema for the Hotel Management System.
-- Written by hand as SQL (the blueprint's source of truth). Drizzle mirrors this
-- 1:1 in each module's schema.ts.
--
-- Runs as hms_migrator (schema owner). hms_app receives DML via default privileges
-- (set in 0000). Financial tables have DELETE REVOKED from hms_app, and
-- activity_logs is append-only via rules + revoked grants.
--
-- Ordering follows the blueprint §6.5: extensions were 0000; here we create
-- tables grouped by domain but all in ONE migration, with the handful of
-- circular foreign keys added via ALTER TABLE ... ADD CONSTRAINT at the end.
-- No fix_* migrations. [ERP-FIX]

-- ===========================================================================
-- 1. ENUMERATED TYPES
-- ===========================================================================
CREATE TYPE user_role            AS ENUM ('admin','manager','receptionist');
--> statement-breakpoint
CREATE TYPE user_status          AS ENUM ('active','suspended','disabled');
--> statement-breakpoint
CREATE TYPE room_condition       AS ENUM ('available','occupied','cleaning','maintenance','out_of_order');
--> statement-breakpoint
CREATE TYPE housekeeping_status  AS ENUM ('clean','dirty','inspected','out_of_service');
--> statement-breakpoint
CREATE TYPE booking_status       AS ENUM ('draft','confirmed','checked_in','checked_out','cancelled','no_show');
--> statement-breakpoint
CREATE TYPE booking_source       AS ENUM ('walk_in','phone','email','front_desk','online','ota','corporate');
--> statement-breakpoint
CREATE TYPE allocation_kind      AS ENUM ('reservation','block');
--> statement-breakpoint
CREATE TYPE allocation_status    AS ENUM ('held','confirmed','checked_in','checked_out','blocked','released');
--> statement-breakpoint
CREATE TYPE charge_type          AS ENUM ('room','tax','levy','extra','service','discount','adjustment');
--> statement-breakpoint
CREATE TYPE payment_type         AS ENUM ('payment','deposit','refund');
--> statement-breakpoint
CREATE TYPE payment_method       AS ENUM ('cash','mpesa','card','bank_transfer','cheque','other');
--> statement-breakpoint
CREATE TYPE payment_status       AS ENUM ('pending','completed','failed','reversed');
--> statement-breakpoint
CREATE TYPE invoice_status       AS ENUM ('draft','issued','partially_paid','paid','void');
--> statement-breakpoint
CREATE TYPE maintenance_priority AS ENUM ('low','medium','high','urgent');
--> statement-breakpoint
CREATE TYPE maintenance_status   AS ENUM ('reported','pending','in_progress','resolved','closed');
--> statement-breakpoint
CREATE TYPE expense_status       AS ENUM ('recorded','approved','rejected');
--> statement-breakpoint
CREATE TYPE id_document_type     AS ENUM ('national_id','passport','driving_licence','military','other');
--> statement-breakpoint
CREATE TYPE job_status           AS ENUM ('pending','processing','completed','failed','dead');
--> statement-breakpoint
CREATE TYPE file_visibility      AS ENUM ('public','private');
--> statement-breakpoint

-- ===========================================================================
-- 2. PROPERTY & SETTINGS
-- ===========================================================================
CREATE TABLE properties (
  id              uuid PRIMARY KEY DEFAULT new_id(),
  name            text NOT NULL,
  legal_name      text,
  address         text,
  city            text,
  country         text NOT NULL DEFAULT 'KE',
  timezone        text NOT NULL DEFAULT 'Africa/Nairobi',
  currency        char(3) NOT NULL DEFAULT 'KES',
  phone           text,
  email           text,
  tax_pin         text,
  logo_file_id    uuid,
  check_in_time   time NOT NULL DEFAULT '14:00',
  check_out_time  time NOT NULL DEFAULT '10:00',
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TRIGGER properties_set_updated_at
  BEFORE UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  description text,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- ===========================================================================
-- 4. IDENTITY
-- ===========================================================================
CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT new_id(),
  name              text NOT NULL,
  email             text NOT NULL UNIQUE,
  email_verified    boolean NOT NULL DEFAULT false,
  image             text,
  role              user_role NOT NULL DEFAULT 'receptionist',
  status            user_status NOT NULL DEFAULT 'active',
  phone             text,
  property_id       uuid REFERENCES properties(id),
  must_change_password boolean NOT NULL DEFAULT true,
  password_changed_at  timestamptz,
  last_login_at     timestamptz,
  two_factor_enabled boolean NOT NULL DEFAULT false,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email)) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX users_role_idx ON users (role) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE TABLE user_permission_overrides (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission text NOT NULL,
  allowed    boolean NOT NULL,
  granted_by uuid REFERENCES users(id),
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission)
);
--> statement-breakpoint

CREATE TABLE rate_limit_attempts (
  id          bigserial PRIMARY KEY,
  bucket      text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX rate_limit_bucket_time_idx ON rate_limit_attempts (bucket, attempted_at DESC);
--> statement-breakpoint

-- ===========================================================================
-- 5. FILES (created here — both properties and users exist; referenced by
--        guests, invoices, expenses, and circularly by properties.logo_file_id)
-- ===========================================================================
CREATE TABLE files (
  id           uuid PRIMARY KEY DEFAULT new_id(),
  property_id  uuid NOT NULL REFERENCES properties(id),
  storage_key  text NOT NULL UNIQUE,
  visibility   file_visibility NOT NULL DEFAULT 'private',
  original_name text NOT NULL,
  mime_type    text NOT NULL,
  size_bytes   bigint NOT NULL,
  checksum     text,
  thumbnail_key text,
  entity_type  text,
  entity_id    uuid,
  uploaded_by  uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
--> statement-breakpoint
CREATE INDEX files_entity_idx ON files (entity_type, entity_id);
--> statement-breakpoint
CREATE INDEX files_property_idx ON files (property_id);

-- ===========================================================================
-- 6. INVENTORY: room types, rooms, rates
-- ===========================================================================
CREATE TABLE room_types (
  id              uuid PRIMARY KEY DEFAULT new_id(),
  property_id     uuid NOT NULL REFERENCES properties(id),
  code            text NOT NULL,
  name            text NOT NULL,
  description     text,
  base_rate       numeric(14,2) NOT NULL CHECK (base_rate >= 0),
  max_occupancy   smallint NOT NULL CHECK (max_occupancy BETWEEN 1 AND 20),
  max_adults      smallint NOT NULL DEFAULT 2,
  max_children    smallint NOT NULL DEFAULT 0,
  extra_bed_rate  numeric(14,2) NOT NULL DEFAULT 0 CHECK (extra_bed_rate >= 0),
  amenities       text[] NOT NULL DEFAULT '{}',
  photo_file_ids  uuid[] NOT NULL DEFAULT '{}',
  display_order   smallint NOT NULL DEFAULT 0,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX room_types_code_uq ON room_types (property_id, upper(code)) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX room_types_amenities_gin ON room_types USING gin (amenities);
--> statement-breakpoint
CREATE TRIGGER room_types_set_updated_at
  BEFORE UPDATE ON room_types
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

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
--> statement-breakpoint
CREATE UNIQUE INDEX rooms_number_uq ON rooms (property_id, upper(room_number)) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX rooms_type_idx ON rooms (room_type_id);
--> statement-breakpoint
CREATE INDEX rooms_condition_idx ON rooms (property_id, condition) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER rooms_set_updated_at
  BEFORE UPDATE ON rooms
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE TABLE rate_rules (
  id            uuid PRIMARY KEY DEFAULT new_id(),
  property_id   uuid NOT NULL REFERENCES properties(id),
  room_type_id  uuid REFERENCES room_types(id),
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
--> statement-breakpoint
CREATE INDEX rate_rules_lookup_idx ON rate_rules (property_id, room_type_id, valid_from, valid_to) WHERE is_active;
--> statement-breakpoint
CREATE TRIGGER rate_rules_set_updated_at
  BEFORE UPDATE ON rate_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ===========================================================================
-- 5. GUESTS
-- ===========================================================================
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
  notes           text,
  is_blacklisted  boolean NOT NULL DEFAULT false,
  blacklist_reason text,
  stay_count      integer NOT NULL DEFAULT 0,
  lifetime_value  numeric(14,2) NOT NULL DEFAULT 0,
  last_stay_date  date,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX guests_id_number_uq ON guests (property_id, id_type, upper(id_number)) WHERE id_number IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX guests_name_trgm ON guests USING gin (full_name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX guests_phone_idx ON guests (property_id, phone) WHERE phone IS NOT NULL;
--> statement-breakpoint
CREATE INDEX guests_email_idx ON guests (property_id, lower(email)) WHERE email IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER guests_set_updated_at
  BEFORE UPDATE ON guests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE TABLE guest_documents (
  id          uuid PRIMARY KEY DEFAULT new_id(),
  guest_id    uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  file_id     uuid NOT NULL REFERENCES files(id),
  doc_type    id_document_type NOT NULL,
  uploaded_by uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX guest_documents_guest_idx ON guest_documents (guest_id);
--> statement-breakpoint

-- ===========================================================================
-- 6. BOOKINGS AND THE ALLOCATION LEDGER — THE HEART OF THE SYSTEM
-- ===========================================================================
CREATE TABLE bookings (
  id                 uuid PRIMARY KEY DEFAULT new_id(),
  property_id        uuid NOT NULL REFERENCES properties(id),
  reference          text NOT NULL,
  guest_id           uuid NOT NULL REFERENCES guests(id),
  status             booking_status NOT NULL DEFAULT 'draft',
  source             booking_source NOT NULL DEFAULT 'front_desk',
  arrival_date       date NOT NULL,
  departure_date     date NOT NULL,
  nights             integer GENERATED ALWAYS AS (departure_date - arrival_date) STORED,
  adults             smallint NOT NULL DEFAULT 1,
  children           smallint NOT NULL DEFAULT 0,
  guest_name_snapshot  text NOT NULL,
  guest_phone_snapshot text,
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
  idempotency_key    text,
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (departure_date > arrival_date),
  CHECK (adults >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX bookings_reference_uq ON bookings (property_id, reference);
--> statement-breakpoint
CREATE UNIQUE INDEX bookings_idempotency_uq ON bookings (property_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
--> statement-breakpoint
CREATE INDEX bookings_arrival_idx   ON bookings (property_id, arrival_date, status);
--> statement-breakpoint
CREATE INDEX bookings_departure_idx ON bookings (property_id, departure_date, status);
--> statement-breakpoint
CREATE INDEX bookings_guest_idx     ON bookings (guest_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX bookings_status_idx    ON bookings (property_id, status) WHERE status IN ('confirmed','checked_in');
--> statement-breakpoint
CREATE TRIGGER bookings_set_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE TABLE maintenance_issues (
  id             uuid PRIMARY KEY DEFAULT new_id(),
  property_id    uuid NOT NULL REFERENCES properties(id),
  reference      text NOT NULL,
  title          text NOT NULL,
  description    text NOT NULL,
  room_id        uuid REFERENCES rooms(id),
  location       text,
  priority       maintenance_priority NOT NULL DEFAULT 'medium',
  status         maintenance_status NOT NULL DEFAULT 'reported',
  assigned_to    text,
  assigned_user_id uuid REFERENCES users(id),
  estimated_cost numeric(14,2) CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
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
--> statement-breakpoint
CREATE UNIQUE INDEX maintenance_reference_uq ON maintenance_issues (property_id, reference);
--> statement-breakpoint
CREATE INDEX maintenance_open_idx ON maintenance_issues (property_id, status, priority) WHERE status NOT IN ('resolved','closed');
--> statement-breakpoint
CREATE INDEX maintenance_room_idx ON maintenance_issues (room_id);
--> statement-breakpoint
CREATE TRIGGER maintenance_issues_set_updated_at
  BEFORE UPDATE ON maintenance_issues
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE TABLE room_allocations (
  id                   uuid PRIMARY KEY DEFAULT new_id(),
  property_id          uuid NOT NULL REFERENCES properties(id),
  room_id              uuid NOT NULL REFERENCES rooms(id),
  kind                 allocation_kind NOT NULL,
  status               allocation_status NOT NULL,
  booking_id           uuid REFERENCES bookings(id) ON DELETE CASCADE,
  maintenance_issue_id uuid REFERENCES maintenance_issues(id) ON DELETE SET NULL,
  block_reason         text,
  start_date           date NOT NULL,
  end_date             date NOT NULL,
  rate_snapshot        numeric(14,2),
  room_type_snapshot   uuid REFERENCES room_types(id),
  adults               smallint NOT NULL DEFAULT 1,
  children             smallint NOT NULL DEFAULT 0,
  held_until           timestamptz,
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
--> statement-breakpoint
ALTER TABLE room_allocations
  ADD CONSTRAINT room_allocations_no_overlap
  EXCLUDE USING gist (
    room_id WITH =,
    daterange(start_date, end_date, '[)') WITH &&
  )
  WHERE (status IN ('held','confirmed','checked_in','checked_out','blocked'));
--> statement-breakpoint
CREATE INDEX allocations_booking_idx ON room_allocations (booking_id);
--> statement-breakpoint
CREATE INDEX allocations_room_dates_idx ON room_allocations (room_id, start_date, end_date);
--> statement-breakpoint
CREATE INDEX allocations_property_dates_idx ON room_allocations (property_id, start_date, end_date)
  WHERE status IN ('confirmed','checked_in','checked_out','blocked');
--> statement-breakpoint
CREATE INDEX allocations_held_expiry_idx ON room_allocations (held_until) WHERE status = 'held';
--> statement-breakpoint
CREATE TRIGGER room_allocations_set_updated_at
  BEFORE UPDATE ON room_allocations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE TABLE booking_nights (
  id             uuid PRIMARY KEY DEFAULT new_id(),
  property_id    uuid NOT NULL REFERENCES properties(id),
  booking_id     uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  allocation_id  uuid NOT NULL REFERENCES room_allocations(id) ON DELETE CASCADE,
  room_id        uuid NOT NULL REFERENCES rooms(id),
  room_type_id   uuid NOT NULL REFERENCES room_types(id),
  stay_date      date NOT NULL,
  rate           numeric(14,2) NOT NULL CHECK (rate >= 0),
  is_posted      boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX booking_nights_uq ON booking_nights (allocation_id, stay_date);
--> statement-breakpoint
CREATE INDEX booking_nights_date_idx ON booking_nights (property_id, stay_date);
--> statement-breakpoint
CREATE INDEX booking_nights_unposted_idx ON booking_nights (property_id, stay_date) WHERE NOT is_posted;
--> statement-breakpoint
CREATE TRIGGER booking_nights_set_updated_at
  BEFORE UPDATE ON booking_nights
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE TABLE booking_guests (
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  guest_id   uuid NOT NULL REFERENCES guests(id),
  is_primary boolean NOT NULL DEFAULT false,
  PRIMARY KEY (booking_id, guest_id)
);
--> statement-breakpoint

-- ===========================================================================
-- 7. MONEY: folio, payments, invoices
-- ===========================================================================
CREATE TABLE folio_charges (
  id            uuid PRIMARY KEY DEFAULT new_id(),
  property_id   uuid NOT NULL REFERENCES properties(id),
  booking_id    uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  charge_type   charge_type NOT NULL,
  description   text NOT NULL,
  quantity      numeric(10,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_amount   numeric(14,2) NOT NULL,
  tax_rate      numeric(5,2) NOT NULL DEFAULT 0,
  tax_amount    numeric(14,2) NOT NULL DEFAULT 0,
  total_amount  numeric(14,2) NOT NULL,
  charge_date   date NOT NULL,
  source_night_id uuid REFERENCES booking_nights(id),
  is_voided     boolean NOT NULL DEFAULT false,
  voided_by     uuid REFERENCES users(id),
  voided_reason text,
  posted_by     uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX folio_booking_idx ON folio_charges (booking_id) WHERE NOT is_voided;
--> statement-breakpoint
CREATE INDEX folio_date_idx ON folio_charges (property_id, charge_date) WHERE NOT is_voided;
--> statement-breakpoint
CREATE UNIQUE INDEX folio_room_night_uq ON folio_charges (source_night_id) WHERE source_night_id IS NOT NULL AND NOT is_voided;
--> statement-breakpoint
CREATE TRIGGER folio_charges_set_updated_at
  BEFORE UPDATE ON folio_charges
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE TABLE invoices (
  id              uuid PRIMARY KEY DEFAULT new_id(),
  property_id     uuid NOT NULL REFERENCES properties(id),
  booking_id      uuid NOT NULL REFERENCES bookings(id),
  invoice_number  text NOT NULL,
  status          invoice_status NOT NULL DEFAULT 'draft',
  issued_at       timestamptz,
  due_date        date,
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
--> statement-breakpoint
CREATE UNIQUE INDEX invoices_number_uq ON invoices (property_id, invoice_number);
--> statement-breakpoint
CREATE INDEX invoices_booking_idx ON invoices (booking_id);
--> statement-breakpoint
CREATE TRIGGER invoices_set_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

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
--> statement-breakpoint
CREATE INDEX invoice_lines_invoice_idx ON invoice_lines (invoice_id);
--> statement-breakpoint

CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT new_id(),
  property_id     uuid NOT NULL REFERENCES properties(id),
  booking_id      uuid REFERENCES bookings(id),
  invoice_id      uuid REFERENCES invoices(id),
  receipt_number  text NOT NULL,
  payment_type    payment_type NOT NULL DEFAULT 'payment',
  amount          numeric(14,2) NOT NULL CHECK (amount > 0),
  method          payment_method NOT NULL,
  status          payment_status NOT NULL DEFAULT 'completed',
  reference       text,
  payer_name      text,
  paid_at         timestamptz NOT NULL DEFAULT now(),
  business_date   date NOT NULL,
  notes           text,
  reversal_of     uuid REFERENCES payments(id),
  reversed_by     uuid REFERENCES users(id),
  reversed_reason text,
  idempotency_key text,
  recorded_by     uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX payments_receipt_uq ON payments (property_id, receipt_number);
--> statement-breakpoint
CREATE UNIQUE INDEX payments_idempotency_uq ON payments (property_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX payments_reference_uq ON payments (property_id, method, upper(reference)) WHERE reference IS NOT NULL AND reference <> '' AND status = 'completed';
--> statement-breakpoint
CREATE INDEX payments_booking_idx ON payments (booking_id);
--> statement-breakpoint
CREATE INDEX payments_date_idx ON payments (property_id, business_date, method);
--> statement-breakpoint
CREATE TRIGGER payments_set_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE TABLE number_sequences (
  property_id uuid NOT NULL REFERENCES properties(id),
  name        text NOT NULL,
  prefix      text NOT NULL,
  period      text NOT NULL,
  next_value  bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (property_id, name, period)
);
--> statement-breakpoint

-- ===========================================================================
-- 8. MAINTENANCE & EXPENSES
-- ===========================================================================
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
--> statement-breakpoint
CREATE INDEX maintenance_updates_issue_idx ON maintenance_updates (issue_id);
--> statement-breakpoint

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
--> statement-breakpoint
CREATE UNIQUE INDEX expense_categories_uq ON expense_categories (property_id, lower(name)) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER expense_categories_set_updated_at
  BEFORE UPDATE ON expense_categories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE TABLE expenses (
  id                   uuid PRIMARY KEY DEFAULT new_id(),
  property_id          uuid NOT NULL REFERENCES properties(id),
  reference            text NOT NULL,
  category_id          uuid NOT NULL REFERENCES expense_categories(id),
  maintenance_issue_id uuid REFERENCES maintenance_issues(id),
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
--> statement-breakpoint
CREATE UNIQUE INDEX expenses_reference_uq ON expenses (property_id, reference);
--> statement-breakpoint
CREATE INDEX expenses_date_idx ON expenses (property_id, expense_date, category_id) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX expenses_maintenance_idx ON expenses (maintenance_issue_id) WHERE maintenance_issue_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER expenses_set_updated_at
  BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

CREATE VIEW maintenance_cost_view AS
  SELECT m.id AS issue_id,
         m.property_id,
         m.estimated_cost,
         COALESCE(SUM(e.amount) FILTER (WHERE e.deleted_at IS NULL), 0) AS actual_cost,
         COUNT(e.id) FILTER (WHERE e.deleted_at IS NULL) AS expense_count
  FROM maintenance_issues m
  LEFT JOIN expenses e ON e.maintenance_issue_id = m.id
  GROUP BY m.id, m.property_id, m.estimated_cost;
--> statement-breakpoint

-- ===========================================================================
-- 9. CROSS-CUTTING: audit, jobs, stats, notifications
-- ===========================================================================
CREATE TABLE activity_logs (
  id          bigserial PRIMARY KEY,
  property_id uuid REFERENCES properties(id),
  actor_id    uuid REFERENCES users(id),
  actor_name  text NOT NULL,
  actor_role  user_role,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   uuid,
  summary     text NOT NULL,
  changes     jsonb,
  ip_address  inet,
  user_agent  text,
  request_id  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX activity_entity_idx ON activity_logs (entity_type, entity_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX activity_actor_idx  ON activity_logs (actor_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX activity_action_idx ON activity_logs (action, created_at DESC);
--> statement-breakpoint
-- Append-only: no UPDATE, no DELETE, even for the migrator.
CREATE RULE activity_logs_no_update AS ON UPDATE TO activity_logs DO INSTEAD NOTHING;
--> statement-breakpoint
CREATE RULE activity_logs_no_delete AS ON DELETE TO activity_logs DO INSTEAD NOTHING;
--> statement-breakpoint

CREATE TABLE job_queue (
  id            bigserial PRIMARY KEY,
  property_id   uuid REFERENCES properties(id),
  job_type      text NOT NULL,
  payload       jsonb NOT NULL,
  status        job_status NOT NULL DEFAULT 'pending',
  priority      smallint NOT NULL DEFAULT 5,
  run_after     timestamptz NOT NULL DEFAULT now(),
  attempts      smallint NOT NULL DEFAULT 0,
  max_attempts  smallint NOT NULL DEFAULT 5,
  last_error    text,
  dedupe_key    text,
  locked_at     timestamptz,
  locked_by     text,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX job_queue_ready_idx ON job_queue (status, run_after, priority) WHERE status IN ('pending','processing');
--> statement-breakpoint
CREATE UNIQUE INDEX job_queue_dedupe_uq ON job_queue (dedupe_key) WHERE dedupe_key IS NOT NULL AND status <> 'dead';
--> statement-breakpoint

CREATE TABLE daily_stats (
  property_id      uuid NOT NULL REFERENCES properties(id),
  business_date    date NOT NULL,
  rooms_total      integer NOT NULL,
  rooms_sellable   integer NOT NULL,
  rooms_sold       integer NOT NULL,
  occupancy_pct    numeric(5,2) NOT NULL,
  room_revenue     numeric(14,2) NOT NULL,
  other_revenue    numeric(14,2) NOT NULL,
  total_revenue    numeric(14,2) NOT NULL,
  adr              numeric(14,2) NOT NULL,
  revpar           numeric(14,2) NOT NULL,
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
--> statement-breakpoint

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT new_id(),
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  role       user_role,
  type       text NOT NULL,
  title      text NOT NULL,
  body       text,
  link       text,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX notifications_unread_idx ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
--> statement-breakpoint

-- ===========================================================================
-- 10. CIRCULAR FOREIGN KEYS (added last, same migration)
-- Only the truly circular references belong here: settings→users and
-- properties→files (each created before its target). payments→invoices and
-- room_allocations→maintenance_issues are already declared inline because their
-- targets are created first.
-- ===========================================================================
ALTER TABLE settings ADD CONSTRAINT settings_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users(id);
--> statement-breakpoint
ALTER TABLE properties ADD CONSTRAINT properties_logo_file_fk FOREIGN KEY (logo_file_id) REFERENCES files(id);
--> statement-breakpoint

-- ===========================================================================
-- 11. FINAL PRIVILEGES FOR hms_app (least privilege)
-- ===========================================================================
-- The blueprint revokes DELETE on financial records so they are append-only
-- for the application role. Global grants come from 0000 defaults; the revokes
-- below take precedence.
--> statement-breakpoint
REVOKE DELETE ON payments, invoices, invoice_lines, folio_charges, activity_logs, booking_nights, job_queue FROM hms_app;
--> statement-breakpoint
