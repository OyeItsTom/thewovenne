import Image from "next/image";
import Link from "next/link";
import { DEFAULT_CONTENT } from "@/lib/content";
import type { LookbookContent, LookbookImage, LookbookSection } from "@/lib/types";

/**
 * Full-bleed lookbook blocks, immediately below the hero.
 *
 * BACKGROUND IS bg-cream, WHICH IS #FFFFFF. The token is named cream and its
 * value is pure white — the page background token, so these sections can never
 * develop a seam against the page the way a hardcoded white would if the token
 * ever moved. (linen, #F0EAD6, is the actual off-white, used on cards.)
 *
 * MOBILE STACKS, ALWAYS. A three-up split on a phone is three slivers; each
 * image instead takes the full width, one after another, which is how people
 * already read a feed. The desktop split only exists from `md` up.
 *
 * Nothing renders until an image exists. A section that is enabled but empty
 * would be a white gap the admin cannot see the cause of.
 */

/** Portrait on phones, landscape on desktop — the shapes each screen wants. */
const RATIO = {
  single: "aspect-[4/5] md:aspect-[16/9]",
  "split-2": "aspect-[4/5] md:aspect-[3/4]",
  "split-3": "aspect-[4/5] md:aspect-[2/3]",
} as const;

const COLUMNS = {
  single: "md:grid-cols-1",
  "split-2": "md:grid-cols-2",
  "split-3": "md:grid-cols-3",
} as const;

/** How much of the viewport one image occupies, so Next ships the right file. */
const SIZES = {
  single: "100vw",
  "split-2": "(max-width: 768px) 100vw, 50vw",
  "split-3": "(max-width: 768px) 100vw, 33vw",
} as const;

function usable(images: LookbookImage[]): LookbookImage[] {
  return images.filter((i) => i.image_url.trim() || i.image_url_mobile.trim());
}

function Frame({
  image,
  layout,
  priority,
}: {
  image: LookbookImage;
  layout: LookbookSection["layout"];
  priority: boolean;
}) {
  const desktop = image.image_url.trim();
  const mobile = image.image_url_mobile.trim();

  const picture = (
    <div className={`relative w-full overflow-hidden ${RATIO[layout]}`}>
      {/* Two <Image>s rather than one with a CSS swap: each screen then
          downloads only the crop it will actually show. */}
      <Image
        src={mobile || desktop}
        alt={image.alt}
        fill
        priority={priority}
        sizes="100vw"
        className="object-cover md:hidden"
      />
      <Image
        src={desktop || mobile}
        alt={image.alt}
        fill
        priority={priority}
        sizes={SIZES[layout]}
        className="hidden object-cover md:block"
      />
    </div>
  );

  const href = image.href.trim();
  if (!href) return picture;

  return (
    <Link
      href={href}
      // The image is the whole target — a small caption link under a large
      // picture is a small target next to an obvious one.
      className="group block focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracotta"
    >
      <div className="overflow-hidden">
        <div className="transition-transform duration-700 ease-out group-hover:scale-[1.02]">
          {picture}
        </div>
      </div>
    </Link>
  );
}

export default function LookbookSections({
  content,
}: {
  content?: LookbookContent;
}) {
  const sections = (content ?? DEFAULT_CONTENT.lookbook).sections ?? [];
  const live = sections
    .filter((s) => s.enabled)
    .map((s) => ({ ...s, images: usable(s.images ?? []) }))
    .filter((s) => s.images.length > 0);

  if (live.length === 0) return null;

  return (
    <div className="bg-cream">
      {live.map((section, sectionIndex) => (
        <section
          key={section.id}
          className={`grid grid-cols-1 gap-0 ${COLUMNS[section.layout]}`}
        >
          {section.images.map((image, i) => (
            <Frame
              key={i}
              image={image}
              layout={section.layout}
              // Only the very first image is eager: it is the one that can
              // appear above the fold, and marking them all priority would
              // have the browser fight itself for bandwidth.
              priority={sectionIndex === 0 && i === 0}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
