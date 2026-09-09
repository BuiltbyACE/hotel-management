/**
 * modules/billing/types.ts
 *
 * Money: folio, charges, invoices, receipts (blueprint §12, §16.3 finance
 * endpoints). Every money field crosses the JSON boundary as a string
 * (core/money rule); `chargeDate`/`stayDate` are DateOnly strings; timestamps
 * are ISO-8601.
 */

export type ChargeType = 'room' | 'tax' | 'levy' | 'extra' | 'service' | 'discount' | 'adjustment';

export interface PostChargeInput {
  chargeType: ChargeType;
  description: string;
  quantity: number;
  /** Signed unit amount as a string ("1250.00", negative for discounts). */
  unitAmount: string;
}

export interface VoidChargeInput {
  reason: string;
}

export interface FolioChargeView {
  id: string;
  bookingId: string;
  chargeType: ChargeType;
  description: string;
  quantity: string;
  unitAmount: string;
  taxRate: string;
  taxAmount: string;
  totalAmount: string;
  chargeDate: string;
  isVoided: boolean;
  voidedBy: string | null;
  voidedReason: string | null;
}

export interface FolioPaymentView {
  id: string;
  receiptNumber: string;
  paymentType: string;
  amount: string;
  method: string;
  status: string;
  reference: string | null;
  paidAt: string;
  reversalOf: string | null;
}

export interface FolioView {
  booking: {
    id: string;
    reference: string;
    status: string;
    guestName: string;
    totalCharges: string;
    totalPaid: string;
    balance: string;
  };
  charges: FolioChargeView[];
  payments: FolioPaymentView[];
  subtotal: string;
  taxTotal: string;
  discountTotal: string;
  grandTotal: string;
  currency: string;
}

export interface InvoiceLineView {
  id: string;
  description: string;
  quantity: string;
  unitAmount: string;
  taxRate: string;
  taxAmount: string;
  totalAmount: string;
}

export interface InvoiceView {
  id: string;
  propertyId: string;
  bookingId: string;
  invoiceNumber: string;
  status: string;
  issuedAt: string | null;
  dueDate: string | null;
  billToName: string;
  billToAddress: string | null;
  billToTaxPin: string | null;
  subtotal: string;
  taxTotal: string;
  discountTotal: string;
  grandTotal: string;
  amountPaid: string;
  balance: string;
  currency: string;
  voidReason: string | null;
  issuedBy: string | null;
  createdAt: string;
  lines: InvoiceLineView[];
}

export interface InvoiceListFilters {
  status?: string;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

export interface IssueInvoiceInput {
  bookingId: string;
}

export interface VoidInvoiceInput {
  reason: string;
}