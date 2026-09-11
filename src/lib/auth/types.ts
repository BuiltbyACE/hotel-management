export type UserRole = 'admin' | 'manager' | 'receptionist';
export type UserStatus = 'active' | 'suspended' | 'disabled';

/** The session user shape the frontend consumes (server is always authoritative). */
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  propertyId: string | null;
  mustChangePassword: boolean;
  twoFactorEnabled: boolean;
  emailVerified: boolean;
}