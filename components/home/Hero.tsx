import Image from "next/image";
import Link from "next/link";
import { buttonClassName } from "@/components/ui/Button";
import { DEFAULT_CONTENT } from "@/lib/content";
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
    <section className="flex min-h-[82vh] flex-col items-center justify-center bg-cream px-6 py-20">
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
      <h1 className="mt-8 text-center font-heading text-[clamp(1.75rem,6vw,3.25rem)] font-light uppercase leading-none tracking-[0.42em] text-ink">
        {/* The tracking adds a trailing gap on the last letter; the negative
            margin pulls the block back to true centre. */}
        <span className="-mr-[0.42em] inline-block">The Wovenne</span>
      </h1>

      <span aria-hidden className="mt-7 h-px w-14 bg-ink/20" />

      <p className="mt-5 max-w-md text-center text-sm leading-relaxed text-ink/60">
        {c.heading}
      </p>

      <Link href={c.cta_href} className={buttonClassName("ghost", "lg", "mt-10")}>
        {c.cta_label}
      </Link>
    </section>
  );
}
