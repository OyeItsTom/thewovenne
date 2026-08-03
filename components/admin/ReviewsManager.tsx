"use client";

import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, Loader2, Trash2 } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import Stars from "@/components/product/Stars";

/**
 * Review moderation.
 *
 * HIDE IS THE DEFAULT ACTION, DELETE IS THE EXCEPTION. Hiding is reversible and
 * leaves the row where an admin can still see it; deleting removes a customer's
 * words permanently. A shop that can silently erase criticism should at least
 * have to mean it, so delete asks first and hide does not.
 *
 * Both go through SECURITY DEFINER functions that check is_admin() themselves —
 * this component being admin-only is a convenience, not the control.
 */

interface AdminReview {
  id: string;
  product_id: string;
  product_name: string | null;
  product_slug: string | null;
  rating: number;
  body: string;
  author: string;
  author_email: string | null;
  hidden_at: string | null;
  created_at: string;
}

export default function ReviewsManager() {
  const [reviews, setReviews] = useState<AdminReview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: rpcError } = await getBrowserSupabase().rpc(
      "admin_reviews",
      { p_include_hidden: true }
    );
    if (rpcError) {
      setError(rpcError.message);
      setReviews([]);
      return;
    }
    setError(null);
    setReviews((data ?? []) as AdminReview[]);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleHidden(review: AdminReview) {
    setBusyId(review.id);
    const { error: rpcError } = await getBrowserSupabase().rpc(
      "set_review_hidden",
      { p_id: review.id, p_hidden: review.hidden_at === null }
    );
    setBusyId(null);
    if (rpcError) return setError(rpcError.message);
    await load();
  }

  async function remove(review: AdminReview) {
    // A native confirm rather than a custom modal: it is a genuinely
    // destructive, one-off action, and the browser's own dialog is the one
    // people already know they cannot dismiss by accident.
    if (
      !window.confirm(
        `Delete this review permanently?\n\n"${review.body.slice(0, 120)}"\n\nHiding it is reversible; this is not.`
      )
    ) {
      return;
    }
    setBusyId(review.id);
    const { error: delError } = await getBrowserSupabase()
      .from("product_reviews")
      .delete()
      .eq("id", review.id);
    setBusyId(null);
    if (delError) return setError(delError.message);
    await load();
  }

  if (reviews === null) {
    return <p className="py-10 text-center text-sm text-ink/50">Loading…</p>;
  }

  return (
    <div>
      {error && (
        <p className="mb-6 rounded-lg bg-terracotta/10 px-4 py-3 text-sm text-terracotta-dark">
          {error}
        </p>
      )}

      {reviews.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-ink/15 py-16 text-center">
          <p className="font-heading text-xl text-ink">No reviews yet</p>
          <p className="mx-auto mt-2 max-w-sm text-sm text-ink/55">
            Only customers with a delivered order containing the piece can write
            one, so these arrive after the first deliveries.
          </p>
        </div>
      ) : (
        <ul className="space-y-4">
          {reviews.map((review) => {
            const hidden = review.hidden_at !== null;
            return (
              <li
                key={review.id}
                className={`rounded-2xl border p-5 ${
                  hidden ? "border-ink/10 bg-linen/40" : "border-ink/10 bg-cream"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-3">
                      <Stars rating={review.rating} />
                      <span className="text-sm font-medium text-ink">
                        {review.product_name ?? "Unknown product"}
                      </span>
                      {hidden && (
                        <span className="rounded-full bg-ink/10 px-2.5 py-0.5 text-[11px] uppercase tracking-wider text-ink/60">
                          Hidden
                        </span>
                      )}
                    </div>

                    <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-ink/80">
                      {review.body}
                    </p>

                    <p className="mt-3 text-xs text-ink/45">
                      {review.author}
                      {review.author_email && ` · ${review.author_email}`} ·{" "}
                      {new Date(review.created_at).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      onClick={() => toggleHidden(review)}
                      disabled={busyId === review.id}
                      title={hidden ? "Show on the site" : "Hide from the site"}
                      className="rounded-lg border border-ink/15 p-2 text-ink/60 transition-colors hover:border-ink/30 hover:text-ink disabled:opacity-40"
                    >
                      {busyId === review.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : hidden ? (
                        <Eye className="h-4 w-4" />
                      ) : (
                        <EyeOff className="h-4 w-4" />
                      )}
                    </button>
                    <button
                      onClick={() => remove(review)}
                      disabled={busyId === review.id}
                      title="Delete permanently"
                      className="rounded-lg border border-ink/15 p-2 text-ink/40 transition-colors hover:border-terracotta/40 hover:text-terracotta disabled:opacity-40"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
