/**
 * Business expenses — the half of a P&L that orders cannot tell you.
 *
 * The category list is here and nowhere else: the admin form, the P&L and the
 * Excel export all read it, and a list restated in three files is three lists
 * that drift. It matches the CHECK constraint in migration 0040 exactly — if
 * one changes, both must.
 */

export const EXPENSE_CATEGORIES = [
  "shipping",
  "marketing",
  "software",
  "packaging",
  "rent",
  "salaries",
  "misc",
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

const LABELS: Record<ExpenseCategory, string> = {
  shipping: "Shipping & Courier",
  marketing: "Marketing",
  software: "Software & Subscriptions",
  packaging: "Packaging",
  rent: "Rent",
  salaries: "Salaries",
  misc: "Miscellaneous",
};

export function categoryLabel(category: ExpenseCategory | string): string {
  return LABELS[category as ExpenseCategory] ?? category;
}

export function isExpenseCategory(value: string): value is ExpenseCategory {
  return (EXPENSE_CATEGORIES as readonly string[]).includes(value);
}

export interface Expense {
  id: string;
  category: ExpenseCategory;
  amount_inr: number | string;
  /** A date, not a timestamp — an expense belongs to a day and a period. */
  incurred_on: string;
  description: string | null;
  vendor: string | null;
  reference: string | null;
  /** GST paid, for input credit. Null until the shop is registered. */
  tax_inr: number | string | null;
  created_at: string;
}

/**
 * The Indian financial year containing a date: 1 April to 31 March.
 *
 * Here rather than in the component because the P&L, the year-end export and
 * the expense screen all need the same boundary, and getting it wrong by one
 * day moves revenue into the wrong year.
 */
export function financialYear(on: Date = new Date()): { from: string; to: string; label: string } {
  const startYear = on.getMonth() >= 3 ? on.getFullYear() : on.getFullYear() - 1;
  return {
    from: `${startYear}-04-01`,
    to: `${startYear + 1}-03-31`,
    label: `FY ${startYear}–${String(startYear + 1).slice(2)}`,
  };
}
