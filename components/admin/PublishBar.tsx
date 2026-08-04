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

  const refresh = useCallback(async () => {
    const next = await getPendingChanges(getBrowserSupabase());
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
      setMessage(
        result.total === 0
          ? "Nothing was waiting — the site is already up to date."
          : `Successfully published — ${summarise(result)} ${
              result.total === 1 ? "is" : "are"
            } now live.`
      );
      await refresh();
      setTimeout(() => setState("idle"), 8000);
    } catch (err) {
      setState("error");
      // publish_all raises a readable message for the cases it refuses, e.g. a
      // product sitting in a category that would not exist afterwards.
      setMessage(err instanceof Error ? err.message : "Publishing failed.");
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
      setMessage("Pending changes discarded. The admin now matches the live site.");
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : "Could not discard drafts.");
    }
  };

  const total = pending?.total ?? 0;
  const busy = state === "publishing" || state === "discarding";

  return (
    <div className="mb-8 rounded-2xl border border-ink/10 bg-linen/50 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 text-sm">
          {state === "published" || (state === "idle" && message) ? (
            <span className="font-medium text-ink">{message}</span>
          ) : total > 0 ? (
            <>
              <span className="font-medium text-ink">
                {total} unpublished {total === 1 ? "change" : "changes"}
              </span>
              <span className="text-ink/60"> — {summarise(pending!)}. Not on the site yet.</span>
            </>
          ) : (
            <span className="text-ink/60">
              Everything is published. Edits you make are saved as drafts until
              you publish them.
            </span>
          )}
          {state === "error" && message && (
            <p className="mt-1 text-terracotta-dark">{message}</p>
          )}
        </div>

        <div className="flex items-center gap-3">
          {total > 0 &&
            (confirmDiscard ? (
              <span className="flex items-center gap-2 text-xs">
                <span className="text-terracotta-dark">Discard all {total}?</span>
                <button onClick={discard} className="font-medium text-terracotta-dark underline">
                  Discard
                </button>
                <button onClick={() => setConfirmDiscard(false)} className="text-ink/50">
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
