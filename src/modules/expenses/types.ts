/**
 * modules/expenses/types.ts
 *
 * Public types for the expense module (blueprint §14.2). Unions mirror the DB
 * enums locally — module boundary rules forbid importing another schema.
 */
export type ExpenseStatus = 'recorded' | 'approved' | 'rejected';
export type ExpenseMethod = 'cash' | 'mpesa' | 'card' | 'bank_transfer' | 'cheque' | 'other';

export interface CategoryView {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

export interface ExpenseView {
  id: string;
  reference: string;
  categoryId: string;
  categoryName: string;
  maintenanceIssueId: string | null;
  maintenanceReference: string | null;
  description: string;
  amount: string;
  expenseDate: string;
  method: ExpenseMethod;
  referenceNumber: string | null;
  vendor: string | null;
  status: ExpenseStatus;
  receiptFileId: string | null;
  recordedBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
}