import Image from "next/image";
import Link from "next/link";
import { buttonClassName } from "@/components/ui/Button";
import { DEFAULT_CONTENT } from "@/lib/content";
import type { HomeHeroContent } from "@/lib/types";

/**
 * Temporary emblem-led hero: the woven mark alone, no wordmark, no motion.
 * The animated brand film replaces this later.
 *
 * The section uses the page background token rather than a colour of its own,
 * so the transparent PNG can never show an edge against the surrounding page.
 */
export default function Hero({ content }: { content?: HomeHeroContent }) {
  const c = content ?? DEFAULT_CONTENT.home_hero;

  return (
    <section className="flex min-h-[82vh] flex-col items-center justify-center bg-cream px-6 py-20">
      {/* The homepage still needs an h1 for SEO; the emblem carries it visually. */}
      <h1 className="sr-only">{c.heading}</h1>

      <Image
        src="/logo_emblem_transparent.png"
        alt="THE WOVENNE"
        width={3096}
        height={2792}
        priority
        sizes="(max-width: 768px) 86vw, 44rem"
        className="h-auto max-h-[64vh] w-[min(86vw,44rem)] object-contain"
      />

      <Link href={c.cta_href} className={buttonClassName("ghost", "lg", "mt-14")}>
        {c.cta_label}
      </Link>
    </section>
  );
}
