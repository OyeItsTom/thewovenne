import Stars from "./Stars";
import ReviewFormGate from "./ReviewFormGate";
import type { Review, RatingSummary } from "@/lib/reviews";

/**
 * The reviews section of a product page.
 *
 * The list is server-rendered — it is public, identical for everyone, and
 * belongs in the cached HTML where crawlers can see it. The FORM is gated in
 * the browser instead, so asking "did this person buy this?" does not make
 * every product page dynamic for everybody. See ReviewFormGate.
 *
 * WHO SEES A FORM: only someone whose delivered order contained this piece.
 * Everyone else sees the reviews and no invitation — an empty form that
 * rejects you on submit is worse than no form, and "verified purchase" means
 * nothing if the box is there for everybody.
 *
 * Nothing is said to non-purchasers about why they cannot write one. A line
 * explaining that only buyers may review reads, to someone who did buy and
 * cannot see the form, as an accusation.
 */
export default function ProductReviews({
  productId,
  reviews,
  rating,
}: {
  productId: string;
  reviews: Review[];
  rating: RatingSummary;
}) {
  return (
    <section id="reviews" className="mt-20 scroll-mt-24 border-t border-ink/10 pt-14">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h2 className="font-heading text-3xl text-ink">Reviews</h2>
        {rating.total > 0 && rating.average !== null && (
          <div className="flex items-center gap-2.5">
            <Stars rating={rating.average} size="md" />
            <span className="text-sm text-ink/70">
              {rating.average.toFixed(1)} · {rating.total}{" "}
              {rating.total === 1 ? "review" : "reviews"}
            </span>
          </div>
        )}
      </div>

      <div className="mt-8 grid gap-10 lg:grid-cols-[1fr_22rem]">
        <div>
          {reviews.length === 0 ? (
            <p className="text-sm text-ink/55">
              No reviews yet — they appear here once customers have worn their
              pieces.
            </p>
          ) : (
            <ul className="space-y-8">
              {reviews.map((review) => (
                <li
                  key={review.id}
                  className="border-b border-ink/10 pb-8 last:border-0"
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <Stars rating={review.rating} />
                    {/* Every review here is from a verified buyer — the
                        database allows no other kind — so the badge states a
                        fact rather than decorating one. */}
                    <span className="rounded-full bg-linen px-2.5 py-0.5 text-[11px] uppercase tracking-wider text-ink/60">
                      Verified purchase
                    </span>
                  </div>
                  <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-ink/80">
                    {review.body}
                  </p>
                  <p className="mt-3 text-xs text-ink/45">
                    {review.author} ·{" "}
                    {new Date(review.created_at).toLocaleDateString("en-GB", {
                      day: "numeric",
                      month: "long",
                      year: "numeric",
                    })}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="lg:sticky lg:top-24 lg:self-start">
          <ReviewFormGate productId={productId} />
        </div>
      </div>
    </section>
  );
}
