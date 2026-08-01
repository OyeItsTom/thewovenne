import Image from "next/image";
import type { PageBlock } from "@/lib/pages";

/**
 * Renders a page's blocks.
 *
 * Blocks rather than stored HTML: the renderer owns typography and spacing, so
 * an edit from the admin cannot break the page's look, and pasted markup
 * cannot inject anything. Adding a block type is a change here, not a schema
 * change.
 */
export default function PageBlocks({ blocks }: { blocks: PageBlock[] }) {
  return (
    <div className="mx-auto max-w-prose">
      {blocks.map((block, i) => {
        switch (block.type) {
          case "heading":
            return (
              <h2 key={i} className="mt-12 font-heading text-2xl text-ink first:mt-0 sm:text-3xl">
                {block.text}
              </h2>
            );
          case "paragraph":
            return (
              <p key={i} className="mt-5 text-base leading-relaxed text-ink/75">
                {block.text}
              </p>
            );
          case "image":
            return (
              <figure key={i} className="mt-10">
                <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl bg-linen">
                  <Image
                    src={block.url}
                    alt={block.alt ?? ""}
                    fill
                    sizes="(min-width: 768px) 680px, 100vw"
                    className="object-cover"
                  />
                </div>
                {block.alt && (
                  <figcaption className="mt-2 text-xs text-ink/50">{block.alt}</figcaption>
                )}
              </figure>
            );
          case "faq":
            return (
              <div key={i} className="mt-8 border-t border-ink/10 pt-6 first:border-0">
                <h3 className="font-heading text-xl text-ink">{block.question}</h3>
                <p className="mt-2 text-base leading-relaxed text-ink/75">{block.answer}</p>
              </div>
            );
          default:
            // Unknown block type — skip rather than crash the page.
            return null;
        }
      })}
    </div>
  );
}
