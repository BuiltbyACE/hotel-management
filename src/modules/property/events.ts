/**
 * modules/property/events.ts
 *
 * Events the property context emits (blueprint §15.3 catalogue). Audit and
 * the housekeeping board subscribe to these in later milestones.
 */
export const PROPERTY_EVENTS = {
  roomTypeCreated: 'room_type.created',
  roomTypeUpdated: 'room_type.updated',
  roomTypeDeleted: 'room_type.deleted',
  roomCreated: 'room.created',
  roomUpdated: 'room.updated',
  roomDeleted: 'room.deleted',
  roomConditionChanged: 'room.condition_changed',
  rateRuleCreated: 'rate_rule.created',
  settingsUpdated: 'setting.updated',
} as const;

export type PropertyEventName = (typeof PROPERTY_EVENTS)[keyof typeof PROPERTY_EVENTS];