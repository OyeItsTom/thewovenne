/**
 * Does a piece of suggested copy say something the product data does not?
 *
 * ══ WHY THIS EXISTS WHEN THE PROMPT ALREADY FORBIDS IT ══
 *
 * The AI Product Assistant is told, plainly, not to invent facts. A prompt is
 * a request, not a guarantee: a model that has read a thousand saree listings
 * "knows" sarees are handwoven in Kerala, and will say so about one that is
 * neither. This module is the check that does not depend on the model having
 * listened. It runs on the server before a suggestion is returned, and again in
 * the browser whenever the admin edits a suggestion — the same function, so
 * the two cannot disagree.
 *
 * ══ WHAT IT CAN AND CANNOT DO ══
 *
 * It is a lexicon, not an understanding. It catches the claims that matter most
 * for a shop like this — craft, sustainability, purity, origin, material,
 * technique, care, measurements, the blouse piece, colour — when they appear as
 * words the supplied data does not contain. It cannot catch a fabricated fact
 * phrased in words it has never seen, and it will sometimes flag an innocent
 * phrase ("pure joy"). Both are accepted trade-offs: a flag costs the admin one
 * edit, while a missed claim is the admin's to catch on review — which is why
 * nothing the assistant writes ever reaches the form without being read.
 *
 * ══ "SUPPORTED" MEANS THE ADMIN SAID IT ══
 *
 * A term is supported when it appears in the text the admin entered: the
 * product facts, the current name, description and SEO copy, and the heritage,
 * craft and care notes. If the admin's own description says "handwoven", a
 * suggestion may too. If nothing they wrote says it, it is a claim the model
 * made up, whatever the photo looks like.
 *
 * Pure: no imports with side effects, safe in a client component.
 */

export type ClaimKind =
  | "craft"
  | "sustainability"
  | "quality"
  | "origin"
  | "material"
  | "technique"
  | "care"
  | "measurement"
  | "blouse"
  | "colour"
  | "link";

export interface ClaimIssue {
  kind: ClaimKind;
  /** The words as they appear in the suggestion. */
  term: string;
  /** One sentence the admin can act on. */
  reason: string;
}

export interface ClaimContext {
  /**
   * Everything the admin entered that a suggestion may draw on, joined. Facts,
   * current copy and notes — never anything the model wrote.
   */
  allowedText: string;
  /** The blouse-piece fact: "included", "not_included", or "" when unknown. */
  blousePiece: string;
  /**
   * True when checking alt text the model wrote while looking at the photo.
   * Colours and visible decoration (embroidery, print, a border) can then come
   * from the picture itself. Material, origin, craft and the rest still cannot:
   * a photo shows a sheen, not whether it is silk.
   */
  fromImage: boolean;
}

