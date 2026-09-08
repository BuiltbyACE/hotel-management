/**
 * modules/identity/events.ts
 *
 * Events the identity context emits. Audit subscribes to these to write
 * activity_logs entries (audit module, later milestone).
 */
export const IDENTITY_EVENTS = {
  userCreated: 'user.created',
  userUpdated: 'user.updated',
  userDeactivated: 'user.deactivated',
  userPasswordReset: 'user.password_reset',
  userPermissionChanged: 'user.permission_changed',
} as const;

export type IdentityEventName = (typeof IDENTITY_EVENTS)[keyof typeof IDENTITY_EVENTS];