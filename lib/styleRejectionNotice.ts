/**
 * Telling a customer their photograph was turned down, exactly once
 * (WP-EMAIL-E5 Stage B, migration 0076).
 *
 * The database decides who may send: claim_style_rejection_notice() locks the
 * submission and moves the round's notice to "claimed" for one caller only.
 * That lock ends with the claim's transaction, so it protects nothing about the
 * send. This module, given the claim:
 *
 *   1. builds the email (a template failure happens before anything is marked);
 *   2. calls begin_style_rejection_send(), which re-locks and re-checks: still
 *      rejected, not withdrawn, same round, an address. If not, the notice is
 *      recorded as "skipped" and nothing is sent;
 *   3. hands the email to the provider at once, and records what it said:
 *
 *   accepted   Resend returned an id. Not proof of delivery, and never called that.
 *   failed     a definite refusal (4xx, or email not configured here): nothing
 *              was sent; a later rejection request may claim it again.
 *   uncertain  no clear answer (timeout, 5xx, network): it may have been sent,
 *              so it is never resent automatically.
 *
 * RESIDUAL RACE, stated plainly: a withdrawal or resubmission that commits
 * after step 2 and before the provider accepts the request (milliseconds) is
 * not seen, and that email goes out. The architecture cannot close that gap:
 * the provider is outside the database transaction. What it guarantees is
 * that the outcome is still recorded truthfully, and that no NEW send starts
 * for a submission that is no longer eligible.
 *
 * A failed email never undoes the rejection; the route reports, it does not
 * throw. Collaborators are injected so tests drive every branch.
 */
import { styleRejectedHtml, styleRejectedSubject, styleRejectedText } from "./emails/styleRejected";

export type ClaimOutcome =
  | "claimed"
  | "already_accepted"
  | "in_progress"
  | "uncertain"
  | "no_recipient"
  | "withdrawn"
  | "not_rejected"
  | "silent"
  | "no_intent"
  | "skipped"
  | "not_found";

export interface Claim {
  outcome: ClaimOutcome;
  notice_id?: string;
  round?: number;
  attempt?: number;
  recipient?: string;
  customer_name?: string | null;
  product_name?: string | null;
  reason?: string;
  accepted_at?: string;
  claimed_at?: string;
  sending?: boolean;
}

/** begin_style_rejection_send()'s answer. */
export type BeginResult =
  | { send: true; recipient: string }
  | { send: false; reason: "withdrawn" | "not_rejected" | "round_changed" | "no_recipient" | "not_found" };

export type BeginFn = (noticeId: string) => Promise<{ data: BeginResult | null; error: string | null }>;

export type NoticeOutcome = "accepted" | "failed" | "uncertain";

/** What the admin screen is told. `emailed` is true only for this request's accepted send. */
export interface NoticeReport {
  emailed: boolean;
  /** The claim outcome, or the provider outcome for a claimed send. */
  status: ClaimOutcome | NoticeOutcome | "claim_failed" | "not_recorded" | "not_begun";
  message: string;
}

export type SendFn = (msg: { to: string; subject: string; html: string; text: string }) => Promise<{
  ok: boolean;
  id: string | null;
  error: string | null;
}>;

export type RecordFn = (noticeId: string, outcome: NoticeOutcome, providerId: string | null, error: string | null) => Promise<{
  error: string | null;
}>;

export const REJECTION_EMAIL_TIMEOUT_MS = 10_000;

/** lib/email on main reports "Resend <status>", "Send failed." or "Email is not configured.". */
export function classifyProviderError(error: string | null): "failed" | "uncertain" {
  if (error === "Email is not configured.") return "failed";
  const m = /^Resend (\d{3})$/.exec(error ?? "");
  return m && Number(m[1]) >= 400 && Number(m[1]) < 500 ? "failed" : "uncertain";
}

class Timeout extends Error {}
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Timeout()), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

const RECORDED = "The rejection is recorded.";

/** The message for a claim that did not win, or a reason nothing is owed. */
export function claimMessage(c: Claim): NoticeReport {
  switch (c.outcome) {
    case "already_accepted":
      return { emailed: false, status: c.outcome, message: `${RECORDED} The customer's email about it was already accepted by the email provider${c.accepted_at ? ` (${c.accepted_at})` : ""}, so no second email was sent.` };
    case "in_progress":
      return { emailed: false, status: c.outcome, message: `${RECORDED} An earlier attempt to email the customer is in progress or did not report back, so no second email was sent. It is not known whether that attempt reached the provider.` };
    case "uncertain":
      return { emailed: false, status: c.outcome, message: `${RECORDED} An earlier attempt to email the customer had no clear answer from the provider, so it is not known whether it was sent. No second email was sent.` };
    case "no_recipient":
      return { emailed: false, status: c.outcome, message: `${RECORDED} The customer has no email address on file, so nobody was told.` };
    case "withdrawn":
      return { emailed: false, status: c.outcome, message: `${RECORDED} The customer has withdrawn this submission, so no email was sent.` };
    case "skipped":
      return { emailed: false, status: c.outcome, message: `${RECORDED} An earlier attempt found it was no longer eligible when it came to send (withdrawn, resubmitted or moved), so nothing was sent.` };
    case "no_intent":
      return { emailed: false, status: c.outcome, message: `${RECORDED} This rejection predates notification records and was never emailed; it is not emailed automatically. Move it back to pending and turn it down again to tell the customer.` };
    case "silent":
      return { emailed: false, status: c.outcome, message: `${RECORDED} It was turned down without a reason, so nothing is owed to the customer.` };
    case "not_rejected":
      return { emailed: false, status: c.outcome, message: "It is no longer turned down (it was approved, taken back to pending or resubmitted), so no email was sent." };
    case "not_found":
      return { emailed: false, status: c.outcome, message: "That submission no longer exists, so no email was sent." };
    case "claimed":
      return { emailed: false, status: c.outcome, message: "" };
  }
}

