/**
 * UI mirror of the backend permission matrix (modules/identity/permissions.ts).
 *
 * THE SERVER IS THE AUTHORITY (requirePermission). These helpers only show and
 * hide UI affordances; they must never be treated as authorization.
 */
import type { UserRole } from './types';

export const ROLE_VIEW_PERMISSIONS: Record<UserRole, readonly string[]> = {
  admin: [],
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

export function can(role: UserRole | null | undefined, permission: string): boolean {
  if (!role) return false;
  if (role === 'admin') return true;
  return ROLE_VIEW_PERMISSIONS[role].includes(permission);
}

export function hasRole(
  role: UserRole | null | undefined,
  required: UserRole | readonly UserRole[],
): boolean {
  if (!role) return false;
  return Array.isArray(required) ? required.includes(role) : role === required;
}