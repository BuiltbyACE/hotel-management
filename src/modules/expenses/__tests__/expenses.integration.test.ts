/**
 * Integration test: expenses (§14.2, spec A11/A12).
 *
 * The spec's 11 categories seed on first use. Approval is setting-gated at
 * expense_approval_threshold; expense rows that touch money are append-only
 * for the app role, so expenses + the linked maintenance issue + rooms are
 * documented residue and the property/user stay behind for the audit FKs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { withTx, schema } from '@/core/db';
import { resolvePermissions, type Actor } from '@/modules/identity/auth-guard';
import { reportIssue, getIssue } from '@/modules/maintenance/service';
import {
  listExpenseCategories,
  createExpense,
  getExpense,
  updateExpense,
  approveExpense,
  deleteExpense,
  listExpensesService,
} from '../service';
import { expensePatchSchema, type CreateExpenseInput } from '../validation';

vi.setConfig({ testTimeout: 60_000 });

function actor(id: string, propertyId: string | null): Actor {
  return {
    id,
    name: 'EX Admin',
    email: `ex-admin-${randomUUID().slice(0, 6)}@hms.test`,
    role: 'admin',
    propertyId,
    permissions: resolvePermissions('admin', []),
  };
}

const ACTOR = actor('', null);

let userId = '';
let propertyId = '';
let maintenanceIssueId = '';
const expenseIds: string[] = [];

async function seed() {
  await withTx(async (tx) => {
    userId = randomUUID();
    await tx.insert(schema.users).values({
      id: userId,
      name: 'EX Admin',
      email: `ex-admin-${randomUUID().slice(0, 8)}@hms.test`,
      role: 'admin',
      status: 'active',
      mustChangePassword: true,
      createdBy: null,
    });
    await tx.insert(schema.accounts).values({
      id: randomUUID(),
      userId,
      providerId: 'credential',
      accountId: userId,
      password: 'not-used-in-tests',
    });
    const propId = await tx
      .insert(schema.properties)
      .values({ name: `EX Hotel ${randomUUID().slice(0, 6)}` })
      .returning({ id: schema.properties.id })
      .then((rows) => rows[0]!.id);
    propertyId = propId;
  });
  ACTOR.id = userId;
  ACTOR.propertyId = propertyId;
}

beforeAll(async () => {
  await withTx((tx) =>
    tx.insert(schema.settings).values({ key: 'expense_approval_threshold', value: 50000 }).onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: sql`excluded.value`, updatedAt: sql`now()` },
    }),
  );
await seed();

  const maintenanceCost = 18500;
  const issue = await reportIssue(
    {
      title: 'Repair garage door',
      description: 'Broken motor',
      location: 'Garage',
      estimatedCost: maintenanceCost.toString(),
      takesRoomOffline: false,
    },
    ACTOR,
  );
  maintenanceIssueId = issue.id;
});

afterAll(async () => {
  // Expense + maintenance rows are cleanup residue: the app role has no DELETE
  // on money tables, so documented residue is the honest teardown. Any blocks
  // this suite created are freed here so later runs start clean.
  await withTx(async (tx) => {
    if (maintenanceIssueId) {
      await tx.delete(schema.roomAllocations).where(eq(schema.roomAllocations.propertyId, propertyId));
    }
  });
});

async function seededCategory(name: string): Promise<string> {
  const categories = await listExpenseCategories(ACTOR);
  return categories.find((c) => c.name === name)!.id;
}

async function make(input: Partial<CreateExpenseInput> & { description: string; amount: string }) {
  const expense = await createExpense(
    {
      maintenanceIssueId: undefined,
      categoryName: 'Maintenance and Repairs',
      method: 'cash',
      ...input,
    } as CreateExpenseInput & { categoryName: string },
    ACTOR,
  );
  expenseIds.push(expense.id);
  return expense;
}

describe('categories', () => {
  it('seeds the spec’s 11 categories', async () => {
    const categories = await listExpenseCategories(ACTOR);
    const names = categories.map((c) => c.name);
    for (const expected of [
      'Maintenance and Repairs',
      'Electricity and Utilities',
      'Water',
      'Internet and Communication',
      'Cleaning Supplies',
      'Hotel Supplies',
      'Furniture and Equipment',
      'Transport',
      'Marketing',
      'Licenses and Administration',
      'Miscellaneous Expenses',
    ]) {
      expect(names).toContain(expected);
    }
  });
});

describe('createExpense', () => {
  it('creates with a reference and auto-approves below the threshold', async () => {
    const expense = await make({ description: 'Cleaning chemicals', amount: '4500.00', categoryName: 'Cleaning Supplies' });
    expect(expense.reference).toMatch(/^EX-\d{6}$/);
    expect(expense.status).toBe('approved');
    expect(expense.categoryName).toBe('Cleaning Supplies');
  });

  it('links to a maintenance issue and feeds actual cost', async () => {
    const expense = await createExpense(
      {
        description: 'Garage repair labour',
        amount: '18500.00',
        categoryId: await seededCategory('Maintenance and Repairs'),
        maintenanceIssueId,
      },
      ACTOR,
    );
    expenseIds.push(expense.id);

    const view = await getIssue(maintenanceIssueId, ACTOR);
    expect(view.expenseCount).toBeGreaterThanOrEqual(1);
    expect(Number(view.actualCost)).toBeGreaterThanOrEqual(18500);
    expect(expense.maintenanceReference).toBeTruthy();
  });
});

describe('approval workflow', () => {
  it('holds at recorded above the threshold until approved', async () => {
    const expense = await createExpense(
      {
        description: 'Bulk linen purchase',
        amount: '60000.00',
        categoryName: 'Hotel Supplies',
      },
      ACTOR,
    );
    expenseIds.push(expense.id);
    expect(expense.status).toBe('recorded');

    const approved = await approveExpense(expense.id, { status: 'approved' }, ACTOR);
    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toBe(userId);
  });

  it('rejects a rejection without a reason at the schema gate, then records it', async () => {
    const expense = await createExpense(
      {
        description: 'Questionable marketing spend',
        amount: '55000.00',
        categoryName: 'Marketing',
      },
      ACTOR,
    );
    expenseIds.push(expense.id);
    expect(expensePatchSchema.safeParse({ status: 'rejected' }).success).toBe(false);

    const rejected = await approveExpense(expense.id, { status: 'rejected', rejectionReason: 'No PO on file' }, ACTOR);
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectionReason).toBe('No PO on file');
  });

  it('cannot approve an already-approved expense', async () => {
    const expense = await make({ description: 'Tissue boxes', amount: '800.00' });
    await expect(approveExpense(expense.id, { status: 'approved' }, ACTOR)).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
  });
});

describe('editing & deletes', () => {
  it('edits a recorded expense, blocked once approved', async () => {
    const expense = await createExpense(
      {
        description: 'Wildcard spend',
        amount: '99999.00',
        categoryName: 'Miscellaneous Expenses',
      },
      ACTOR,
    );
    expenseIds.push(expense.id);

    const edited = await updateExpense(expense.id, { vendor: 'Supplier One' }, ACTOR);
    expect(edited.vendor).toBe('Supplier One');

    const approved = await approveExpense(expense.id, { status: 'approved' }, ACTOR);
    await expect(updateExpense(expense.id, { vendor: 'Supplier Two' }, ACTOR)).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    expect(approved.status).toBe('approved');
  });

  it('soft-deletes and hides the row plus filters the list', async () => {
    const expense = await make({ description: 'Stationery', amount: '1200.00' });
    await deleteExpense(expense.id, ACTOR);
    await expect(getExpense(expense.id, ACTOR)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const { data } = await listExpensesService({ status: 'approved', page: 1, pageSize: 100 }, ACTOR);
    expect(data.some((e) => e.id === expense.id)).toBe(false);
  });
});
