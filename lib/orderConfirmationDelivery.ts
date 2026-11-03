import { createHash } from "node:crypto";
import { createServiceClient } from "./supabase";
import { emailConfigured, sendEmail, type SendOutcome } from "./email";
import { renderOrderConfirmation } from "./sendOrderConfirmation";

/**
 * Durable order-confirmation sending (WP-EMAIL-R1a, migration 0074).
 *
 * Every paid order gets one row in order_email_deliveries, created in the same
 * transaction that claims orders.confirmation_sent_at. Each attempt then runs:
 *
 *   claim   a time-limited lease; at most one attempt is active per row
 *   render  only the first time (the E2 template, from the stored order)
 *   begin   freeze the payload and stamp the request time, BEFORE the call
 *   send    Resend, with the row's fixed Idempotency-Key and a 10 s timeout
 *   record  accepted / uncertain / retryable / failed
 *
 * WHAT THIS GUARANTEES. One row per order; one active attempt per row; every
 * attempt sends the identical payload under the identical key; anything that
 * might already have been accepted is retried only inside Resend's 24-hour
 * idempotency window (23 h here), and never after. Within that window Resend
 * returns the original result for a repeat, so a retry does not send a second
 * email. That is time-bounded idempotency, NOT exactly-once delivery: after
 * the window an uncertain row is marked expired and left for a person.
 *
 * WHAT IT DOES NOT. "accepted" means Resend accepted the request. Whether the
 * customer received it (delivered, bounced, spam) is not known here.
 *
 * WHAT TRIGGERS AN ATTEMPT. settleOrder, once per settlement call: the first
 * settlement, and any later replay or webhook for the same order, which
 * retries a row only if it is due. There is no scheduler yet (R1c) and no
 * admin re-send yet (R1b); this module is what both will call.
 */

type ServiceClient = ReturnType<typeof createServiceClient>;

export const CONFIRMATION_TIMEOUT_MS = 10_000;
/** Longer than eligibility (1.5 s) + order load + the 10 s timeout, with room. */
export const CONFIRMATION_LEASE_SECONDS = 90;

export interface EnqueueResult {
  /** The delivery row, or null for an order claimed before 0074 / not claimable. */
  deliveryId: string | null;
  /** True when THIS call claimed the confirmation and created the row. */
  created: boolean;
  /** Set when the call failed; nothing was claimed. */
  error: string | null;
  /** The 0074 function is not there: the migration has not been applied. */
  missingMigration: boolean;
}

/** PostgREST's "function not found", or Postgres' own. */
function isMissingFunction(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === "PGRST202" || error.code === "42883";
}

/**
 * Claim the confirmation for a paid order and create its delivery row, in one
 * database transaction. Safe to call concurrently and repeatedly: exactly one
 * call ever gets created = true. Never throws.
 */
export async function enqueueOrderConfirmation(
  supabase: ServiceClient,
  orderId: string
): Promise<EnqueueResult> {
  try {
    const { data, error } = await supabase.rpc("enqueue_order_confirmation", { p_order_id: orderId });
    if (error) {
      const missing = isMissingFunction(error);
      console.error(
        missing
          ? `Order ${orderId}: CONFIRMATION NOT SENT — migration 0074 (enqueue_order_confirmation) is not applied. ` +
              `confirmation_sent_at was left unset so a later settlement can enqueue it.`
          : `Order ${orderId}: could not enqueue the confirmation: ${error.message}`
      );
      return { deliveryId: null, created: false, error: error.message ?? "rpc failed", missingMigration: missing };
    }
    const row = (Array.isArray(data) ? data[0] : data) as { delivery_id?: unknown; created?: unknown } | null;
    const deliveryId = typeof row?.delivery_id === "string" ? row.delivery_id : null;
    return { deliveryId, created: row?.created === true && deliveryId !== null, error: null, missingMigration: false };
  } catch (e) {
    console.error(`Order ${orderId}: enqueue threw:`, e);
    return { deliveryId: null, created: false, error: "threw", missingMigration: false };
  }
}

export type AttemptOutcome =
  | SendOutcome
  /** Nothing due: finished, in progress elsewhere, backing off, or expired. */
  | "not_due"
  /** The lease ran out before the request began; nothing was sent. */
  | "lease_lost"
  /** A database call failed; the row is left for its lease to run out. */
  | "error";

export interface AttemptDeps {
  supabase: ServiceClient;
  send: typeof sendEmail;
  render: typeof renderOrderConfirmation;
  configured: () => boolean;
  timeoutMs: number;
  leaseSeconds: number;
  /** The clock. Tests only. */
  now: () => number;
}

interface ClaimedRow {
  id: string;
  order_id: string;
  recipient: string | null;
  lease_token: string;
  payload_sha256: string | null;
}

interface BegunRow {
  recipient: string;
  subject: string;
  html_body: string;
  text_body: string;
  idempotency_key: string;
}

export function payloadHash(p: { recipient: string; subject: string; html: string; text: string }): string {
  return createHash("sha256")
    .update(JSON.stringify([p.recipient, p.subject, p.html, p.text]))
    .digest("hex");
}

