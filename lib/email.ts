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

export interface SendResult {
  ok: boolean;
  id: string | null;
  error: string | null;
}

/**
 * Send one email.
 *
 * Never throws. Every caller is doing something more important than sending
 * email — taking an order, most of all — and an email failure must not become
 * a customer-facing failure. Problems are returned and logged for Sentry.
 */
export async function sendEmail(opts: {
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
}): Promise<SendResult> {
  if (!emailConfigured()) {
    console.error(
      "email: RESEND_API_KEY is missing or not a real key — nothing was sent."
    );
    return { ok: false, id: null, error: "Email is not configured." };
  }

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
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
      const detail = await res.text();
      console.error(`email: Resend returned ${res.status}: ${detail.slice(0, 300)}`);
      return { ok: false, id: null, error: `Resend ${res.status}` };
    }

    const data = (await res.json()) as { id?: string };
    return { ok: true, id: data.id ?? null, error: null };
  } catch (e) {
    console.error("email: send threw:", e);
    return { ok: false, id: null, error: "Send failed." };
  }
}
