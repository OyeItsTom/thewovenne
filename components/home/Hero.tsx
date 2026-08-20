import Image from "next/image";
import Link from "next/link";
import { buttonClassName } from "@/components/ui/Button";
import { DEFAULT_CONTENT } from "@/lib/content";
import { adminHref } from "@/lib/country";
import type { HomeHeroContent } from "@/lib/types";

/**
 * Emblem-led hero: the woven mark, with the wordmark set beneath it.
 *
 * THE WORDMARK LIVES HERE, NOT IN THE NAV. The header carries the emblem alone,
 * so the name is stated once, deliberately, at full size — rather than repeated
 * small in the corner of every page. Wide letter-spacing and a hairline rule
 * keep it quiet enough to read as a mark rather than a heading.
 *
 * The section uses the page background token rather than a colour of its own,
 * so the transparent PNG can never show an edge against the surrounding page.
 */
export default function Hero({ content }: { content?: HomeHeroContent }) {
  const c = content ?? DEFAULT_CONTENT.home_hero;

  return (
    // hero-viewport, not a vh fraction: the hero is the first screen and the
    // next section starts below the fold at every aspect ratio. py-12 below sm
    // because at 320x568 the old py-20 made the content taller than the space
    // it had, which is the same fault from the other direction.
    <section className="hero-viewport flex flex-col items-center justify-center bg-cream px-6 py-12 sm:py-20">
      <Image
        src="/logo_emblem_transparent.png"
        alt=""
        width={3096}
        height={2792}
        priority
        sizes="(max-width: 768px) 78vw, 38rem"
        className="h-auto max-h-[52vh] w-[min(78vw,38rem)] object-contain"
      />

      {/* The h1 is the wordmark itself now that it is visible, rather than a
          screen-reader-only line duplicating it. */}
      {/* The floor is 1.3rem, not 1.75rem. At 0.42em tracking the wordmark is
          326px wide at 28px — fine on a 390px iPhone, 14px too wide for a
          360px Android, where it would clip or push the page sideways. Letting
          6vw keep shrinking below that point is what makes it fit. */}
      <h1 className="mt-8 text-center font-heading text-[clamp(1.3rem,6vw,3.25rem)] font-light uppercase leading-none tracking-[0.42em] text-ink">
        {/* The tracking adds a trailing gap on the last letter; the negative
            margin pulls the block back to true centre. */}
        <span className="-mr-[0.42em] inline-block">The Wovenne</span>
      </h1>

      {/* The rule separates the mark from the action, which is the whole job it
          has now. It used to sit above a line of text that repeated the
          wordmark — c.heading is literally "THE WOVENNE", so the name printed
          twice. */}
      <span aria-hidden className="mt-8 h-px w-14 bg-ink/20" />

      <Link href={adminHref(c.cta_href)} className={buttonClassName("ghost", "lg", "mt-8")}>
        {c.cta_label}
      </Link>
    </section>
  );
}
