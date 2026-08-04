import Link from "next/link";
import { ADMIN_SECTIONS } from "@/lib/adminSections";

/**
 * The dashboard's tiles.
 *
 * Rendered straight from the section registry, so a new section appears here
 * the moment it is declared — no list to keep in step.
 *
 * Restrained on purpose: linen card, hairline border, terracotta only on the
 * icon and only on hover. A grid of coloured blocks is what every admin
 * template looks like, and this one sits behind a shop whose whole argument is
 * restraint.
 */
export default function SectionGrid() {
  return (
    <nav aria-label="Admin sections">
      <ul className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
        {ADMIN_SECTIONS.map((section) => {
          const Icon = section.icon;
          return (
            <li key={section.id}>
              <Link
                href={section.href}
                className="group flex h-full flex-col rounded-2xl border border-ink/10 bg-cream p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-terracotta/40 hover:shadow-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracotta sm:p-6"
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-linen/70 text-ink/70 transition-colors group-hover:bg-terracotta/10 group-hover:text-terracotta">
                  <Icon className="h-5 w-5" strokeWidth={1.5} />
                </span>

                <span className="mt-4 block font-heading text-lg leading-snug text-ink">
                  {section.label}
                </span>
                {/* Hidden on the smallest screens: two columns of tiles with
                    three lines of explanation each is a wall of text on a
                    phone, and the label already says what it is. */}
                <span className="mt-1 hidden text-xs leading-relaxed text-ink/50 sm:block">
                  {section.blurb}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
