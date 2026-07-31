/**
 * Marks a row whose changes are staged but not on the site.
 *
 * Deliberately quiet: the admin's job is to show what WILL be live, so an
 * unpublished row is annotated rather than styled as an error.
 */
export default function DraftBadge({ deleting = false }: { deleting?: boolean }) {
  return (
    <span
      className={
        deleting
          ? "rounded-full bg-terracotta/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-terracotta-dark"
          : "rounded-full bg-ink/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ink/60"
      }
    >
      {deleting ? "Deleting on publish" : "Unpublished"}
    </span>
  );
}
