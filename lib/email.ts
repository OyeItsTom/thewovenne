/**
 * Transactional email, via Resend's REST API.
 *
 * Called directly rather than through the SDK: one POST with a bearer token is
 * the whole integration, and a dependency for that is a dependency to keep
 * patched. If retries or batching are ever needed the SDK earns its place.
 *
 * NOTE ON AUTH EMAILS — signup codes and password resets do NOT go through
 * here. Supabase Auth sends those itself, and the way to route them via Resend
 * is to point Supabase's SMTP settings at Resend in the dashboard. Sending them
 * from application code would mean reimplementing the auth flows that generate
 * the tokens, and inventing our own token handling around Supabase's is exactly
 * the kind of thing that ends up subtly insecure. See the notes in
 * .env.local.example.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Whether email is configured. Checked rather than assumed, so a missing key
 * fails loudly in the log instead of silently not sending.
 */
export function emailConfigured(): boolean {
  const key = process.env.RESEND_API_KEY?.trim();
  return !!key && key.startsWith("re_") && key.length > 20;
}

function fromAddress(): string {
  // Falls back to a sane default so a missing variable is a wrong-looking
  // sender rather than a crash mid-checkout.
  return process.env.EMAIL_FROM?.trim() || "THE WOVENNE <orders@thewovenne.com>";
}

/**
 * What a send attempt tells us about Resend, for a caller that retries
 * (lib/orderConfirmationDelivery). Callers that do not retry use `ok`.
 *
 *   accepted   Resend returned an email id. It has the email; that is NOT the
 *              same as the customer receiving it.
 *   uncertain  may or may not have been accepted: timeout, network failure,
 *              5xx, or a 2xx we could not read. Retry only with the same
 *              idempotency key and payload, inside Resend's 24-hour window.
 *   retryable  definitely not accepted, and worth trying again later: 429
 *              (rate or quota), 409 concurrent request with the same key,
 *              409 resource_locked, or email not configured here.
 *   failed     definitely not accepted, and a retry will not change that: 400,
 *              401, 403, 404, 405, 422, or 409 invalid_idempotent_request (the
 *              key was used with a different payload).
 */
export type SendOutcome = "accepted" | "uncertain" | "retryable" | "failed";

export interface SendResult {
  ok: boolean;
  id: string | null;
  error: string | null;
  outcome: SendOutcome;
  /** Resend's HTTP status, or null when no response arrived. */
  httpStatus: number | null;
  /** Resend's error name (e.g. rate_limit_exceeded), "timeout", "network", or null. */
  errorName: string | null;
}

/** Classify a non-2xx Resend answer. Exported for tests. */
export function classifyResendError(status: number, name: string | null): SendOutcome {
  if (status === 409) {
    if (name === "invalid_idempotent_request") return "failed";
    // concurrent_idempotent_requests, resource_locked, or unnamed: the earlier
    // request may still be running. Same key later is safe.
    return name === "concurrent_idempotent_requests" || name === "resource_locked" ? "retryable" : "uncertain";
  }
  if (status === 429) return "retryable";
  if (status >= 500) return "uncertain";
  if (status >= 400) return "failed";
  return "uncertain";
}

/**
 * Send one email.
 *
 * Never throws. Every caller is doing something more important than sending
 * email — taking an order, most of all — and an email failure must not become
 * a customer-facing failure. Problems are returned and logged for Sentry.
 */
export async function sendEmail(
  opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  /**
   * Base64 file attachments, in Resend's own shape.
   *
   * Added for invoice resends. The PDF is re-rendered from the order each time
   * rather than stored, so an attachment is always the document that order
   * currently describes — there is no archived copy that could have drifted.
   */
  attachments?: { filename: string; content: string }[];
  /**
   * Resend's Idempotency-Key (1–256 characters). Within 24 hours a repeat with
   * the same key and the SAME payload returns the original result without
   * sending again; a different payload under the same key is refused (409).
   */
  idempotencyKey?: string;
  /**
   * Abort after this many milliseconds. A timeout is reported as `uncertain`:
   * Resend may have accepted the email before the answer was lost.
   */
  timeoutMs?: number;
  },
  deps: { fetch?: typeof fetch } = {}
): Promise<SendResult> {
  if (!emailConfigured()) {
    console.error(
      "email: RESEND_API_KEY is missing or not a real key — nothing was sent."
    );
    return {
      ok: false,
      id: null,
      error: "Email is not configured.",
      outcome: "retryable",
      httpStatus: null,
      errorName: "not_configured",
    };
  }

  if (opts.idempotencyKey !== undefined && (opts.idempotencyKey.length < 1 || opts.idempotencyKey.length > 256)) {
    return { ok: false, id: null, error: "Invalid idempotency key.", outcome: "failed", httpStatus: null, errorName: "invalid_idempotency_key" };
  }

  const doFetch = deps.fetch ?? fetch;
  const signal = opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined;

  try {
    const res = await doFetch(RESEND_ENDPOINT, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from: fromAddress(),
        to: [opts.to],
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
        reply_to: opts.replyTo || process.env.EMAIL_REPLY_TO || undefined,
        attachments: opts.attachments?.length ? opts.attachments : undefined,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      let name: string | null = null;
      try {
        const parsed = JSON.parse(detail) as { name?: unknown };
        name = typeof parsed?.name === "string" ? parsed.name.slice(0, 64) : null;
      } catch {
        name = null;
      }
      console.error(`email: Resend returned ${res.status}${name ? ` ${name}` : ""}: ${detail.slice(0, 300)}`);
      return {
        ok: false,
        id: null,
        error: `Resend ${res.status}`,
        outcome: classifyResendError(res.status, name),
        httpStatus: res.status,
        errorName: name,
      };
    }

    let id: string | null = null;
    try {
      const data = (await res.json()) as { id?: unknown };
      id = typeof data?.id === "string" && data.id ? data.id : null;
    } catch {
      id = null;
    }
    if (!id) {
      // A success we cannot read: probably accepted, but there is no id to prove it.
      console.error(`email: Resend returned ${res.status} without a readable id.`);
      return { ok: false, id: null, error: "No email id returned.", outcome: "uncertain", httpStatus: res.status, errorName: "no_id" };
    }
    return { ok: true, id, error: null, outcome: "accepted", httpStatus: res.status, errorName: null };
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    console.error(timedOut ? `email: send timed out after ${opts.timeoutMs} ms` : "email: send threw:", timedOut ? "" : e);
    return {
      ok: false,
      id: null,
      error: timedOut ? "Send timed out." : "Send failed.",
      outcome: "uncertain",
      httpStatus: null,
      errorName: timedOut ? "timeout" : "network",
    };
  }
}
