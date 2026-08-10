"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { Check, ExternalLink, Loader2, Trash2, Undo2, X } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { parseStyleLink, watchLabel } from "@/lib/styleMedia";

/**
 * Deciding whose photograph goes on the site.
 *
 * APPROVE IS ONE CLICK; TURNING SOMETHING DOWN IS NOT. Approving publishes
 * something a customer already asked us to publish — it needs no explanation and
 * no confirmation. A rejection ends with an email to a real person about a
 * photograph of themselves, so it asks what to say first, and offers a preset
 * only as a starting point rather than a list to pick from and forget.
 *
 * SILENT REJECTION IS A SEPARATE BUTTON, not an empty reason box. Spam and worse
 * must be removable without composing a courteous note about it, and making that
 * the same control as "reject" — distinguished only by leaving a field blank —
 * is how somebody eventually sends a stranger an explanation they never wrote.
 *
 * Every state-changing call goes through a SECURITY DEFINER function or an
 * admin-gated route that checks is_admin() itself. This screen being behind the
 * admin login is a convenience, not the control.
 */

interface Submission {
  id: string;
  product_id: string;
  product_name: string | null;
  product_slug: string | null;
  photo_url: string | null;
  photo_width: number | null;
  photo_height: number | null;
  video_platform: string | null;
  video_url: string | null;
  caption: string | null;
  credit_name: string | null;
  status: "pending" | "approved" | "rejected";
  consented_at: string | null;
  withdrawn_at: string | null;
  reject_reason: string | null;
  rejection_emailed_at: string | null;
  created_at: string;
  customer_email: string | null;
  customer_name: string | null;
}

type Tab = "pending" | "approved" | "rejected";

/** Starting points, not a menu. Each one is editable before it is sent. */
const REASONS = [
  "The photograph is a little blurry — a sharper one would show the cloth better.",
  "It's a bit too small, so it looks soft at the size we display it.",
  "We can't see enough of the piece in this one.",
  "The lighting makes the colour hard to judge.",
];

