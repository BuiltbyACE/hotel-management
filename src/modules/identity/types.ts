/**
 * modules/identity/types.ts
 *
 * Domain types for the identity context. The shared enums live on the schema
 * (user_role / user_status); these are the shape-level types routes and
 * services exchange. Actor + Permission come from auth-guard.ts / permissions.ts.
 */

export type { UserRole } from './permissions';

export type UserStatus = 'active' | 'suspended' | 'disabled';

/** Public view of a user row (what the API returns). Never includes secrets. */
export interface UserView {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: string;
  status: UserStatus;
  phone: string | null;
  propertyId: string | null;
  mustChangePassword: boolean;
  passwordChangedAt: string | null;
  lastLoginAt: string | null;
  twoFactorEnabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserListView extends UserView {
  overrides: { permission: string; allowed: boolean }[];
}