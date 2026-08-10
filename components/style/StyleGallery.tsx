import StyleCard from "./StyleCard";
import type { StyleItem } from "@/lib/style";

/**
 * The staggered layout.
 *
 * CSS COLUMNS, NOT A MASONRY LIBRARY. A JavaScript layout measures every image,
 * absolutely positions each card and re-runs on resize — which means the page is
 * laid out twice, jumps once, and needs a library on a route that currently
 * ships none. CSS columns do the same job in three class names: cards flow down
 * one column and on to the next, each keeps its own height, and nothing is
 * cropped.
 *
 * WHAT COLUMNS COST, said plainly rather than discovered later: the order reads
 * top-to-bottom within a column, not left-to-right across the row. For a wall of
 * photographs with no sequence that is invisible. It would be wrong for anything
 * ranked or chronological where a reader follows the order — this is neither,
 * beyond "newest first", and newest-first still holds down the first column.
 *
 * break-inside-avoid is what stops a card being sliced across a column boundary.
 * Without it a caption can end up in a different column from its photograph.
 */
export default function StyleGallery({ items }: { items: StyleItem[] }) {
  if (items.length === 0) return null;

  return (
    <div className="columns-1 gap-6 sm:columns-2 lg:columns-3">
      {items.map((item) => (
        <StyleCard key={item.id} item={item} />
      ))}
    </div>
  );
}