/**
 * For a claim this request won: send, then record. Never throws.
 */
export async function sendClaimedRejection(
  claim: Claim,
  deps: { send: SendFn; begin: BeginFn; record: RecordFn; timeoutMs?: number }
): Promise<NoticeReport> {
  if (claim.outcome !== "claimed") return claimMessage(claim);
  if (!claim.notice_id || !claim.reason) {
    return { emailed: false, status: "claim_failed", message: `${RECORDED} The notification claim came back incomplete, so no email was sent.` };
  }

  // 1. Build first: nothing is marked "sending" for an email that cannot be made.
  let content: { subject: string; html: string; text: string };
  try {
    const data = { customerName: claim.customer_name ?? null, productName: claim.product_name ?? null, reason: claim.reason };
    content = { subject: styleRejectedSubject(data.productName), html: styleRejectedHtml(data), text: styleRejectedText(data) };
  } catch (e) {
    console.error(`style reject notice ${claim.notice_id}: email could not be built`, e);
    return { emailed: false, status: "not_begun", message: `${RECORDED} The email could not be prepared, so nothing was sent. The notice stays in progress and is not resent automatically.` };
  }

  // 2. The last database check, immediately before the provider.
  const begun = await deps.begin(claim.notice_id).catch((e: unknown) => ({
    data: null,
    error: e instanceof Error ? e.message : String(e),
  }));
  if (begun.error || !begun.data) {
    console.error(`style reject notice ${claim.notice_id}: could not begin — ${begun.error ?? "no answer"}`);
    return { emailed: false, status: "not_begun", message: `${RECORDED} Eligibility could not be re-checked before sending, so nothing was sent. The notice stays in progress and is not resent automatically.` };
  }
  if (!begun.data.send) {
    const why: Record<string, string> = {
      withdrawn: "the customer has since withdrawn the submission",
      not_rejected: "it is no longer turned down (resubmitted, approved or moved back to pending)",
      round_changed: "it has been moderated again since",
      no_recipient: "the customer no longer has an email address on file",
      not_found: "the submission no longer exists",
    };
    return { emailed: false, status: "skipped", message: `${RECORDED} No email was sent: ${why[begun.data.reason] ?? begun.data.reason}.` };
  }

  // 3. Hand it over, and keep the provider's answer whatever happens next.
  let outcome: NoticeOutcome;
  let providerId: string | null = null;
  let error: string | null = null;
  try {
    const ms = deps.timeoutMs ?? REJECTION_EMAIL_TIMEOUT_MS;
    const sent = await withDeadline(deps.send({ to: begun.data.recipient, ...content }), ms);
    if (sent.ok) {
      outcome = "accepted";
      providerId = sent.id;
    } else {
      outcome = classifyProviderError(sent.error);
      error = sent.error;
    }
  } catch (e) {
    // A timeout or a throw: the request may have reached the provider.
    outcome = "uncertain";
    error = e instanceof Timeout ? "timeout" : e instanceof Error ? e.message : String(e);
  }

  const recorded = await deps.record(claim.notice_id, outcome, providerId, error).catch((e: unknown) => ({
    error: e instanceof Error ? e.message : String(e),
  }));
  if (recorded.error) {
    console.error(`style reject notice ${claim.notice_id}: ${outcome} but not recorded — ${recorded.error}`);
    return {
      emailed: outcome === "accepted",
      status: "not_recorded",
      message:
        outcome === "accepted"
          ? `${RECORDED} The email was accepted by the email provider, but that could not be recorded. Do not send it again.`
          : `${RECORDED} The email attempt (${outcome}) could not be recorded; the notice stays in progress and will not be resent automatically.`,
    };
  }

  switch (outcome) {
    case "accepted":
      return { emailed: true, status: "accepted", message: `${RECORDED} The email to the customer was accepted by the email provider. That does not confirm it reached their inbox.` };
    case "failed":
      return { emailed: false, status: "failed", message: `${RECORDED} The email was not sent: the email provider refused it (${error ?? "no detail"}). Turning it down again with the same reason will try once more.` };
    case "uncertain":
      return { emailed: false, status: "uncertain", message: `${RECORDED} It is not known whether the email was sent: the provider gave no clear answer (${error ?? "no detail"}). It will not be resent automatically.` };
  }
}
