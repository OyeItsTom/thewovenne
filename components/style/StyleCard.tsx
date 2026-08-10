import Image from "next/image";
import Link from "next/link";
import { Play } from "lucide-react";
import { cPath } from "@/lib/country";
import { watchLabel } from "@/lib/styleMedia";
import { aspectRatio, type StyleItem } from "@/lib/style";

/**
 * One customer's photograph, as it appears in the gallery.
 *
 * THE SPACE IS RESERVED BEFORE THE IMAGE ARRIVES. next/image is given the real
 * width and height from the database (0052), so the browser knows the shape of
 * every card at first paint. Without that, a staggered column re-flows as each
 * photograph lands and the page walks down the screen while somebody is reading
 * it — the single most noticeable way a gallery of mixed sizes goes wrong.
 *
 * NOTHING IS CROPPED TO A GRID. Portraits stay portrait, landscapes stay
 * landscape, and the column takes whatever height follows. Forcing a square
 * would cut people's heads off, which is a strange way to thank them.
 *
 * A VIDEO IS NEVER EMBEDDED. A customer's own Reel carries their account's
 * branding, their suggested-video rail, and whatever advertising the platform
 * feels like — beside our own product. It shows as a card that opens the post in
 * a new tab: YouTube gets its thumbnail, Instagram gets a typographic card,
 * because Instagram's oEmbed needs a reviewed Meta app and inventing an image
 * would be worse than not having one.
 */
export default function StyleCard({ item }: { item: StyleItem }) {
  const ratio = aspectRatio(item);
  const productHref = cPath(`/product/${item.productSlug}`);

  return (
    <figure className="group mb-6 break-inside-avoid">
      <div className="relative overflow-hidden rounded-lg bg-linen/50">
        {item.photoUrl ? (
          <Image
            src={item.photoUrl}
            alt={
              item.creditName
                ? `${item.creditName} wearing the ${item.productName}`
                : `A customer wearing the ${item.productName}`
            }
            width={item.width ?? 1200}
            height={item.height ?? 1500}
            sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
            className="h-auto w-full transition-transform duration-700 ease-out group-hover:scale-[1.02]"
          />
        ) : (
          <VideoCard item={item} ratio={ratio} />
        )}
      </div>

      <figcaption className="mt-3 space-y-1.5">
        {item.caption && (
          <p className="text-sm leading-relaxed text-ink/75">{item.caption}</p>
        )}
        <p className="text-xs text-ink/50">
          {/* Named only if they asked to be. Null is not "unknown" — it is a
              customer who consented to appear and not to be identified, and the
              two are different permissions. */}
          {item.creditName ? item.creditName : "A customer"}
          {" · "}
          <Link
            href={productHref}
            className="underline decoration-ink/20 underline-offset-4 transition-colors hover:text-terracotta hover:decoration-terracotta"
          >
            {item.productName}
          </Link>
        </p>

        {item.link && (
          <a
            href={item.link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wider text-ink/55 transition-colors hover:text-terracotta"
          >
            <Play className="h-3 w-3" />
            {watchLabel(item.link.platform)}
          </a>
        )}
      </figcaption>
    </figure>
  );
}

/**
 * A link, dressed as something worth clicking.
 *
 * The aspect ratio is held by the wrapper so a video card occupies a sensible
 * column height rather than collapsing to the height of its own text.
 */
function VideoCard({ item, ratio }: { item: StyleItem; ratio: number }) {
  const thumbnail = item.link?.thumbnailUrl;

  return (
    <a
      href={item.link?.url ?? "#"}
      target="_blank"
      rel="noopener noreferrer"
      className="block"
      style={{ aspectRatio: String(ratio) }}
    >
      {thumbnail ? (
        <div className="relative h-full w-full">
          {/* YouTube's own still. Unoptimised: it is already a small, correctly
              sized JPEG on a CDN, and routing it through the optimizer would
              spend a transform on something that needs none. */}
          <Image
            src={thumbnail}
            alt={`Video of the ${item.productName}`}
            fill
            unoptimized
            sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
            className="object-cover transition-transform duration-700 ease-out group-hover:scale-[1.02]"
          />
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-cream/90 shadow-sm transition-transform duration-500 group-hover:scale-110">
              <Play className="ml-0.5 h-5 w-5 text-ink" />
            </span>
          </span>
        </div>
      ) : (
        // Instagram. A typographic card rather than a faked still — see the
        // header. It reads as a deliberate piece of the design instead of a
        // broken image.
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-linen/70 p-6 text-center ring-1 ring-inset ring-ink/10">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-cream shadow-sm">
            <Play className="ml-0.5 h-5 w-5 text-ink" />
          </span>
          <span className="font-heading text-lg text-ink">
            {item.creditName ? `${item.creditName}'s reel` : "A customer's reel"}
          </span>
          <span className="text-xs uppercase tracking-wider text-ink/50">
            {watchLabel("instagram")}
          </span>
        </div>
      )}
    </a>
  );
}
