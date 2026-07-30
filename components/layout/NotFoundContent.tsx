import Image from "next/image";
import Link from "next/link";
import { buttonClassName } from "@/components/ui/Button";

/**
 * Shared 404 body. Two boundaries need it: the storefront group's not-found
 * (which most misses reach, via the /[parent] catch-all) and the root
 * not-found (which catches multi-segment paths that match no segment at all).
 */
export default function NotFoundContent() {
  return (
    <div className="container-wovenne section-padding flex min-h-[70vh] flex-col items-center justify-center text-center">
      <Image
        src="/logo_illustrated.png"
        alt="THE WOVENNE"
        width={2275}
        height={2275}
        priority
        sizes="(max-width: 640px) 60vw, 220px"
        className="h-auto w-[min(60vw,220px)]"
      />

      <p className="eyebrow mt-10">Error 404</p>
      <h1 className="mt-3 font-heading text-display-sm text-ink md:text-display-md">
        A Loose Thread
      </h1>
      <p className="mt-6 max-w-prose text-base leading-relaxed text-ink/70">
        This page isn&apos;t part of the weave. It may have moved, or never
        existed at all.
      </p>

      <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
        <Link href="/" className={buttonClassName("primary", "lg")}>
          Return Home
        </Link>
        <Link href="/journal" className={buttonClassName("ghost", "lg")}>
          Read the Journal
        </Link>
      </div>
    </div>
  );
}
