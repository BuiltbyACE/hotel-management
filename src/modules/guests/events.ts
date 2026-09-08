/**
 * modules/guests/events.ts
 *
 * Guest lifecycle events (blueprint §15.3). Subscribers: audit trail,
 * notifications happen at the calling boundary, not here.
 */
export const GUEST_EVENTS = {
  guestCreated: 'guest.created',
  guestUpdated: 'guest.updated',
  guestBlacklisted: 'guest.blacklisted',
  guestUnblacklisted: 'guest.unblacklisted',
  guestDeleted: 'guest.deleted',
  guestMerged: 'guest.merged',
  guestDocumentUploaded: 'guest.document_uploaded',
} as const;

export type GuestEventName = (typeof GUEST_EVENTS)[keyof typeof GUEST_EVENTS];