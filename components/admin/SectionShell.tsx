import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { sectionById } from "@/lib/adminSections";

/**
 * The frame every section page renders inside: back link, title, blurb.
 *
 * One component rather than each page writing its own header, so a new section
 * cannot arrive looking subtly different — the same reasoning as the customer
 * account layout. The title and blurb are read from the section registry, so
 * the tile and the page it opens can never disagree about what it is called.
 */
export default function SectionShell({
  id,
  action,
  children,
}: {
  id: string;
  /** Optional control for the header row, e.g. "Add New Product". */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const section = sectionById(id);

  return (
    <div>
      <Link
        href="/admin/dashboard"
        className="inline-flex items-center gap-1 text-xs uppercase tracking-widest text-ink/45 transition-colors hover:text-terracotta"
      >
        <ChevronLeft className="h-3.5 w-3.5" /> Dashboard
      </Link>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl text-ink sm:text-4xl">
            {section?.label ?? "Section"}
          </h1>
          {section?.blurb && (
            <p className="mt-1.5 text-sm text-ink/55">{section.blurb}</p>
          )}
        </div>
        {action}
      </div>

      <div className="mt-8">{children}</div>
    </div>
  );
}
