/**
 * modules/expenses/events.ts
 *
 * Expense domain events (§14.2). Emitted inside the writer transaction.
 */
export const EXPENSE_EVENTS = {
  expenseCreated: 'expense.created',
  expenseUpdated: 'expense.updated',
  expenseApproved: 'expense.approved',
  expenseRejected: 'expense.rejected',
  expenseDeleted: 'expense.deleted',
} as const;

export interface ExpenseEvent {
  expenseId: string;
  reference: string;
  propertyId: string;
  amount: string;
  by: string;
  status?: string;
}