export default function StyleManager() {
  const [rows, setRows] = useState<Submission[] | null>(null);
  const [tab, setTab] = useState<Tab>("pending");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The submission currently being turned down, and the words to send. */
  const [rejecting, setRejecting] = useState<Submission | null>(null);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    const { data, error: rpcError } = await getBrowserSupabase().rpc("admin_style_submissions");
    if (rpcError) {
      setError(rpcError.message);
      setRows([]);
      return;
    }
    setRows((data ?? []) as Submission[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const all = rows ?? [];
    return {
      pending: all.filter((r) => r.status === "pending").length,
      approved: all.filter((r) => r.status === "approved").length,
      rejected: all.filter((r) => r.status === "rejected").length,
    };
  }, [rows]);

  const shown = (rows ?? []).filter((r) => r.status === tab);

  async function moderate(row: Submission, status: "approved" | "pending" | "rejected") {
    setBusy(row.id);
    setError(null);
    setNotice(null);
    const { error: rpcError } = await getBrowserSupabase().rpc("moderate_style", {
      p_id: row.id,
      p_status: status,
      p_reason: null,
    });
    setBusy(null);
    if (rpcError) return setError(rpcError.message);
    setNotice(
      status === "approved"
        ? "Published. It is on the site now."
        : status === "rejected"
          ? "Turned down silently — nothing was sent to the customer."
          : "Taken off the site and put back in the queue."
    );
    await load();
  }

  /** Rejection WITH a reason: the route records it and sends the email together. */
  async function rejectWithReason() {
    if (!rejecting || !reason.trim()) return;
    setBusy(rejecting.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/style/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: rejecting.id, reason: reason.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not turn that down.");
      setNotice(
        data.emailed
          ? "Turned down, and the customer has been told why."
          : `Turned down. THE CUSTOMER WAS NOT EMAILED — ${data.problem ?? "no reason given"}`
      );
      setRejecting(null);
      setReason("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(row: Submission) {
    if (!window.confirm("Delete this submission entirely? The photograph stays in storage but the record is gone.")) {
      return;
    }
    setBusy(row.id);
    const { error: deleteError } = await getBrowserSupabase()
      .from("style_submissions")
      .delete()
      .eq("id", row.id);
    setBusy(null);
    if (deleteError) return setError(deleteError.message);
    await load();
  }

  if (rows === null) return <p className="text-ink/60">Loading submissions…</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {(["pending", "approved", "rejected"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            aria-pressed={t === tab}
            className={
              t === tab
                ? "rounded-full bg-ink px-4 py-1.5 text-xs text-cream"
                : "rounded-full border border-ink/15 px-4 py-1.5 text-xs text-ink/70 transition-colors hover:border-ink/40"
            }
          >
            {t === "pending" ? "Waiting" : t === "approved" ? "On the site" : "Turned down"} ({counts[t]})
          </button>
        ))}
      </div>

      {error && (
        <p className="rounded-lg bg-terracotta/10 px-4 py-3 text-sm text-terracotta-dark">{error}</p>
      )}
      {notice && <p className="rounded-lg bg-linen px-4 py-3 text-sm text-ink">{notice}</p>}

      {shown.length === 0 && (
        <p className="rounded-2xl border border-ink/10 bg-linen/40 p-8 text-center text-sm text-ink/60">
          {tab === "pending"
            ? "Nothing waiting. Submissions appear here the moment a customer sends one."
            : tab === "approved"
              ? "Nothing published yet."
              : "Nothing has been turned down."}
        </p>
      )}

      {shown.map((row) => {
        const link = row.video_url ? parseStyleLink(row.video_url) : null;
        const working = busy === row.id;
        return (
          <section key={row.id} className="rounded-2xl border border-ink/10 bg-cream p-5">
            <div className="flex flex-wrap gap-5">
              {row.photo_url ? (
                <Image
                  src={row.photo_url}
                  alt=""
                  width={row.photo_width ?? 400}
                  height={row.photo_height ?? 500}
                  className="h-40 w-auto rounded-lg object-cover"
                />
              ) : (
                <div className="flex h-40 w-32 items-center justify-center rounded-lg bg-linen/60 text-center text-xs text-ink/50">
                  Link only
                </div>
              )}

              <div className="min-w-0 flex-1">
                <p className="text-xs uppercase tracking-wider text-ink/50">
                  {new Date(row.created_at).toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                  {" · "}
                  {row.product_name ?? "Unknown piece"}
                </p>
                <h3 className="font-heading text-xl text-ink">
                  {row.customer_name ?? "A customer"}
                  <span className="ml-2 text-sm font-normal text-ink/45">{row.customer_email}</span>
                </h3>

                {row.caption && <p className="mt-2 text-sm text-ink/75">&ldquo;{row.caption}&rdquo;</p>}

                <p className="mt-2 text-xs text-ink/60">
                  {/* Consent is shown as a fact with its date, not as a tick. It is
                      the thing that makes publishing lawful, and it should be
                      readable at the moment of deciding. */}
                  {row.consented_at
                    ? `Consented ${new Date(row.consented_at).toLocaleDateString("en-GB")}`
                    : "NO CONSENT RECORDED"}
                  {" · "}
                  {row.credit_name
                    ? `Credit as "${row.credit_name}"`
                    : "To appear anonymously"}
                  {row.withdrawn_at && (
                    <span className="text-terracotta-dark"> · WITHDRAWN by the customer</span>
                  )}
                </p>

                {link && (
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-flex items-center gap-1.5 text-xs uppercase tracking-wider text-ink/55 hover:text-terracotta"
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> {watchLabel(link.platform)}
                  </a>
                )}

                {row.status === "rejected" && (
                  <p className="mt-2 text-xs text-ink/60">
                    Reason: {row.reject_reason ?? "none — turned down silently"}
                    {row.reject_reason && (
                      <span className={row.rejection_emailed_at ? "" : "text-terracotta-dark"}>
                        {row.rejection_emailed_at
                          ? " · customer told"
                          : " · CUSTOMER NOT TOLD"}
                      </span>
                    )}
                  </p>
                )}

                {/* ── Actions ── */}
                <div className="mt-4 flex flex-wrap items-center gap-4">
                  {row.status !== "approved" && !row.withdrawn_at && row.consented_at && (
                    <button
                      onClick={() => void moderate(row, "approved")}
                      disabled={working}
                      className="inline-flex items-center gap-2 rounded-full bg-ink px-5 py-2 text-xs font-medium text-cream transition-colors hover:bg-ink-light disabled:opacity-40"
                    >
                      {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      Put it on the site
                    </button>
                  )}

                  {row.status === "approved" && (
                    <button
                      onClick={() => void moderate(row, "pending")}
                      disabled={working}
                      className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wider text-ink/55 hover:text-terracotta disabled:opacity-40"
                    >
                      <Undo2 className="h-3.5 w-3.5" /> Take it off
                    </button>
                  )}

                  {row.status !== "rejected" && (
                    <button
                      onClick={() => {
                        setRejecting(row);
                        setReason("");
                      }}
                      disabled={working}
                      className="text-xs uppercase tracking-wider text-terracotta-dark hover:underline disabled:opacity-40"
                    >
                      Turn down &amp; explain
                    </button>
                  )}

                  {row.status !== "rejected" && (
                    <button
                      onClick={() => void moderate(row, "rejected")}
                      disabled={working}
                      className="text-xs uppercase tracking-wider text-ink/45 hover:text-ink disabled:opacity-40"
                      title="For spam or anything inappropriate — nothing is sent to the customer"
                    >
                      Turn down silently
                    </button>
                  )}

                  <button
                    onClick={() => void remove(row)}
                    disabled={working}
                    className="ml-auto text-ink/35 hover:text-terracotta-dark disabled:opacity-40"
                    aria-label="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                {/* ── The reason, written before anything is sent ── */}
                {rejecting?.id === row.id && (
                  <div className="mt-4 space-y-3 rounded-xl bg-linen/50 p-4">
                    <p className="text-xs text-ink/65">
                      This is emailed to {row.customer_email} as written. Say what
                      would make the next one work.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {REASONS.map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => setReason(preset)}
                          className="rounded-full border border-ink/15 px-3 py-1 text-xs text-ink/70 transition-colors hover:border-terracotta"
                        >
                          {preset.split("—")[0].trim().slice(0, 34)}
                        </button>
                      ))}
                    </div>
                    <textarea
                      rows={3}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Write it as you would say it."
                      className="w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
                    />
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => void rejectWithReason()}
                        disabled={working || !reason.trim()}
                        className="inline-flex items-center gap-2 rounded-full bg-terracotta px-5 py-2 text-xs font-medium text-cream hover:bg-terracotta-dark disabled:opacity-40"
                      >
                        {working && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        Send it
                      </button>
                      <button
                        onClick={() => setRejecting(null)}
                        className="inline-flex items-center gap-1 text-xs text-ink/55 hover:text-ink"
                      >
                        <X className="h-3.5 w-3.5" /> Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}
