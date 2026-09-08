-- ===========================================================================
-- 0002_better_auth.sql — Better Auth 1.7 backing tables
--
-- Better Auth owns identity: it manages `session`, `account`, `verification`
-- and (via the adapter schema map) our existing `users` table. This migration
-- adds exactly what Better Auth's emailAndPassword + twoFactor plugins need:
--   * the three standard tables (session / account / verification)
--   * a `two_factor` table for the twoFactor plugin (v1.7 keeps TOTP secrets
--     and backup codes in its own table, keyed to users.two_factor_enabled)
--
-- The plugin's user-model additions (role, two_factor_enabled) already exist
-- from 0001. DML is auto-granted to hms_app by the ALTER DEFAULT PRIVILEGES
-- in 0000.
-- ===========================================================================

CREATE TABLE session (
  id         text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  token      text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX session_user_idx ON session (user_id);
--> statement-breakpoint

CREATE TABLE account (
  id                       text PRIMARY KEY,
  account_id               text NOT NULL,
  provider_id              text NOT NULL,
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token             text,
  refresh_token            text,
  id_token                 text,
  access_token_expires_at  timestamptz,
  refresh_token_expires_at timestamptz,
  scope                    text,
  password                 text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX account_user_idx ON account (user_id);
--> statement-breakpoint
CREATE INDEX account_provider_idx ON account (provider_id, account_id);
--> statement-breakpoint

CREATE TABLE verification (
  id         text PRIMARY KEY,
  identifier text NOT NULL,
  value      text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX verification_identifier_idx ON verification (identifier);
--> statement-breakpoint

-- ---------- twoFactor plugin table -----------------------------------------
-- better-auth v1.7 keeps TOTP secrets + backup codes in a dedicated table
-- (model 'twoFactor'), one row per user.
CREATE TABLE two_factor (
  id                       text PRIMARY KEY,
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret                   text NOT NULL,
  backup_codes             text NOT NULL,
  verified                 boolean NOT NULL DEFAULT true,
  failed_verification_count integer NOT NULL DEFAULT 0,
  locked_until             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX two_factor_user_idx ON two_factor (user_id);
--> statement-breakpoint
CREATE INDEX two_factor_secret_idx ON two_factor (secret);
--> statement-breakpoint