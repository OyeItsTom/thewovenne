import Image from "next/image";
import Link from "next/link";
import type { SeasonalEditContent } from "@/lib/types";

/**
 * The seasonal edit — a full-bleed band below the hero.
 *
 * Edge to edge, with the wording set over the photograph rather than beside it,
 * so a campaign reads as a piece of art direction instead of a promotion. The
 * hero above it is untouched.
 *
 * Renders nothing unless the campaign is enabled AND has both a heading and an
 * image, so a half-filled draft cannot leave an empty band on the homepage.
 *
 * Still quiet: no countdown, no sale colour, no badge, and the call to action is
 * a text link rather than a button.
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

  // Filling a band whose shape differs from the image means cropping — that is
  // what "cover" is. For a photograph the lost edge costs nothing; for an
  // illustration or anything containing text it destroys the subject. So the
  // campaign chooses, and "contain" shows the whole image against the band.
  const contain = content.image_fit === "contain";
  const fit = contain ? "object-contain" : "object-cover";

  return (
    <section className="relative isolate w-full overflow-hidden bg-ink">
      {/* Sized in viewport height rather than by aspect ratio: a fixed ratio
          either towers on a wide monitor or collapses on a short laptop, and a
          full-bleed band has to sit well on both. */}
      <div className="relative h-[78vh] min-h-[440px] w-full md:h-[68vh] md:min-h-[460px] md:max-h-[720px]">
        {/* Two crops, not one. Full-bleed means the frame is landscape on
            desktop and portrait on mobile — far enough apart that a single file
            has to be centre-cropped for one of them, which is precisely the
            composition a campaign image exists to control.

            Both are in the DOM and CSS picks. Both are lazy, so browsers
            normally skip fetching the display:none one, but that is an
            optimisation rather than a guarantee. <picture> with media queries
            would guarantee it; next/image cannot express that, and the right
            crop is worth more than a possible extra request.

            Falling back to the desktop file keeps a campaign publishable before
            its mobile crop exists; the admin flags the gap rather than blocking. */}
        <Image
          src={mobileSrc}
          alt=""
          fill
          sizes="100vw"
          className={`${fit} md:hidden`}
        />
        <Image
          src={content.image_url}
          alt=""
          fill
          sizes="100vw"
          className={`hidden ${fit} md:block`}
        />

        {/* Legibility, not decoration. Text over an uncontrolled photograph is
            unreadable often enough that it needs a floor, and a gradient keeps
            the top of the image clean while guaranteeing contrast where the
            words actually sit. */}
        <div
          aria-hidden
          className={
            contain
              ? "absolute inset-0 bg-gradient-to-t from-ink/60 to-transparent"
              : "absolute inset-0 bg-gradient-to-t from-ink/80 via-ink/30 to-ink/5"
          }
        />

        <div className="absolute inset-x-0 bottom-0">
          <div className="container-wovenne max-w-3xl pb-12 md:pb-16">
            {content.eyebrow?.trim() && (
              <p className="text-xs uppercase tracking-[0.2em] text-cream/70">
                {content.eyebrow}
              </p>
            )}
            {/* h2, not h1: the page already has one, and a campaign is a
                section of the homepage rather than its subject. */}
            <h2 className="mt-3 font-heading text-display-sm text-cream md:text-display-md">
              {content.heading}
            </h2>
            {content.body?.trim() && (
              <p className="mt-4 max-w-prose text-base leading-relaxed text-cream/80">
                {content.body}
              </p>
            )}
            {hasLink && (
              <Link
                href={content.link_href}
                className="mt-7 inline-block border-b border-cream/50 pb-1 text-xs uppercase tracking-widest text-cream transition-colors hover:border-cream hover:text-white"
              >
                {content.link_label}
              </Link>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
