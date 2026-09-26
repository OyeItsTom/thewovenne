/**
 * Care advice — what a product page may say about looking after a piece.
 *
 * ── THE RULE (SEO-6A) ──
 *
 * A product page shows the care note somebody wrote for THIS piece (migration
 * 0051), and nothing else. No note, no Material & Care section.
 *
 * There used to be two fallbacks. Every product without a note got a generic
 * list — hand wash, line dry, iron low, and a line calling every piece
 * handmade — because none of the live fabric labels ("Cotton", "Handloom 120
 * count mul cotton", "Tissue Cotton") is a key in the table below. That put
 * ironing instructions on a gold-plated copper necklace and a craft claim on
 * pieces nobody had verified. It was never checked for any product, and it is
 * gone rather than reworded.
 *
 * The second fallback was this table, by fabric label. It is NOT consulted.
 * A label says what a piece is called, not how it tolerates water or heat:
 * zari, tissue and mul cotton do not all take the same wash, and several lines
 * below are claims (natural dye, pre-shrunk, softening) nobody has verified for
 * any product. Care advice from a label is a decision for the owner, piece by
 * piece, and it belongs in the written note.
 */

/**
 * DORMANT. Kept as reference text only; careFor() does not read it and nothing
 * else imports it. scripts/product-care.test.ts fails if an exact label match
 * ever starts producing care again, so re-activating it has to be deliberate.
 */
export const CARE_BY_FABRIC: Record<string, string[]> = {
  "Pure Linen": [
    "Machine wash cold on a gentle cycle, or hand wash",
    "Line dry in shade — avoid direct, prolonged sun",
    "Iron on a warm setting while slightly damp for a crisp finish",
    "Softens beautifully with every wash",
  ],
  "Raw Linen": [
    "Hand wash or gentle machine cycle in cold water",
    "Dry flat or line dry away from direct sun",
    "Press with a warm iron for a structured look, or leave unironed for a relaxed drape",
    "Natural slubs and creasing are part of the character",
  ],
  Linen: [
    "Machine wash cold on a gentle cycle",
    "Line dry in shade",
    "Warm iron while slightly damp",
    "Softens with every wear and wash",
  ],
  "Linen-Cotton": [
    "Machine wash cold, gentle cycle",
    "Tumble dry low or line dry",
    "Warm iron as needed",
    "Pre-shrunk for a consistent fit over time",
  ],
  "Handloom Cotton": [
    "Hand wash separately for the first few washes",
    "Line dry in shade to preserve colour",
    "Warm iron on the reverse side",
    "Natural dye may fade gently with age — this is part of its charm",
  ],
};

/** The care a product page shows — a written note — or null. */
export type CareGuidance = { source: "written"; text: string };

/**
 * The written note, trimmed, or null when there is none. Whitespace is not a
 * note. The same rule for every kind of product: jewellery, garments and
 * anything filed nowhere are all told only what was written for them.
 */
export function careFor({ careNote }: { careNote: string | null }): CareGuidance | null {
  const written = careNote?.trim();
  return written ? { source: "written", text: written } : null;
}
