/**
 * Care advice by fabric.
 *
 * MOVED OUT OF THE COMPONENT so it is data rather than markup. It was declared
 * inside CareAccordion, which meant a "use client" module was the only place
 * that knew how to wash linen — nothing on the server, and nothing in a test,
 * could read it. Ask Wovenne answers care questions from the written note; this
 * table is the fallback the page shows, and both should be able to reach it.
 *
 * The written per-product note (migration 0051) always wins over anything here.
 * See MaterialCare.
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

export const DEFAULT_CARE = [
  "Hand wash or gentle machine cycle in cold water",
  "Line dry in shade, away from direct sunlight",
  "Iron on a low to medium setting",
  "Handcrafted — slight variations are natural, not flaws",
];