/**
 * One attempt at one delivery row. Does nothing unless the row is due. Never
 * throws; the database holds the outcome.
 */
export async function attemptOrderConfirmation(
  deliveryId: string,
  deps?: Partial<AttemptDeps>
): Promise<AttemptOutcome> {
  const supabase = deps?.supabase ?? createServiceClient();
  const send = deps?.send ?? sendEmail;
  const render = deps?.render ?? renderOrderConfirmation;
  const configured = deps?.configured ?? emailConfigured;
  const timeoutMs = deps?.timeoutMs ?? CONFIRMATION_TIMEOUT_MS;
  const leaseSeconds = deps?.leaseSeconds ?? CONFIRMATION_LEASE_SECONDS;
  const now = deps?.now ?? Date.now;

  const record = async (
    token: string,
    outcome: SendOutcome,
    extra: { messageId?: string | null; httpStatus?: number | null; code?: string | null; error?: string | null } = {}
  ): Promise<boolean> => {
    try {
      const { data, error } = await supabase.rpc("record_order_email_outcome", {
        p_delivery_id: deliveryId,
        p_lease_token: token,
        p_outcome: outcome,
        p_provider_message_id: extra.messageId ?? null,
        p_http_status: extra.httpStatus ?? null,
        p_error_code: extra.code ?? null,
        p_error: extra.error ?? null,
      });
      if (error) {
        console.error(`Confirmation ${deliveryId}: could not record "${outcome}": ${error.message}`);
        return false;
      }
      return data === true;
    } catch (e) {
      console.error(`Confirmation ${deliveryId}: recording "${outcome}" threw:`, e);
      return false;
    }
  };

  try {
    // ── Claim ──
    const { data: claimed, error: claimError } = await supabase.rpc("claim_order_email_delivery", {
      p_delivery_id: deliveryId,
      p_lease_seconds: leaseSeconds,
    });
    if (claimError) {
      console.error(`Confirmation ${deliveryId}: claim failed: ${claimError.message}`);
      return "error";
    }
    const row = (Array.isArray(claimed) ? claimed[0] : claimed) as ClaimedRow | null | undefined;
    if (!row || typeof row.lease_token !== "string") return "not_due";
    const token = row.lease_token;
    // A serverless instance can be frozen mid-attempt and resumed much later.
    // By then another attempt may own the row and Resend may have forgotten
    // the key, so a lease this process can no longer be sure of is never used
    // to send. 5 s margin for clock and network.
    const leaseDeadline = now() + (leaseSeconds - 5) * 1000;

    // ── Render, the first time only ──
    let fresh: { subject: string; html: string; text: string; sha: string } | null = null;
    if (!row.payload_sha256) {
      if (!row.recipient) {
        await record(token, "failed", { code: "no_recipient" });
        return "failed";
      }
      const rendered = await render(row.order_id, row.recipient);
      if (!rendered.ok) {
        const outcome: SendOutcome = rendered.retryable ? "retryable" : "failed";
        await record(token, outcome, { code: rendered.reason });
        return outcome;
      }
      fresh = {
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        sha: payloadHash({ recipient: row.recipient, ...rendered }),
      };
    }

    // Nothing reaches Resend, so nothing starts the idempotency window.
    if (!configured()) {
      await record(token, "retryable", { code: "not_configured" });
      return "retryable";
    }

    // ── Begin: freeze the payload, stamp the request ──
    const { data: begun, error: beginError } = await supabase.rpc("begin_order_email_request", {
      p_delivery_id: deliveryId,
      p_lease_token: token,
      p_subject: fresh?.subject ?? null,
      p_html: fresh?.html ?? null,
      p_text: fresh?.text ?? null,
      p_sha256: fresh?.sha ?? null,
    });
    if (beginError) {
      console.error(`Confirmation ${deliveryId}: could not begin the request: ${beginError.message}`);
      return "error";
    }
    const payload = (Array.isArray(begun) ? begun[0] : begun) as BegunRow | null | undefined;
    if (!payload || typeof payload.html_body !== "string") return "lease_lost";
    if (now() > leaseDeadline) {
      console.error(`Confirmation ${deliveryId}: lease ran out before the request; not sending.`);
      return "lease_lost";
    }

    // ── Send exactly what is stored ──
    const result = await send({
      to: payload.recipient,
      subject: payload.subject,
      html: payload.html_body,
      text: payload.text_body,
      idempotencyKey: payload.idempotency_key,
      timeoutMs,
    });

    // ── Record ──
    await record(token, result.outcome, {
      messageId: result.id,
      httpStatus: result.httpStatus,
      code: result.errorName,
      error: result.error,
    });
    if (result.outcome !== "accepted") {
      console.error(`Confirmation ${deliveryId}: ${result.outcome} (${result.errorName ?? result.error ?? "no detail"}).`);
    }
    return result.outcome;
  } catch (e) {
    console.error(`Confirmation ${deliveryId}: attempt threw:`, e);
    return "error";
  }
}
