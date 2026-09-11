/**
 * The Better Auth client — the identity contract layer for session mutations.
 * Sign-out and change-password run through this; login and TOTP verification go
 * through the thin fetch wrapper (lib/api/client) to read Retry-After exactly.
 */
import { createAuthClient } from 'better-auth/react';
import { twoFactorClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  plugins: [twoFactorClient()],
});

export type AuthClient = typeof authClient;