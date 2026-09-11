import { describe, expect, it } from 'vitest';
import { can, hasRole } from '@/lib/auth/permissions';

describe('UI permission mirror', () => {
  it('admin can do anything', () => {
    expect(can('admin', 'reports.financial')).toBe(true);
    expect(can('admin', 'users.reset_password')).toBe(true);
  });

  it('receptionist gets the front-desk subset but not money reporting', () => {
    expect(can('receptionist', 'frontdesk.check_in')).toBe(true);
    expect(can('receptionist', 'bookings.create')).toBe(true);
    expect(can('receptionist', 'reports.financial')).toBe(false);
    expect(can('receptionist', 'users.reset_password')).toBe(false);
  });

  it('manager spans supervision permissions but not admin-only grants', () => {
    expect(can('manager', 'reports.financial')).toBe(true);
    expect(can('manager', 'payments.refund')).toBe(true);
    expect(can('manager', 'users.deactivate')).toBe(false);
  });

  it('returns false for missing roles', () => {
    expect(can(undefined, 'rooms.read')).toBe(false);
    expect(can(null, 'rooms.read')).toBe(false);
  });

  it('hasRole handles single and union roles', () => {
    expect(hasRole('admin', 'admin')).toBe(true);
    expect(hasRole('receptionist', ['manager', 'receptionist'])).toBe(true);
    expect(hasRole('receptionist', 'manager')).toBe(false);
    expect(hasRole(undefined, 'admin')).toBe(false);
  });
});