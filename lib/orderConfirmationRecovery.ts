import { createServiceClient } from "./supabase";
import { emailConfigured } from "./email";
import {
  attemptOrderConfirmation,
  enqueueOrderConfirmation,
  type AttemptOutcome,
} from "./orderConfirmationDelivery";

/**
 * The order-confirmation recovery worker (WP-EMAIL-R1c-min).
 *
 * One bounded pass, run by the scheduler and by an authorised operator alike
 * (app/api/cron/order-confirmations). Each pass:
 *
 *   1. closes rows left unfinished for 48 h and drops their saved email
 *      (expire_stale_order_email_deliveries — the retention backstop);
 *   2. enqueues paid Razorpay orders that settlement failed to enqueue, but
 *      only those created since 0074 was applied — never historical orders;
 *   3. attempts up to RECOVERY_BATCH due rows, one at a time, through the same
 *      claim / frozen payload / idempotency key as the first attempt, and
 *      stops starting new ones when the time budget is spent;
 *   4. reports counts. No ids, addresses or content.
 *
 * SAFE TO RUN TWICE AT ONCE, and Vercel says it may: every attempt goes
 * through claim_order_email_delivery, so a row is attempted by one pass and
 * skipped by the other. SAFE TO MISS A RUN: the next pass finds what is due.
 * NEVER SENDS after the idempotency window for anything that may already have
 * been accepted — the claim marks such a row expired instead.
 *
 * Never throws.
 */

type ServiceClient = ReturnType<typeof createServiceClient>;

/** Attempts per pass. Each can take up to ~13 s (eligibility, load, 10 s timeout). */
export const RECOVERY_BATCH = 10;
/** No new attempt starts after this much of the pass has gone. maxDuration is 60 s. */
export const RECOVERY_BUDGET_MS = 40_000;
/** The approved retention backstop for unfinished rows. */
export const STALE_AFTER = "48 hours";

export type RecoveryError =
  | "migration_missing"
  | "expire_failed"
  | "list_failed"
  | "internal";

export interface RecoveryReport {
  ok: boolean;
  error: RecoveryError | null;
  emailConfigured: boolean;
  staleClosed: number;
  orphansFound: number;
  orphansEnqueued: number;
  attempted: number;
  outcomes: Partial<Record<AttemptOutcome, number>>;
  /** True when the time budget stopped the pass before the list was done. */
  stoppedEarly: boolean;
  /** Counts over the last 8 days, after the pass. Null if unavailable. */
  summary: Record<string, number> | null;
  durationMs: number;
}

export interface RecoveryDeps {
  supabase: ServiceClient;
  attempt: (deliveryId: string) => Promise<AttemptOutcome>;
  enqueue: typeof enqueueOrderConfirmation;
  configured: () => boolean;
  now: () => number;
  batch: number;
  budgetMs: number;
}

function isMissing(error: { code?: string } | null | undefined): boolean {
  return !!error && (error.code === "PGRST202" || error.code === "42883" || error.code === "42P01");
}

function ids(data: unknown, key: string): string[] {
  if (!Array.isArray(data)) return [];
  return data
    .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>)[key] : null))
    .filter((v): v is string => typeof v === "string");
}

export async function runConfirmationRecovery(deps?: Partial<RecoveryDeps>): Promise<RecoveryReport> {
  const now = deps?.now ?? Date.now;
  const started = now();
  const report: RecoveryReport = {
    ok: false,
    error: null,
    emailConfigured: false,
    staleClosed: 0,
    orphansFound: 0,
    orphansEnqueued: 0,
    attempted: 0,
    outcomes: {},
    stoppedEarly: false,
    summary: null,
    durationMs: 0,
  };
  const done = (error: RecoveryError | null): RecoveryReport => {
    report.error = error;
    report.ok = error === null;
    report.durationMs = now() - started;
    return report;
  };

  try {
    const supabase = deps?.supabase ?? createServiceClient();
    const configured = deps?.configured ?? emailConfigured;
    const enqueue = deps?.enqueue ?? enqueueOrderConfirmation;
    const attempt = deps?.attempt ?? ((id: string) => attemptOrderConfirmation(id, { supabase }));
    const batch = Math.max(1, Math.min(deps?.batch ?? RECOVERY_BATCH, RECOVERY_BATCH));
    const budgetMs = deps?.budgetMs ?? RECOVERY_BUDGET_MS;
    report.emailConfigured = configured();

    // ── 1. Retention backstop ──
    const expired = await supabase.rpc("expire_stale_order_email_deliveries", { p_older_than: STALE_AFTER });
    if (expired.error) {
      console.error(`Confirmation recovery: stale expiry failed (${expired.error.code ?? "?"}).`);
      return done(isMissing(expired.error) ? "migration_missing" : "expire_failed");
    }
    report.staleClosed = typeof expired.data === "number" ? expired.data : 0;

    // ── 2. Orders settlement did not enqueue ──
    const orphans = await supabase.rpc("list_unqueued_paid_orders", { p_limit: batch });
    if (orphans.error) {
      console.error(`Confirmation recovery: orphan scan failed (${orphans.error.code ?? "?"}).`);
      return done(isMissing(orphans.error) ? "migration_missing" : "list_failed");
    }
    const orphanIds = ids(orphans.data, "order_id");
    report.orphansFound = orphanIds.length;
    for (const orderId of orphanIds) {
      const q = await enqueue(supabase, orderId);
      if (q.created) report.orphansEnqueued++;
    }

    // ── 3. Due attempts ──
    // Without email configured nothing can be accepted, and an attempt would
    // only spend one of the row's five. Leave them due for a later pass.
    if (report.emailConfigured) {
      const due = await supabase.rpc("list_due_order_email_deliveries", { p_limit: batch });
      if (due.error) {
        console.error(`Confirmation recovery: due scan failed (${due.error.code ?? "?"}).`);
        return done(isMissing(due.error) ? "migration_missing" : "list_failed");
      }
      for (const id of ids(due.data, "delivery_id")) {
        if (now() - started >= budgetMs) {
          report.stoppedEarly = true;
          break;
        }
        const outcome = await attempt(id);
        report.attempted++;
        report.outcomes[outcome] = (report.outcomes[outcome] ?? 0) + 1;
      }
    }

    // ── 4. Counts ──
    const summary = await supabase.rpc("order_email_delivery_summary");
    if (!summary.error && summary.data && typeof summary.data === "object") {
      report.summary = Object.fromEntries(
        Object.entries(summary.data as Record<string, unknown>).map(([k, v]) => [k, Number(v) || 0])
      );
    }

    return done(null);
  } catch (e) {
    console.error("Confirmation recovery: pass threw:", e instanceof Error ? e.message : "unknown");
    return done("internal");
  }
}
