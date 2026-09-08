/**
 * core/auth/config.ts
 *
 * Better Auth wiring (blueprint §9.1). Better Auth owns identity; the
 * permission matrix and requirePermission live in the identity module and are
 * the "authority" half of the blueprint's identity/authority split.
 *
 * Argon2id hashing (D13). DB sessions → disabling a user kills their access
 * immediately (no JWT window). Cookie-based; mounted at /api/auth by an app
 * route handler.
 */
import { APIError, betterAuth } from 'better-auth';
import type { User as BetterAuthUser } from 'better-auth/types';
import { eq, sql } from 'drizzle-orm';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { twoFactor } from 'better-auth/plugins';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { getDb } from '@/core/db';
import { schema } from '@/core/db/schema';
import { env } from '@/core/config/env';

export const auth = betterAuth({
  database: drizzleAdapter(getDb(), {
    provider: 'pg',
    // Keys MUST be Better Auth's model names (user/session/account/
    // verification/twoFactor). They double as the names the adapter looks up
    // at runtime AND as the actual names of the schema-check diff — any other
    // casing reports every table as "missing" and throws on the first request.
    schema: {
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      verification: schema.verifications,
      twoFactor: schema.twoFactors,
    },
  }),
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  emailAndPassword: {
    enabled: true,
    // Staff accounts are created by an admin (modules/identity service).
    // Public self-signup is never open.
    disableSignUp: true,
    requireEmailVerification: false,
    password: {
      // @node-rs/argon2 exposes Algorithm as a TS ambient const enum, which is
      // invisible under isolatedModules — Argon2id is its numeric value (2).
      hash: async (password) => argon2Hash(password, { algorithm: 2 }),
      verify: async ({ password, hash }) => argon2Verify(hash, password),
    },
    resetPasswordTokenExpiresIn: 60 * 30,
  },
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          // Non-active users (suspended/disabled) are refused a NEW session.
          // Deactivation already revokes existing sessions (§9.4); without
          // this gate a disabled user with a valid password could re-login.
          // Throwing as the admin plugin does converts to a 403 by the
          // transport, without touching last_login_at.
          const rows = await getDb()
            .select({ status: schema.users.status })
            .from(schema.users)
            .where(eq(schema.users.id, session.userId))
            .limit(1);
          const status = rows[0]?.status ?? 'active';
          if (status !== 'active') {
            throw APIError.from('FORBIDDEN', {
              code: status === 'suspended' ? 'ACCOUNT_SUSPENDED' : 'ACCOUNT_DISABLED',
              message:
                status === 'suspended'
                  ? 'This account is suspended. Contact your administrator.'
                  : 'This account has been disabled. Contact your administrator.',
            });
          }
          // Stamp last_login_at on the user row. The column exists for
          // exactly this reason; fire-and-forget inside the hook.
          await getDb().update(schema.users).set({ lastLoginAt: new Date() }).where(sql`id = ${session.userId}`);
        },
      },
    },
  },
  session: {
    expiresIn: 60 * 60 * 12, // 12h — one shift
    updateAge: 60 * 15,
    freshAge: 60 * 10, // sensitive ops require a fresh session
    cookieCache: { enabled: true, maxAge: 60 },
  },
  user: {
    additionalFields: {
      role: { type: 'string', defaultValue: 'receptionist', input: false },
      status: { type: 'string', defaultValue: 'active', input: false },
      propertyId: { type: 'string', input: false },
      mustChangePassword: { type: 'boolean', defaultValue: true, input: false },
      twoFactorEnabled: { type: 'boolean', defaultValue: false, input: false },
    },
  },
  plugins: [
    // NO admin plugin: user management runs through the identity module so
    // every mutation passes requirePermission's matrix. Its ban fields and
    // session.impersonatedBy aren't in the schema, and its endpoints would be
    // an unauthenticated-by-requirePermission surface.
    twoFactor({ issuer: 'Hotel Management System' }), // TOTP — the ERP had no MFA
  ],
  rateLimit: { enabled: true, window: 60, max: 20 },
  advanced: { useSecureCookies: env.NODE_ENV === 'production' },
  trustedOrigins: [env.APP_URL],
});

/**
 * The user row better-auth returns + our additionalFields.
 * Role/status/propertyId come through additionalFields.
 */
export type AuthUser = BetterAuthUser & {
  role: 'admin' | 'manager' | 'receptionist';
  status: 'active' | 'suspended' | 'disabled';
  propertyId: string | null;
  mustChangePassword: boolean;
  twoFactorEnabled: boolean;
};