/** Lower-case, accents off, hyphens and punctuation to spaces, single-spaced. */
export function normaliseClaimText(s: string): string {
  return ` ${s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[‐-―-]/g, " ")
    .replace(/[^a-z0-9%.\s]/g, " ")
    .replace(/\.(?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

const compact = (s: string) => s.replace(/\s+/g, "");

interface Rule {
  kind: ClaimKind;
  /** Matched against normalised text, so: lower case, single spaces, no hyphens. */
  pattern: RegExp;
  /**
   * Words that count as the admin having said it. A match is supported when the
   * allowed text contains the match itself, or any of these.
   */
  family?: string[];
  /** Visible in a photo, so allowed in alt text written from that photo. */
  visual?: boolean;
  reason: string;
}

const w = (alternatives: string) => new RegExp(`(?<=\\s)(?:${alternatives})(?=\\s)`, "g");

const HANDWOVEN = ["handwoven", "handloom", "handloomed", "handwoven"];
const MAKERS = ["artisan", "artisans", "artisanal", "craftsman", "craftsmen", "craftsmanship", "craftspeople", "craftswomen", "karigar", "karigars"];
const WEAVERS = ["weaver", "weavers"];

const RULES: Rule[] = [
  // ── Craft ──
  {
    kind: "craft",
    pattern: w(
      "hand ?(?:woven|loomed?|made|crafted|spun|painted|embroidered|block(?:ed)?(?: printed)?|printed|stitched|knotted|beaded|finished|dyed)|handloom|handmade|handcrafted"
    ),
    family: HANDWOVEN,
    reason: "Says how it was made, and nothing you entered says so.",
  },
  {
    kind: "craft",
    pattern: w("artisans?|artisanal|crafts(?:man|men|manship|people|women)|karigars?|master craftsm[ae]n"),
    family: MAKERS,
    reason: "Says who made it, and nothing you entered says so.",
  },
  {
    kind: "craft",
    pattern: w("(?:master )?weavers?"),
    family: WEAVERS,
    reason: "Says who made it, and nothing you entered says so.",
  },
  {
    kind: "craft",
    pattern: w(
      "traditional(?:ly)?|tradition|heritage|heirloom|authentic|genuine|age old|centuries old|time honou?red|timeless craft"
    ),
    reason: "A heritage or authenticity claim that isn't in what you entered.",
  },

  // ── Sustainability and ethics ──
  {
    kind: "sustainability",
    pattern: w(
      "sustainab\\w*|eco ?friendly|eco ?conscious|eco|organic|ethical(?:ly)?|ethically sourced|fair ?trade|natural dyes?|naturally dyed|plant dyed|vegetable dyed|azo free|biodegradable|vegan|zero waste|slow fashion|responsibly \\w+|conscious(?:ly)?"
    ),
    reason: "A sustainability or ethics claim that isn't in what you entered.",
  },

  // ── Quality and purity ──
  {
    kind: "quality",
    pattern: w("luxury|luxurious|luxe|premium|exquisite|finest|couture|opulent"),
    reason: "A luxury claim that isn't in what you entered.",
  },
  {
    kind: "quality",
    pattern: w("pure|purest|100 ?%|\\d+(?:\\.\\d+)? ?%|percent"),
    reason: "A purity or composition claim that isn't in what you entered.",
  },
  {
    kind: "quality",
    pattern: w("certified|certification|gi tag(?:ged)?|silk mark|hallmark(?:ed)?|bis hallmark"),
    reason: "A certification claim that isn't in what you entered.",
  },

  // ── Where it is from ──
  {
    kind: "origin",
    pattern: w(
      "made in \\w+|kerala|keralan|kasaragod|balaramapuram|chendamangalam|kuthampully|banaras|banarasi|benaras|benarasi|varanasi|kanchipuram|kanjivaram|kanjeevaram|chanderi|maheshwar(?:i)?|pochampally|jaipur(?:i)?|rajasthan(?:i)?|bengal(?:i)?|gujarat(?:i)?|assam(?:ese)?|odisha|orissa|sambalpur(?:i)?|tamil nadu|karnataka|mysore|bhagalpur(?:i)?|murshidabad|lucknow(?:i)?|kashmir(?:i)?|kutch|bagru|sanganer(?:i)?|india|indian"
    ),
    reason: "Says where it comes from, and the origin isn't in what you entered.",
  },

  // ── What it is made of ──
  {
    kind: "material",
    pattern: w(
      "silks?|cotton|linen|wool(?:len)?|pashmina|cashmere|chiffon|georgette|organza|tissue|crepe|satin|velvet|rayon|viscose|polyester|khadi|muslin|mul|tussar|tussah|mulberry|modal|lycra|spandex|denim|jute|bamboo|sterling|brass|copper|kundan|polki|pearls?|diamonds?|rub(?:y|ies)|emeralds?|gemstones?|zircon|cz|american diamond|oxidi[sz]ed|gold plated|silver plated|\\d{2} ?k|karat|carat"
    ),
    reason: "Names a material that isn't in what you entered.",
  },
  {
    kind: "material",
    // Gold and silver: a material on jewellery, a colour on a saree border. When
    // seen in a photo they count as colour.
    pattern: w("gold|golden|silver|silvery"),
    visual: true,
    reason: "Names a material or colour that isn't in what you entered.",
  },

  // ── How it is decorated ──
  {
    kind: "technique",
    pattern: w(
      "zari|kasavu|jacquard|ikk?at|jamdani|brocade|kalamkari|bandhani|bandhej|leheriya|shibori|chikankari|kantha|phulkari|gota(?: patti)?|resham"
    ),
    reason: "Names a weave or technique that isn't in what you entered.",
  },
  {
    kind: "technique",
    pattern: w(
      "embroider(?:y|ed|ies)|sequin(?:s|ned|ed)?|mirror work|tie ?dye(?:d)?|block print(?:ed)?|printed|print|applique|beaded|beadwork|stone work|stonework"
    ),
    visual: true,
    reason: "Names decoration that isn't in what you entered.",
  },

  // ── Care ──
  {
    kind: "care",
    pattern: w("machine wash(?:able)?|hand wash(?:able)?|dry clean(?:ing)?(?: only)?|washable|wash(?:ed)? separately|cold wash|iron(?:ing)?|steam(?:ing)?"),
    reason: "Gives care advice that isn't in your care instructions.",
  },

  // ── Measurements ──
  {
    kind: "measurement",
    pattern: w(
      "\\d+(?:\\.\\d+)? ?(?:m|metres?|meters?|cm|mm|inch(?:es)?|in|yards?|yds?|ft|feet|grams?|g|kg|gms?)"
    ),
    reason: "Gives a measurement that isn't in your dimensions.",
  },

  // ── Colour ──
  {
    kind: "colour",
    pattern: w(
      "red|maroon|crimson|scarlet|pink|rose|magenta|fuchsia|peach|coral|orange|rust|saffron|mustard|yellow|cream|ivory|off white|white|beige|sand|tan|brown|chocolate|coffee|green|olive|mint|teal|turquoise|blue|navy|indigo|purple|violet|lavender|lilac|mauve|plum|wine|black|grey|gray|charcoal|multicolou?r(?:ed)?"
    ),
    visual: true,
    reason: "Names a colour that isn't in what you entered.",
  },

];

/** Web addresses, matched on the raw text — normalising would take the dots out. */
const LINK = /(?:https?:\/\/\S+|www\.\S+|\b[a-z0-9-]+\.(?:com|in|co|net|org|shop|store)\b\S*)/gi;

function singular(word: string): string {
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

/**
 * The admin's words as a lookup: every word, and every run of two or three
 * words both spaced and joined, so "hand woven" supports "handwoven" and back.
 * Whole words only — "red" must not be found inside "embroidered".
 */
function vocabulary(allowed: string): { grams: Set<string>; tokens: string[] } {
  const tokens = allowed.trim().split(" ").filter(Boolean);
  const grams = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    for (let n = 1; n <= 3 && i + n <= tokens.length; n++) {
      const run = tokens.slice(i, i + n);
      grams.add(run.join(" "));
      grams.add(run.join(""));
    }
  }
  return { grams, tokens };
}

function isSupported(match: string, rule: Rule, vocab: ReturnType<typeof vocabulary>): boolean {
  const m = match.trim();
  if (vocab.grams.has(m) || vocab.grams.has(compact(m))) return true;
  // "pearls" is supported by "pearl", "Indian" by "India", "golden" by "gold".
  if (!m.includes(" ")) {
    const stem = singular(m).replace(/(?:an|i|ese)$/, "");
    if (stem.length >= 4 && vocab.tokens.some((t) => t.startsWith(stem))) return true;
    // Only a short ending: "hand" (from "hand wash") must not support "handwoven".
    if (vocab.tokens.some((t) => t.length >= 4 && m.startsWith(t) && m.length - t.length <= 2)) return true;
  }
  return Boolean(rule.family?.some((f) => vocab.grams.has(f)));
}

/**
 * Every claim in `text` that the context does not support, each term once.
 */
export function findUnsupportedClaims(text: string, ctx: ClaimContext): ClaimIssue[] {
  const subject = normaliseClaimText(text);
  const allowed = normaliseClaimText(ctx.allowedText);
  const vocab = vocabulary(allowed);
  const issues: ClaimIssue[] = [];
  const seen = new Set<string>();

  for (const rule of RULES) {
    if (ctx.fromImage && rule.visual) continue;
    for (const m of Array.from(subject.matchAll(rule.pattern))) {
      const term = m[0].trim();
      const key = compact(term);
      if (seen.has(key)) continue;
      if (isSupported(term, rule, vocab)) continue;
      seen.add(key);
      issues.push({ kind: rule.kind, term, reason: rule.reason });
    }
  }

  for (const m of Array.from(text.matchAll(LINK))) {
    const term = m[0].replace(/[.,;:!?)]+$/, "");
    if (seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    issues.push({ kind: "link", term, reason: "Contains a web address." });
  }

  // ── The blouse piece: unknown, or contradicted ──
  if (/\sblouse\s/.test(subject)) {
    const piece = ctx.blousePiece;
    const saysIncluded =
      /\s(?:with|comes with|includes?|including|and) (?:a |an |its |the )?(?:matching |contrast(?:ing)? |running |unstitched )?blouse|\sblouse (?:piece )?(?:is )?included/.test(
        subject
      );
    const saysExcluded = /\s(?:without|no) (?:a |the )?blouse|\sblouse (?:piece )?(?:is )?not included/.test(subject);
    if (!piece && !/\sblouse\s/.test(allowed)) {
      issues.push({
        kind: "blouse",
        term: "blouse",
        reason: "Mentions a blouse piece, but whether one is included isn't recorded.",
      });
    } else if (piece === "not_included" && saysIncluded) {
      issues.push({
        kind: "blouse",
        term: "blouse",
        reason: "Says a blouse piece is included; the product says it isn't.",
      });
    } else if (piece === "included" && saysExcluded) {
      issues.push({
        kind: "blouse",
        term: "blouse",
        reason: "Says there is no blouse piece; the product says one is included.",
      });
    }
  }

  return issues;
}
