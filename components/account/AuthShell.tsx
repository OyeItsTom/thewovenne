import Link from "next/link";
import Image from "next/image";

/**
 * The frame every account screen sits in.
 *
 * One component rather than five layouts, so signup and reset cannot drift
 * apart visually — which is exactly where a site starts feeling assembled
 * rather than designed. Narrow measure, generous space, the emblem doing the
 * branding instead of a coloured header.
 */
export default function AuthShell({
  eyebrow,
  title,
  intro,
  children,
  footer,
}: {
  eyebrow?: string;
  title: string;
  intro?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="container-wovenne section-padding">
      <div className="mx-auto w-full max-w-md">
        <div className="text-center">
          <Link href="/in" aria-label="THE WOVENNE — home" className="inline-block">
            <Image
              src="/logo_emblem_transparent.png"
              alt=""
              width={3096}
              height={2792}
              sizes="56px"
              className="mx-auto h-12 w-auto"
            />
          </Link>
          {eyebrow && <p className="eyebrow mt-8">{eyebrow}</p>}
          <h1 className="mt-3 font-heading text-display-sm text-ink">{title}</h1>
          {intro && (
            <p className="mx-auto mt-4 max-w-sm text-sm leading-relaxed text-ink/60">
              {intro}
            </p>
          )}
        </div>

        <div className="mt-10">{children}</div>

        {footer && (
          <div className="mt-8 border-t border-ink/10 pt-6 text-center text-sm text-ink/60">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
