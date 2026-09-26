"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CareGuidance } from "@/lib/care";

/**
 * Material and care, as a section of the page rather than a drawer in the buy
 * column.
 *
 * WHY IT MOVED. It used to sit under the add-to-cart button as a collapsed
 * accordion, which put how to wash a garment in the same column as the decision
 * to buy it — and hid it behind a click. On a piece whose whole argument is that
 * it will last, care instructions are part of the argument, not an appendix.
 *
 * OPEN ON DESKTOP, FOLDED ON MOBILE, and done with CSS rather than a media
 * query in JavaScript: the body is `hidden lg:block`, so a wide screen shows it
 * with no state involved at all, and the toggle button is `lg:hidden`. The
 * server renders the folded state and a desktop browser never sees it — no
 * hydration mismatch, and no measuring the viewport to decide what to draw.
 *
 * NO framer-motion. The old accordion animated its height with a library that
 * costs ~50 KB shared-bundle for a fold nobody watches closely — the same
 * reasoning that replaced whileInView in useReveal.
 *
 * ONE SOURCE (SEO-6A): the care note somebody wrote about THIS piece. The
 * fabric-table and generic fallbacks are gone — see lib/care — so the caller
 * renders this section only when careFor() found a note, and a piece with
 * nothing written about it shows no Material & Care section at all.
 */
export default function MaterialCare({
  fabric,
  care,
}: {
  fabric: string | null;
  /** Decided on the server by careFor() — see lib/care. Never null here. */
  care: CareGuidance;
}) {
  const [open, setOpen] = useState(false);

  return (
    <section className="mt-24 border-t border-ink/10 pt-16" aria-labelledby="material-care">
      <div className="text-center">
        <h2 id="material-care" className="font-heading text-3xl text-ink sm:text-4xl">
          Material &amp; Care
        </h2>
      </div>

      {/* Mobile only: the fold. Desktop shows the body regardless of this state,
          so the button is not merely hidden — it is irrelevant there. */}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="care-body"
        className="mx-auto mt-6 flex items-center gap-2 text-xs uppercase tracking-wider text-ink/55 transition-colors hover:text-terracotta lg:hidden"
      >
        {open ? "Hide" : "How to look after it"}
        <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
      </button>

      <div
        id="care-body"
        className={cn(
          "mx-auto mt-10 max-w-3xl gap-12 sm:grid-cols-[auto,1fr]",
          open ? "grid" : "hidden lg:grid"
        )}
      >
        {fabric && (
          <div className="sm:border-r sm:border-ink/10 sm:pr-12">
            <h3 className="text-xs uppercase tracking-wider text-ink/50">Fabric</h3>
            <p className="mt-3 font-heading text-2xl text-ink">{fabric}</p>
          </div>
        )}

        <div>
          <h3 className="text-xs uppercase tracking-wider text-ink/50">
            How to look after it
          </h3>
          {/* whitespace-pre-line so the paragraph breaks somebody typed survive,
              without running their prose through a markdown renderer. */}
          <p className="mt-3 whitespace-pre-line text-base leading-relaxed text-ink/70">
            {care.text}
          </p>
        </div>
      </div>
    </section>
  );
}
