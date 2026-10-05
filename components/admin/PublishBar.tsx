"use client";

import { useCallback, useEffect, useState } from "react";
import { Eye, ListChecks, Loader2, Rocket, Undo2 } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import {
  discardDrafts,
  getPendingChanges,
  publishAll,
  type PendingChanges,
} from "@/lib/drafts";
import { adminErrorMessage, discardAllText } from "@/lib/adminStatus";

type State = "idle" | "publishing" | "published" | "discarding" | "error";

const LABELS: [keyof PendingChanges, string, string][] = [
  ["products", "product", "products"],
  ["categories", "category", "categories"],
  ["journal", "journal post", "journal posts"],
  ["content", "content block", "content blocks"],
  ["pages", "page", "pages"],
];

function summarise(p: PendingChanges): string {
  const parts = LABELS.filter(([k]) => (p[k] as number) > 0).map(([k, one, many]) => {
    const n = p[k] as number;
    return `${n} ${n === 1 ? one : many}`;
  });
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The one place that moves work from the admin to the live site.
 *
 * Sits above every tab rather than inside one, because pending changes span
 * products, categories, journal and content — a publish button living in a
 * single tab would imply it only published that tab.
 */
export default function PublishBar({
  refreshKey = 0,
  onReview,
}: {
  refreshKey?: number;
  /** Jump to the queue. Omitted where there is nowhere to jump to. */
  onReview?: () => void;
}) {
  const [pending, setPending] = useState<PendingChanges | null>(null);
  const [state, setState] = useState<State>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // The count could not be read. Said as such — it used to read as zero, i.e.
  // "Everything is published", which is exactly the wrong reassurance.
  const [countFailed, setCountFailed] = useState(false);

  const refresh = useCallback(async () => {
    let next: PendingChanges;
    try {
      next = await getPendingChanges(getBrowserSupabase());
    } catch {
      setCountFailed(true);
      return;
    }
    setCountFailed(false);
    setPending(next);
    // Once new work is waiting, the previous "Successfully published" is stale
    // and would otherwise keep rendering in place of the pending count.
    if (next.total > 0) {
      setMessage(null);
      setState((s) => (s === "published" ? "idle" : s));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  const publish = async () => {
    setState("publishing");
    setMessage(null);
    try {
      const result = await publishAll(getBrowserSupabase());
      setState("published");
      // The counts come back from publish_all itself, so this reports what
      // the database actually released — not what was on screen beforehand.
      setMessage(
        result.total === 0
          ? "Nothing was waiting — the site is already up to date."
          : `Published — ${summarise(result)} ${
              result.total === 1 ? "is" : "are"
            } now live. Customers can see ${result.total === 1 ? "this change" : "these changes"} now.`
      );
      await refresh();
      setTimeout(() => setState("idle"), 8000);
    } catch (err) {
      setState("error");
      // publish_all raises a readable message for the cases it refuses, e.g. a
      // product sitting in a category that would not exist afterwards.
      setMessage(
        adminErrorMessage(err as Error, "publish") +
          " Customers still see the previous live version."
      );
    }
  };

  const discard = async () => {
    setConfirmDiscard(false);
    setState("discarding");
    setMessage(null);
    try {
      await discardDrafts(getBrowserSupabase());
      await refresh();
      setState("idle");
      setMessage("Unpublished changes discarded. The admin now matches the live site; customers weren't affected.");
    } catch (err) {
      setState("error");
      setMessage(adminErrorMessage(err as Error, "discard the changes"));
    }
  };

  const total = pending?.total ?? 0;
  const busy = state === "publishing" || state === "discarding";

  return (
    <div className="mb-8 rounded-2xl border border-ink/10 bg-linen/50 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 text-sm" role="status">
          {state === "published" || (state === "idle" && message) ? (
            <span className="font-medium text-ink">{message}</span>
          ) : countFailed ? (
            <span className="font-medium text-terracotta-dark">
              Couldn&apos;t check what&apos;s waiting to publish. Reload the
              page, signing in again if asked.
            </span>
          ) : pending === null ? (
            <span className="text-ink/60">Checking for unpublished changes…</span>
          ) : total > 0 ? (
            <>
              <span className="font-medium text-ink">
                {total} unpublished {total === 1 ? "change" : "changes"}
              </span>
              <span className="text-ink/70"> — {summarise(pending!)}. Customers still see the live version until you publish.</span>
            </>
          ) : (
            <span className="text-ink/60">
              Everything is published. Edits you make are saved as drafts until
              you publish them.
            </span>
          )}
        </div>
        {state === "error" && message && (
          <p role="alert" className="basis-full text-sm text-terracotta-dark">
            {message}
          </p>
        )}

        <div className="flex items-center gap-3">
          {total > 0 &&
            (confirmDiscard ? (
              <span
                role="group"
                aria-label="Confirm discarding all unpublished changes"
                className="flex max-w-md flex-wrap items-center gap-2 text-xs"
              >
                <span className="text-terracotta-dark">{discardAllText(total)}</span>
                <button type="button" onClick={discard} className="font-medium text-terracotta-dark underline">
                  Discard all
                </button>
                <button type="button" autoFocus onClick={() => setConfirmDiscard(false)} className="text-ink/70">
                  Cancel
                </button>
              </span>
            ) : (
              <button
                onClick={() => setConfirmDiscard(true)}
                disabled={busy}
                className="inline-flex items-center gap-1.5 text-xs text-ink/50 transition-colors hover:text-terracotta disabled:opacity-40"
              >
                <Undo2 className="h-3.5 w-3.5" /> Discard
              </button>
            ))}

          {/* The count says how much is pending; this is how you find out
              WHAT. Publishing without being able to look first is the gap this
              closes. */}
          {total > 0 && onReview && (
            <button
              onClick={onReview}
              className="inline-flex items-center gap-1.5 rounded-full border border-ink/20 px-4 py-2 text-xs font-medium text-ink transition-colors hover:border-ink hover:bg-ink hover:text-cream"
            >
              <ListChecks className="h-3.5 w-3.5" /> Review
            </button>
          )}

          {/* Preview opens the real storefront rendered from drafts, so the
              check before publishing is the actual page, not a description of
              it. Only useful when something is pending. */}
          {total > 0 && (
            <a
              href="/api/preview?path=/in"
              className="inline-flex items-center gap-1.5 rounded-full border border-ink/20 px-4 py-2 text-xs font-medium text-ink transition-colors hover:border-ink hover:bg-ink hover:text-cream"
            >
              <Eye className="h-3.5 w-3.5" /> Preview
            </a>
          )}

          <button
            onClick={publish}
            disabled={total === 0 || busy}
            className="inline-flex items-center gap-2 rounded-full bg-ink px-6 py-2.5 text-sm font-medium text-cream transition-colors hover:bg-ink-light disabled:opacity-40"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Rocket className="h-4 w-4" />
            )}
            {state === "publishing" ? "Publishing…" : "Publish to site"}
          </button>
        </div>
      </div>
    </div>
  );
}
