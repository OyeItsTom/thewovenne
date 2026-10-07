import { ChevronDown } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import type { CareGuidance } from "@/lib/care";
import type { PolicySummary } from "@/lib/policySummary";
import type { FactRow } from "@/lib/productInfo";

/**
 * Product details, care, delivery and returns — the questions a customer asks
 * between liking a piece and buying it, answered under the purchase controls.
 *
 * NATIVE <details>, AND THEREFORE NO JAVASCRIPT. The browser supplies the
 * button, the keyboard handling (Enter and Space on the summary) and the
 * expanded/collapsed state a screen reader announces. The whole block is
 * server-rendered: static product facts never needed a client component, and
 * the fold this replaces (MaterialCare) shipped one just to toggle a class.
 * Opening a section is the customer's own action, so it moves nothing they
 * did not ask to move.
 *
 * ONLY WHAT IS STORED OR PUBLISHED. Every value arrives decided:
 *   - facts: productFactRows — stored values that apply to this product type,
 *     the same rows the Product markup states;
 *   - care: careFor — the note written for this piece, never generic advice;
 *   - delivery / returns: policySummary — the policy pages' own published
 *     intros, quoted, each with a link to the full page.
 * A section with nothing to say is not rendered, and if none has anything the
 * block renders nothing at all. No badges, no filler, no "Easy returns".
 *
 * Product details starts open — it is the short list of what the piece is,
 * and it was always visible before. Care and the policies start folded so the
 * buy column stays short enough to sit beside the gallery.
 */
export default function ProductReassurance({
  facts,
  care,
  policies,
}: {
  facts: FactRow[];
  care: CareGuidance | null;
  policies: PolicySummary[];
}) {
  if (facts.length === 0 && !care && policies.length === 0) return null;

  return (
    <div className="mt-8 border-t border-ink/10">
      {facts.length > 0 && (
        <Section title="Product details" open>
          {/* Colour is deliberately absent — the stored colour does not yet
              reliably describe the cloth (most pieces read "Off-white"
              whatever their border). */}
          <dl className="space-y-5">
            {facts.map((row) => (
              <div key={row.key}>
                <dt className="font-heading text-sm uppercase tracking-wider text-ink-muted">
                  {row.label}
                </dt>
                <dd className="mt-1.5 whitespace-pre-line text-[15px] leading-relaxed text-ink">
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      )}

      {care && (
        <Section title="Care">
          {/* whitespace-pre-line so the paragraph breaks somebody typed
              survive, without running their prose through a renderer. */}
          <p className="whitespace-pre-line text-[15px] leading-relaxed text-ink/80">
            {care.text}
          </p>
        </Section>
      )}

      {policies.length > 0 && (
        <Section title="Delivery & returns">
          <dl className="space-y-5">
            {policies.map((policy) => (
              <div key={policy.key}>
                <dt className="font-heading text-sm uppercase tracking-wider text-ink-muted">
                  {policy.label}
                </dt>
                <dd className="mt-1.5 text-[15px] leading-relaxed text-ink/80">
                  <p>{policy.summary}</p>
                  <Link
                    href={policy.href}
                    className="mt-2 inline-block text-ink underline decoration-ink/25 underline-offset-4 transition-colors hover:decoration-terracotta"
                  >
                    {policy.linkText}
                  </Link>
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  open = false,
  children,
}: {
  title: string;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="group border-b border-ink/10" open={open}>
      {/* list-none and the webkit marker rule remove the default triangle; the
          chevron is the one cue, and it is decoration — the open state itself
          is announced by the browser. At least 44px tall for a thumb. */}
      <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-4 py-4 text-sm uppercase tracking-wider text-ink transition-colors hover:text-terracotta-deep [&::-webkit-details-marker]:hidden">
        <span className="font-heading">{title}</span>
        <ChevronDown
          aria-hidden
          strokeWidth={1.5}
          className="h-4 w-4 shrink-0 text-ink-muted transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      <div className="pb-6">{children}</div>
    </details>
  );
}
