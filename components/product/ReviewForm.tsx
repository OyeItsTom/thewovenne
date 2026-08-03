"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Star } from "lucide-react";
import Button from "@/components/ui/Button";
import { getBrowserSupabase } from "@/lib/supabase";

/**
 * Write or amend a review.
 *
 * Only rendered for someone the database would actually accept — but the
 * database is still the thing that decides. If RLS refuses the insert, the
 * error is shown rather than swallowed: a form that silently does nothing is
 * worse than one that admits it failed.
 */
const MIN = 10;
const MAX = 2000;

export default function ReviewForm({
  productId,
  existing,
}: {
  productId: string;
  existing: { id: string; rating: number; body: string } | null;
}) {
  const router = useRouter();
  const [rating, setRating] = useState(existing?.rating ?? 0);
  const [hover, setHover] = useState(0);
  const [body, setBody] = useState(existing?.body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const trimmed = body.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < MIN;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (rating < 1) return setError("Please choose a rating.");
    if (trimmed.length < MIN) {
      return setError(`Please write at least ${MIN} characters.`);
    }

    setBusy(true);
    const supabase = getBrowserSupabase();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setBusy(false);
      return setError("You need to be logged in.");
    }

    const { error: writeError } = existing
      ? await supabase
          .from("product_reviews")
          .update({ rating, body: trimmed, updated_at: new Date().toISOString() })
          .eq("id", existing.id)
      : await supabase.from("product_reviews").insert({
          product_id: productId,
          user_id: user.id,
          rating,
          body: trimmed,
        });

    setBusy(false);

    if (writeError) {
      // The unique index is the one failure worth translating: it means they
      // already have a review, which is a fact rather than an error.
      setError(
        writeError.code === "23505"
          ? "You've already reviewed this piece — reload to edit it."
          : writeError.message
      );
      return;
    }

    setDone(true);
    router.refresh();
  }

  if (done) {
    return (
      <p className="rounded-xl border border-ink/10 bg-linen/50 px-5 py-4 text-sm text-ink/70">
        Thank you — your review is live.
      </p>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-2xl border border-ink/10 bg-cream p-6"
    >
      <h3 className="font-heading text-xl text-ink">
        {existing ? "Edit your review" : "Write a review"}
      </h3>
      <p className="mt-1 text-sm text-ink/55">
        You bought this piece, so your view of it counts.
      </p>

      <fieldset className="mt-5">
        <legend className="text-sm font-medium text-ink/70">Rating</legend>
        <div className="mt-2 flex gap-1" onMouseLeave={() => setHover(0)}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setRating(n)}
              onMouseEnter={() => setHover(n)}
              aria-label={`${n} star${n === 1 ? "" : "s"}`}
              aria-pressed={rating === n}
              className="p-0.5"
            >
              <Star
                className={`h-7 w-7 transition-colors ${
                  n <= (hover || rating)
                    ? "fill-terracotta text-terracotta"
                    : "text-ink/25"
                }`}
                strokeWidth={1.5}
              />
            </button>
          ))}
        </div>
      </fieldset>

      <label className="mt-5 block text-sm">
        <span className="font-medium text-ink/70">Your review</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value.slice(0, MAX))}
          rows={5}
          className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2.5 text-sm text-ink focus:border-terracotta focus:outline-none"
          placeholder="How does it wear? How did it wash?"
        />
        <span className="mt-1 block text-xs text-ink/45">
          {tooShort
            ? `A little more — ${MIN - trimmed.length} to go.`
            : `${trimmed.length} / ${MAX}`}
        </span>
      </label>

      {error && (
        <p className="mt-4 rounded-lg bg-terracotta/10 px-4 py-2.5 text-sm text-terracotta-dark">
          {error}
        </p>
      )}

      <Button type="submit" disabled={busy} className="mt-5">
        {busy ? (
          <span className="inline-flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Posting…
          </span>
        ) : existing ? (
          "Update review"
        ) : (
          "Post review"
        )}
      </Button>
    </form>
  );
}
