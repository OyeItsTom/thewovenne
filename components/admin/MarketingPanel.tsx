"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, Send } from "lucide-react";
import { TRIGGERS, type MarketingTrigger } from "@/lib/marketing";
import { TRIGGER_DESCRIPTION, TRIGGER_LABEL, TRIGGER_SUBJECT } from "@/lib/emails/marketing";

/**
 * Send one of the marketing emails.
 *
 * The recipient count is loaded before anything can be sent, so pressing Send
 * is never the first time anyone learns how many people are involved. Consent
 * is not enforced here — it is enforced in the database, twice — but the count
 * shown is the same list the send will use.
 */
export default function MarketingPanel() {
  const [trigger, setTrigger] = useState<MarketingTrigger>("wishlist_waiting");
  const [preview, setPreview] = useState<{ count: number; recipients: string[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (t: MarketingTrigger) => {
    setLoading(true);
    setPreview(null);
    setResult(null);
    setError(null);
    setConfirm(false);
    try {
      const res = await fetch("/api/admin/marketing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger: t, dryRun: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load recipients");
      setPreview({ count: data.count, recipients: data.recipients });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(trigger);
  }, [trigger, load]);

  async function send() {
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/marketing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Send failed");
      setResult(
        `Sent ${data.sent}. ${data.skipped ? `${data.skipped} skipped (consent withdrawn since the list was built). ` : ""}${data.failed ? `${data.failed} failed.` : ""}`
      );
      await load(trigger);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setSending(false);
      setConfirm(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-heading text-2xl text-ink">Marketing email</h2>
        <p className="mt-1 text-sm text-ink/60">
          Only customers with an account who opted in. Guests are never included.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {TRIGGERS.map((t) => (
          <button
            key={t}
            onClick={() => setTrigger(t)}
            className={
              trigger === t
                ? "rounded-full bg-ink px-4 py-2 text-xs uppercase tracking-wider text-cream"
                : "rounded-full border border-ink/15 px-4 py-2 text-xs uppercase tracking-wider text-ink/60 hover:border-ink"
            }
          >
            {TRIGGER_LABEL[t]}
          </button>
        ))}
      </div>

      <section className="rounded-2xl border border-ink/10 bg-cream p-6">
        <p className="text-xs leading-relaxed text-ink/60">
          {TRIGGER_DESCRIPTION[trigger]}
        </p>
        <p className="mt-3 text-sm text-ink/70">
          Subject: <span className="text-ink">{TRIGGER_SUBJECT[trigger]}</span>
        </p>

        <div className="mt-5 border-t border-ink/10 pt-5">
          {loading ? (
            <p className="flex items-center gap-2 text-sm text-ink/50">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking who this would reach…
            </p>
          ) : preview ? (
            <>
              <p className="font-heading text-3xl text-ink">
                {preview.count}
                <span className="ml-2 align-middle text-sm font-normal text-ink/50">
                  {preview.count === 1 ? "recipient" : "recipients"}
                </span>
              </p>
              {preview.count > 0 && (
                <ul className="mt-3 space-y-1 text-xs text-ink/60">
                  {preview.recipients.slice(0, 8).map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                  {preview.count > 8 && <li>…and {preview.count - 8} more</li>}
                </ul>
              )}
              {preview.count === 0 && (
                <p className="mt-2 text-sm text-ink/60">
                  Nobody qualifies right now — either nobody has opted in, nobody
                  has a saved item matching this, or everyone eligible was
                  contacted in the last week.
                </p>
              )}
            </>
          ) : null}
        </div>

        {error && (
          <p className="mt-4 flex items-start gap-2 rounded-lg bg-terracotta/10 px-4 py-3 text-sm text-terracotta-dark">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </p>
        )}
        {result && (
          <p className="mt-4 rounded-lg bg-linen/70 px-4 py-3 text-sm text-ink/80">
            {result}
          </p>
        )}

        {preview && preview.count > 0 && (
          <div className="mt-5 flex flex-wrap items-center gap-3">
            {confirm ? (
              <>
                <span className="text-sm text-terracotta-dark">
                  Send to {preview.count}{" "}
                  {preview.count === 1 ? "person" : "people"}? This can&apos;t be undone.
                </span>
                <button
                  onClick={send}
                  disabled={sending}
                  className="inline-flex items-center gap-2 rounded-full bg-ink px-5 py-2 text-xs font-medium text-cream disabled:opacity-40"
                >
                  {sending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                  Yes, send
                </button>
                <button
                  onClick={() => setConfirm(false)}
                  className="text-xs text-ink/50 hover:text-ink"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirm(true)}
                className="inline-flex items-center gap-2 rounded-full border border-ink/20 px-5 py-2 text-xs font-medium text-ink hover:border-ink"
              >
                <Send className="h-3.5 w-3.5" /> Send this email
              </button>
            )}
          </div>
        )}
      </section>

      <p className="rounded-lg bg-linen/60 px-4 py-3 text-xs leading-relaxed text-ink/60">
        Consent is checked in the database, twice — when the list is built and
        again immediately before each send, so a withdrawal made in between is
        honoured. Nobody receives the same trigger twice within seven days.
        <br />
        <br />
        <strong className="font-medium">Cart abandonment isn&apos;t here.</strong>{" "}
        The cart lives in the customer&apos;s browser and never reaches us, so
        there is nothing to detect. It would need carts stored on the server
        first — a decision about recording what signed-out people browse, not a
        side effect of this.
      </p>
    </div>
  );
}
