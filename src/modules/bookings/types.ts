/**
 * modules/bookings/types.ts
 *
 * Reservation lifecycle views (blueprint §11). Money fields cross the JSON
 * boundary as strings (core/money rule); dates are DateOnly strings.
 */

export interface BookingGuestInput {
  fullName: string;
  phone?: string | null;
  email?: string | null;
  idType?: string | null;
  idNumber?: string | null;
}

export interface BookingLineInput {
  roomId: string;
  arrival: string;
  departure: string;
  adults: number;
  children: number;
  overrideRate?: number | null;
}

export interface BookingPaymentInput {
  amount: string;
  method: 'cash' | 'mpesa' | 'card' | 'bank_transfer' | 'cheque' | 'other';
  reference?: string | null;
  notes?: string | null;
}

export interface CreateBookingInput {
  guest: BookingGuestInput;
  source: 'walk_in' | 'phone' | 'email' | 'front_desk' | 'online' | 'ota' | 'corporate';
  rooms: BookingLineInput[];
  specialRequests?: string | null;
  internalNotes?: string | null;
  payment?: BookingPaymentInput | null;
  idempotencyKey?: string | null;
}

export interface BookingView {
  id: string;
  propertyId: string;
  reference: string;
  guestId: string;
  status: string;
  source: string;
  arrivalDate: string;
  departureDate: string;
  nights: number;
  adults: number;
  children: number;
  guestNameSnapshot: string;
  guestPhoneSnapshot: string | null;
  totalCharges: string;
  totalPaid: string;
  balance: string;
  specialRequests: string | null;
  internalNotes: string | null;
  cancellationReason: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  checkedInAt: string | null;
  checkedInBy: string | null;
  checkedOutAt: string | null;
  checkedOutBy: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentView {
  id: string;
  propertyId: string;
  bookingId: string | null;
  receiptNumber: string;
  paymentType: string;
  amount: string;
  method: string;
  status: string;
  reference: string | null;
  payerName: string | null;
  paidAt: string;
  notes: string | null;
  reversalOf: string | null;
  reversedReason: string | null;
}

export interface CheckoutOptions {
  /** Trim allocations to an early departure date (YYYY-MM-DD). */
  earlyDeparture?: string | null;
}

export interface CancelBookingInput {
  reason: string;
}

export interface RecordPaymentInput {
  amount: string;
  method: 'cash' | 'mpesa' | 'card' | 'bank_transfer' | 'cheque' | 'other';
  reference?: string | null;
  notes?: string | null;
  idempotencyKey?: string | null;
}

export interface ReversePaymentInput {
  reason: string;
}