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
      {/* The band takes its shape from the IMAGE, not the viewport: 3:4 on
          mobile and 16:9 on desktop, matching the two recommended exports. A
          container whose ratio matches the file it holds crops nothing and
          letterboxes nothing at any screen width, because the two scale
          together.

          The cost is height on very wide screens — 16:9 at 2560px is 1440px
          tall, more than a typical viewport. That is the deliberate trade for
          never losing part of the composition. */}
      <div className="relative aspect-[3/4] w-full md:aspect-[16/9]">
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

        {/* Legibility, and it has to survive the worst case.

            A gentle gradient is enough over a photograph, which is usually dark
            and low-contrast where text sits. It is NOT enough over an
            illustration on a white ground — the first real campaign was exactly
            that, and cream text on white is unreadable. So the base is close to
            opaque and fades out by three-quarters height: the top of the image
            stays clean, and the strip carrying the words is always dark enough
            regardless of what is behind it. */}
        <div
          aria-hidden
          className="absolute inset-0 bg-[linear-gradient(to_top,rgba(28,31,59,0.94)_0%,rgba(28,31,59,0.82)_22%,rgba(28,31,59,0.45)_45%,rgba(28,31,59,0.12)_65%,rgba(28,31,59,0)_80%)]"
        />

        <div className="absolute inset-x-0 bottom-0">
          <div className="container-wovenne max-w-3xl pb-12 md:pb-16">
            {content.eyebrow?.trim() && (
              <p className="text-xs uppercase tracking-[0.2em] text-cream/80 drop-shadow-[0_1px_8px_rgba(28,31,59,0.55)]">
                {content.eyebrow}
              </p>
            )}
            {/* h2, not h1: the page already has one, and a campaign is a
                section of the homepage rather than its subject. */}
            <h2 className="mt-3 font-heading text-display-sm text-cream drop-shadow-[0_2px_12px_rgba(28,31,59,0.55)] md:text-display-md">
              {content.heading}
            </h2>
            {content.body?.trim() && (
              <p className="mt-4 max-w-prose text-base leading-relaxed text-cream/90 drop-shadow-[0_1px_8px_rgba(28,31,59,0.55)]">
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
