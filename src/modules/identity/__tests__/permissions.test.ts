/**
 * Unit tests: the permission catalogue is the whole authorization story, so it
 * gets its own pure test — no DB, no HTTP.
 * [ERP-DNA: locked-down role matrix]
 */
import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLE_LEVEL,
  canModifyUser,
} from '@/modules/identity/permissions';
import { can, resolvePermissions } from '@/modules/identity/auth-guard';
import type { Actor } from '@/modules/identity/auth-guard';

function actor(role: Actor['role'], overrides: { permission: string; allowed: boolean }[] = []): Actor {
  return {
    id: 'u-' + role,
    name: role,
    email: `${role}@hotmail.test`,
    role,
    propertyId: null,
    permissions: resolvePermissions(role, overrides),
  };
}

describe('permission catalogue', () => {
  it('admin holds every declared permission', () => {
    expect(ROLE_PERMISSIONS.admin).toEqual(PERMISSIONS);
    for (const p of PERMISSIONS) expect(can(actor('admin'), p)).toBe(true);
  });

  it('declares the exact 62 permissions from §9.3', () => {
    expect(PERMISSIONS).toHaveLength(62);
  });

  it('manager read-only on users, never financial overrides', () => {
    const a = actor('manager');
    expect(can(a, 'users.read')).toBe(true);
    expect(can(a, 'users.create')).toBe(false);
    expect(can(a, 'users.deactivate')).toBe(false);
    expect(can(a, 'bookings.override_rate')).toBe(true);
    expect(can(a, 'payments.reverse')).toBe(true);
    expect(can(a, 'payments.refund')).toBe(true);
    expect(can(a, 'expenses.delete')).toBe(false);
  });

  it('receptionist is front-desk only', () => {
    const a = actor('receptionist');
    expect(can(a, 'guests.create')).toBe(true);
    expect(can(a, 'bookings.create')).toBe(true);
    expect(can(a, 'frontdesk.check_in')).toBe(true);
    expect(can(a, 'frontdesk.night_audit')).toBe(false);
    expect(can(a, 'bookings.override_rate')).toBe(false);
    expect(can(a, 'payments.record')).toBe(true);
    expect(can(a, 'payments.reverse')).toBe(false);
    expect(can(a, 'rooms.change_condition')).toBe(true);
    expect(can(a, 'expenses.create')).toBe(false);
    expect(can(a, 'reports.financial')).toBe(false);
  });
});

describe('role ordering', () => {
  it('admin > manager > receptionist', () => {
    expect(ROLE_LEVEL.admin).toBe(100);
    expect(ROLE_LEVEL.manager).toBe(50);
    expect(ROLE_LEVEL.receptionist).toBe(10);
  });

  it('a user may only administer strictly below their level', () => {
    expect(canModifyUser({ role: 'admin' }, { role: 'receptionist' })).toBe(true);
    expect(canModifyUser({ role: 'admin' }, { role: 'manager' })).toBe(true);
    expect(canModifyUser({ role: 'admin' }, { role: 'admin' })).toBe(false);
    expect(canModifyUser({ role: 'manager' }, { role: 'receptionist' })).toBe(true);
    expect(canModifyUser({ role: 'manager' }, { role: 'manager' })).toBe(false);
    expect(canModifyUser({ role: 'receptionist' }, { role: 'admin' })).toBe(false);
  });
});

describe('resolvePermissions', () => {
  it('grants an override on top of the base role', () => {
    const a = actor('receptionist', [{ permission: 'payments.reverse', allowed: true }]);
    expect(can(a, 'payments.reverse')).toBe(true);
  });

  it('denies a base permission via override', () => {
    const a = actor('manager', [{ permission: 'payments.reverse', allowed: false }]);
    expect(can(a, 'payments.reverse')).toBe(false);
  });

  it('ignores unknown permission strings', () => {
    const a = actor('receptionist', [{ permission: 'not.a.real.permission', allowed: true }]);
    expect(a.permissions.has('not.a.real.permission' as never)).toBe(false);
    expect(can(a, 'guests.create')).toBe(true);
  });

  it('override grant does not leak into unrelated permissions', () => {
    const a = actor('receptionist', [{ permission: 'bookings.override_rate', allowed: true }]);
    expect(can(a, 'bookings.override_rate')).toBe(true);
    expect(can(a, 'payments.refund')).toBe(false);
  });
});