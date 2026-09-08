/**
 * modules/identity/permissions.ts
 *
 * The static, importable, unit-tested permission matrix (blueprint §9.3).
 *
 * This is the AUTHORITY half of the identity/authority split: Better Auth
 * resolves WHO (`getAuthUser`), this module decides WHAT they may do.
 * `can()` is pure — usable in UI (`<Can>`) and tests; the SERVER check
 * `requirePermission` in auth-guard.ts is the only real authorization.
 *
 * The permission strings are the catalogue for the whole app: every route in
 * /api/v1 hard-references one of these literals.
 */
export const PERMISSIONS = [
  // Users & system
  'users.read', 'users.create', 'users.update', 'users.deactivate', 'users.reset_password',
  'settings.read', 'settings.update', 'audit.read',
  // Inventory
  'rooms.read', 'rooms.create', 'rooms.update', 'rooms.delete',
  'rooms.change_condition',
  'roomtypes.read', 'roomtypes.create', 'roomtypes.update', 'roomtypes.delete',
  'rates.read', 'rates.update',
  // Guests
  'guests.read', 'guests.create', 'guests.update', 'guests.merge',
  'guests.delete', 'guests.blacklist', 'guests.view_documents',
  // Bookings
  'bookings.read', 'bookings.create', 'bookings.update', 'bookings.cancel',
  'bookings.move_room', 'bookings.override_rate', 'bookings.backdate',
  'frontdesk.check_in', 'frontdesk.check_out', 'frontdesk.night_audit',
  // Money
  'payments.read', 'payments.record', 'payments.reverse', 'payments.refund',
  'folio.read', 'folio.post_charge', 'folio.void_charge', 'folio.discount',
  'invoices.read', 'invoices.issue', 'invoices.void',
  // Operations
  'housekeeping.read', 'housekeeping.update',
  'maintenance.read', 'maintenance.report', 'maintenance.update',
  'maintenance.assign', 'maintenance.close',
  'expenses.read', 'expenses.create', 'expenses.update', 'expenses.approve',
  'expenses.delete',
  // Insight
  'reports.operational', 'reports.financial', 'reports.export',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type UserRole = 'admin' | 'manager' | 'receptionist';

/**
 * Role → permission grant, from Appendix C of the blueprint.
 * `admin` is everything; `manager` and `receptionist` are the exact subsets.
 */
export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  admin: PERMISSIONS,
  manager: [
    'users.read',
    'settings.read', 'audit.read',
    'rooms.read', 'rooms.create', 'rooms.update', 'rooms.delete', 'rooms.change_condition',
    'roomtypes.read', 'roomtypes.create', 'roomtypes.update', 'roomtypes.delete',
    'rates.read', 'rates.update',
    'guests.read', 'guests.create', 'guests.update', 'guests.view_documents',
    'guests.merge', 'guests.delete', 'guests.blacklist',
    'bookings.read', 'bookings.create', 'bookings.update', 'bookings.cancel',
    'bookings.move_room', 'bookings.override_rate', 'bookings.backdate',
    'frontdesk.check_in', 'frontdesk.check_out', 'frontdesk.night_audit',
    'payments.read', 'payments.record', 'payments.reverse', 'payments.refund',
    'folio.read', 'folio.post_charge', 'folio.void_charge', 'folio.discount',
    'invoices.read', 'invoices.issue', 'invoices.void',
    'housekeeping.read', 'housekeeping.update',
    'maintenance.read', 'maintenance.report', 'maintenance.update',
    'maintenance.assign', 'maintenance.close',
    'expenses.read', 'expenses.create', 'expenses.update', 'expenses.approve',
    'reports.operational', 'reports.financial', 'reports.export',
  ],
  receptionist: [
    'users.read',
    'rooms.read', 'rooms.change_condition',
    'roomtypes.read',
    'rates.read',
    'guests.read', 'guests.create', 'guests.update', 'guests.view_documents',
    'bookings.read', 'bookings.create', 'bookings.update', 'bookings.cancel',
    'bookings.move_room',
    'frontdesk.check_in', 'frontdesk.check_out',
    'payments.read', 'payments.record',
    'folio.read', 'folio.post_charge',
    'invoices.read', 'invoices.issue',
    'housekeeping.read', 'housekeeping.update',
    'maintenance.read', 'maintenance.report',
    'reports.operational',
  ],
};

/** admin > manager > receptionist. Guards who may modify whom. */
export const ROLE_LEVEL: Record<UserRole, number> = { admin: 100, manager: 50, receptionist: 10 };

/** A user may only administer users strictly below their own level.
 * Equal-seniority users (manager→manager, admin→admin) cannot touch each other.
 * [ERP-DNA: canModifyUser]
 */
export function canModifyUser(actor: { role: UserRole }, target: { role: UserRole }): boolean {
  return ROLE_LEVEL[actor.role] > ROLE_LEVEL[target.role];
}