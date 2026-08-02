import Image from "next/image";
import Link from "next/link";
import type { SeasonalEditContent } from "@/lib/types";

/**
 * The seasonal edit — one image, a short heading, one understated link.
 *
 * Sits below the hero and leaves the hero untouched. Renders nothing at all
 * unless the campaign is enabled AND has both a heading and an image, so a
 * half-filled draft cannot put an empty band on the homepage.
 *
 * No countdown, no sale colour, no badge: the same terracotta-and-graphite
 * palette as the rest of the site, and the link is a text link rather than a
 * button, so a campaign reads as an editorial note rather than a promotion.
 */
export default function SeasonalEdit({
  content,
}: {
  content: SeasonalEditContent;
}) {
  if (!content.enabled) return null;
  if (!content.heading?.trim() || !content.image_url?.trim()) return null;

  const hasLink = !!content.link_href?.trim() && !!content.link_label?.trim();
  const mobileSrc = content.image_url_mobile?.trim() || content.image_url;

  return (
    <section className="section-padding">
      <div className="container-wovenne grid items-center gap-10 md:grid-cols-2 md:gap-16">
        {/* Two crops rather than one: a wide desktop frame and a portrait
            mobile one differ enough that a single file has to be centre-cropped
            for at least one of them, which throws away the composition. Both
            are in the DOM and CSS picks. Both are lazy, so browsers normally
            skip fetching the display:none one — but that is a browser
            optimisation, not a guarantee. <picture> with media queries would
            guarantee it; next/image cannot express that, and the correct crop
            is worth more than a possible extra request.

            Falling back to the desktop file keeps a campaign publishable before
            its mobile crop exists; the admin flags the gap rather than blocking
            on it. */}
        <div className="relative aspect-[4/5] overflow-hidden rounded-xl bg-linen md:aspect-[4/3]">
          <Image
            src={mobileSrc}
            alt={content.heading}
            fill
            sizes="100vw"
            className="object-cover md:hidden"
          />
          <Image
            src={content.image_url}
            alt={content.heading}
            fill
            sizes="50vw"
            className="hidden object-cover md:block"
          />
        </div>

        <div>
          {content.eyebrow?.trim() && (
            <p className="eyebrow">{content.eyebrow}</p>
          )}
          <h2 className="mt-3 font-heading text-display-sm text-ink">
            {content.heading}
          </h2>
          {content.body?.trim() && (
            <p className="mt-5 max-w-prose text-base leading-relaxed text-ink/70">
              {content.body}
            </p>
          )}
          {hasLink && (
            <Link
              href={content.link_href}
              className="mt-7 inline-block border-b border-terracotta pb-1 text-xs uppercase tracking-widest text-terracotta transition-colors hover:border-ink hover:text-ink"
            >
              {content.link_label}
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}
