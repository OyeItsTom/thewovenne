import type { BrandKnowledge } from "@/lib/products";

/**
 * Heritage and craft, as written by hand in the admin (migration 0051).
 *
 * A SERVER COMPONENT WITH NO INTERACTION. It is prose about the cloth — there is
 * nothing to expand, filter or toggle, so it ships no JavaScript. The care note
 * is deliberately NOT here: it belongs beside the fabric in CareAccordion, where
 * a buyer already looks for it, and showing care advice twice on one page invites
 * the two to disagree.
 *
 * Renders nothing at all when neither note has been written. An empty "Heritage"
 * heading on a young catalogue reads as a shop that forgot, and a placeholder
 * paragraph about tradition nobody wrote would be worse than silence — this is
 * the provenance claim the whole label rests on.
 */
export default function BrandKnowledgePanel({
  knowledge,
  productName,
}: {
  knowledge: BrandKnowledge | null;
  productName: string;
}) {
  const heritage = knowledge?.heritage?.trim();
  const craft = knowledge?.craft?.trim();
  if (!heritage && !craft) return null;

  return (
    <section className="mt-24 border-t border-ink/10 pt-16" aria-labelledby="heritage">
      <div className="text-center">
        <span className="font-script text-2xl text-terracotta">Woven in India</span>
        <h2 id="heritage" className="mt-2 font-heading text-3xl text-ink sm:text-4xl">
          The story of this piece
        </h2>
      </div>

      <div className="mx-auto mt-10 grid max-w-4xl gap-10 sm:grid-cols-2">
        {heritage && (
          <div>
            <h3 className="text-xs uppercase tracking-wider text-ink/50">
              Heritage
            </h3>
            {/* whitespace-pre-line, not a markdown renderer: what was typed is
                what shows, including paragraph breaks. A renderer here would
                turn a stray asterisk in someone's prose into markup. */}
            <p className="mt-3 whitespace-pre-line text-base leading-relaxed text-ink/70">
              {heritage}
            </p>
          </div>
        )}
        {craft && (
          <div>
            <h3 className="text-xs uppercase tracking-wider text-ink/50">
              Craft
            </h3>
            <p className="mt-3 whitespace-pre-line text-base leading-relaxed text-ink/70">
              {craft}
            </p>
          </div>
        )}
      </div>

      <p className="mt-10 text-center text-xs text-ink/45">
        Written by us about {productName} — not generated, and not a stock
        description.
      </p>
    </section>
  );
}
