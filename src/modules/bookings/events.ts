/**
 * modules/bookings/events.ts
 *
 * Booking lifecycle events (blueprint §15.3). Audit and the outbox ride on
 * these; side effects that must survive a rollback go through core/jobs.
 */
export const BOOKING_EVENTS = {
  bookingCreated: 'booking.created',
  bookingConfirmed: 'booking.confirmed',
  bookingCheckedIn: 'booking.checked_in',
  bookingCheckedOut: 'booking.checked_out',
  bookingCancelled: 'booking.cancelled',
  paymentRecorded: 'payment.recorded',
  paymentReversed: 'payment.reversed',
} as const;

export type BookingEventName = (typeof BOOKING_EVENTS)[keyof typeof BOOKING_EVENTS];