/**
 * Product content check — the rules behind the "Product content check" panel
 * in the Add Product form.
 *
 * ── WHY THIS EXISTS ──
 *
 * Every name in the first catalogue was typed in a hurry — "Magenta w green
 * lines border", "Red Heart Emb", "Zari tie & dye - Pin" — and each one became a
 * page title, a breadcrumb, an image alt, a JSON-LD name and a meta
 * description the moment it was published. Cleaning them up afterwards took
 * three supervised batches. This catches the same mistakes while the product is
 * still a form, which is the only point where fixing them is free.
 *
 * ── WHAT IT MAY SAY ──
 *
 * Every finding carries the evidence it rests on:
 *
 *   VERIFIED   what the admin typed into a field, quoted back.
 *   DERIVED    a mechanical rewrite of what was typed whose meaning cannot
 *              change: "w" → "with", "Emb" → "Embroidered", capitalisation,
 *              spacing, the sub-category's own noun appended.
 *   UNCERTAIN  looks wrong, but the intended meaning is not knowable from the
 *              form. "Pin" may be "Pink" — or a pin. These are SAID, never
 *              applied: no suggestion ever contains an UNCERTAIN change.
 *   MISSING    nothing in the form supports it.
 *
 * Only VERIFIED and DERIVED text ever reaches a suggestion. Nothing here knows
 * a fabric, an origin, a weave, a zari grade, a plating or a size that was not
 * typed into the form — see lib/metadata, which holds the storefront to the
 * same rule from the other side.
 *
 * ── WHAT IT MAY DO ──
 *
 * Nothing. This module is pure: it reads a snapshot of the form and returns
 * findings. It has no database handle and writes nothing. A suggestion reaches
 * the form only when the admin presses "Use suggestion", and even then it
 * changes one field of an unsaved form — Save and Review & Publish are exactly
 * as authoritative as they were before.
 *
 * ── COLOUR AND FABRIC, AS THE SHOP ACTUALLY USES THEM ──
 *
 * Both are free text, and both are matched EXACTLY (case- and space-
 * insensitively, lib/products sameCatalogueValue) wherever they are used:
 *
 *   Fabric  → filter chips, search, Ask Wovenne, the fallback meta description
 *             and JSON-LD `material`, verbatim (lib/structuredData).
 *   Colour  → filter chips, search, "curated for you" and Ask Wovenne. Never
 *             JSON-LD or meta: lib/metadata excludes it because it reads as a
 *             marketing word as often as a fact.
 *
 * So the checks that matter are: is it filled in, does it contradict the name,
 * and is it a new spelling of a value the shop already uses (which would split
 * one filter chip into two).
 *
 * COLOUR IS THE MAIN BODY COLOUR (Tom's decision, 3 Oct 2026). Never the
 * border: an off-white saree with a green border is Colour "Off-white"; a
 * mostly pink-and-white tie-dye is "Pink". Border colours belong in the name
 * and description. The check reads colours in the name accordingly — a colour
 * just before "border", "lines", "check"… describes a detail — and still only
 * WARNS: whether a name's colour is the body is read from wording, not seen.
 *
 * ── AI ──
 *
 * There is none in this version, on purpose. Every rule below is deterministic.
 * `ContentSuggester` at the bottom is the seam a model-backed suggester would
 * plug into later (server-side, admin + MFA gated, as /api/admin/insights is);
 * its output must go through the same evidence labels and the same accept/
 * ignore controls.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types

export type ContentField = "name" | "description" | "fabric" | "colour" | "sizes";
export type Evidence = "VERIFIED" | "DERIVED" | "UNCERTAIN" | "MISSING";
export type Level = "ok" | "warn" | "problem";

export interface Suggestion {
  /** Always the field the finding is about. */
  field: Exclude<ContentField, "sizes">;
  value: string;
}

export interface Finding {
  /** Stable for a given field + issue + current value, so "Ignore" survives re-renders but not edits. */
  id: string;
  field: ContentField;
  level: Exclude<Level, "ok">;
  evidence: Evidence;
  message: string;
  /** Why — shown under the message. */
  reasons?: string[];
  suggestion?: Suggestion;
}

export interface ContentInput {
  name: string;
  description: string;
  fabric: string;
  colour: string;
  /** The chosen sub-category's name ("Sarees", "Rings"), or null before one is picked. */
  categoryName: string | null;
  /** Its parent's name ("Women", "Jewellery"). */
  parentCategoryName: string | null;
  /** Size labels as entered in the form. Empty for one-size products. */
  sizes: string[];
  /** Every OTHER product (published or draft) — never the one being edited. */
  otherProducts: { name: string; fabric: string | null; colour: string | null }[];
  /** Brand-knowledge notes, read only to tell whether a claim has backing. */
  notes?: string;
}

export interface ContentCheck {
  status: Level;
  findings: Finding[];
  /** Plain "needs confirmation" lines: facts the form does not hold. */
  missing: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary

const SMALL_WORDS = new Set(["with", "and", "or", "of", "the", "a", "an", "in", "on", "for", "to", "by", "at"]);

/** Colour words, for spelling checks, the "A - colours" reorder and colour/name comparison. */
const COLOURS = [
  "red", "maroon", "crimson", "pink", "magenta", "rani", "peach", "coral", "orange", "rust",
  "mustard", "yellow", "gold", "golden", "cream", "ivory", "beige", "white", "off-white", "black",
  "grey", "gray", "silver", "charcoal", "brown", "tan", "green", "lime", "parrot", "olive",
  "mint", "teal", "turquoise", "blue", "navy", "indigo", "sky", "violet", "purple", "lavender",
  "lilac", "mauve", "wine", "copper", "bronze", "multicolour", "multicolor",
];
const COLOUR_SET = new Set(COLOURS);

/** Words that name a cloth. A name that says one while Fabric says another is a conflict. */
const FABRIC_WORDS = [
  "cotton", "tissue", "silk", "linen", "mul", "khadi", "chanderi", "organza", "georgette",
  "chiffon", "kota", "tussar", "tussah", "crepe", "rayon", "polyester", "satin", "velvet",
  "wool", "modal", "viscose", "jute",
];
const FABRIC_SET = new Set(FABRIC_WORDS);

/** Words that state how a piece was made — a claim, not a description. */
const CONSTRUCTION_CLAIMS = ["handloom", "handwoven", "hand-woven", "handmade", "hand-made"];

/** Words the cleanup is allowed to know are spelt right. */
const VOCAB = new Set<string>([
  ...COLOURS, ...FABRIC_WORDS, ...CONSTRUCTION_CLAIMS,
  "saree", "sari", "mundu", "set", "dhoti", "veshti", "kasavu", "zari", "border", "borders",
  "line", "lines", "check", "checks", "checked", "stripe", "stripes", "striped", "temple",
  "embroidered", "embroidery", "tie-dye", "dye", "tie", "print", "printed", "block", "plain",
  "thin", "thick", "double", "single", "mini", "micro", "big", "small", "wide", "narrow",
  "heart", "elephant", "peacock", "floral", "flower", "leaf", "paisley", "mango", "lotus",
  "butta", "buta", "motif", "motifs", "pallu", "tassel", "tassels", "woven", "weave",
  "ring", "rings", "couple", "necklace", "choker", "earring", "earrings", "jhumka", "chain",
  "bangle", "bracelet", "pendant", "stud", "studs", "tennis", "plated", "detachable",
  "adjustable", "open", "stone", "stones", "zirconia", "shirt", "kurta", "kurti", "dress",
  "blouse", "jacket", "nehru", "trouser", "trousers", "two-line", "pure", "tested",
  "with", "and", "or", "of", "the", "in", "on", "for", "to", "by", "at",
  "light", "dark", "pale", "bright", "deep", "dual", "tone", "two", "three", "multi",
]);

/** Common English words that are fine as typed — not candidates for a spelling hint. */
const COMMON = new Set<string>([
  "pin", "fine", "rich", "new", "old", "day", "one", "all", "art", "bird", "dot", "dots", "star",
  "moon", "sun", "tree", "wave", "waves", "grid", "box", "edge", "half", "full", "long", "short",
  "classic", "fancy", "design", "work", "style", "look", "band", "piece", "pieces", "pair",
]);

/**
 * Abbreviations whose expansion cannot change the meaning. Anything less sure
 * than these ("pin", "blk", "grn") is reported, not expanded.
 */
const ABBREVIATIONS: Record<string, string> = {
  w: "with",
  "w/": "with",
  wth: "with",
  emb: "embroidered",
  "emb.": "embroidered",
  embd: "embroidered",
  embr: "embroidered",
  "&": "and",
  n: "and",
};

/** Adjectives that sell rather than describe. Reported; never removed (some, like "fancy saree", are trade terms). */
const MARKETING_WORDS = [
  "exquisite", "stunning", "gorgeous", "luxurious", "luxury", "premium", "elegant", "beautiful",
  "timeless", "fancy", "designer", "trendy", "perfect", "unique", "amazing", "royal", "graceful",
  "intricate", "exclusive", "best", "lovely", "classy", "glamorous", "breathtaking",
];

/** Adjectives that, in a description, sell rather than inform. */
const DESCRIPTION_MARKETING_WORDS = [
  "exquisite", "stunning", "gorgeous", "luxurious", "luxury", "premium", "elegant", "elegance",
  "graceful", "breathtaking", "glamorous", "beautifully", "vibrant", "striking", "lustrous",
];

/** Phrases in a description that are copywriting rather than information. */
const MARKETING_PHRASES = [
  "elevate", "masterpiece", "must-have", "must have", "every occasion", "any occasion",
  "perfect for", "ideal for", "turn heads", "head-turner", "timeless", "effortless",
  "statement piece", "wardrobe staple", "look no further", "exude",
];

/** Claims a description can make that the form usually cannot back. */
const CLAIM_PATTERNS: { re: RegExp; label: string; jewelleryFact?: true }[] = [
  { re: /\bhand[\s-]?(?:loom|woven|made)\b/i, label: "how it was made (handloom / handwoven / handmade)" },
  { re: /\b(?:pure|real|tested|original)\s+zari\b/i, label: "the zari grade" },
  { re: /\bsilk\s*mark\b|\bgi[\s-]tag/i, label: "a certification" },
  { re: /\b(?:kerala|bengal|banaras|benaras|varanasi|kanchipuram|kanjivaram|chennai|kolkata|balaramapuram|chendamangalam|kuthampully)\b/i, label: "where it was made" },
  { re: /\bartisan|weaver|weavers\b/i, label: "who made it" },
  { re: /\bblouse(?:\s+piece)?\b/i, label: "a blouse piece" },
  { re: /\b\d+(?:\.\d+)?\s*(?:m|mtr|mtrs|metres?|meters?|cm|inch(?:es)?|yards?)\b/i, label: "a measurement" },
  { re: /\b(?:wedding|bridal|festive|festival|onam|vishu|diwali|party|occasion)\b/i, label: "an occasion" },
  { re: /\b(?:925|sterling|solid gold|real gold|\d+k\s*gold|gold[\s-]plated|silver[\s-]plated|copper|brass|cubic zirconia|diamond|ruby|emerald|pearl)\b/i, label: "the metal, plating or stone", jewelleryFact: true },
];

/** Labels that mean "one size fits", so they do not contradict "Adjustable". */
const FREE_SIZE_LABELS = /^(?:free(?:\s*size)?|one\s*size|adjustable|os)$/i;

/** Pattern words: a colour sitting just before one of these describes a detail, not the body. */
const DETAIL_WORDS = new Set([
  "border", "borders", "line", "lines", "check", "checks", "stripe", "stripes", "zari",
  "tassel", "tassels", "heart", "hearts", "embroidered", "embroidery", "motif", "motifs",
  "pallu", "temple", "elephant", "floral", "flower", "flowers", "butta", "buta", "print",
]);

const NAME_MAX = 60;
const DESCRIPTION_MIN = 40;
const DESCRIPTION_MAX = 600;

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers

/** Lowercase, punctuation to spaces, single spaces. For comparing names, never for showing them. */
export function normaliseForCompare(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Lowercase with every non-letter removed: "Off White" ≡ "off-white". */
function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function words(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
}

function quote(s: string): string {
  return `“${s}”`;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[a.length][b.length];
}

/** "Sarees" → "saree", "Dhoti" → "dhoti", "Nehru Jackets" → "nehru jacket". */
export function productTypeFor(categoryName: string | null): string | null {
  const c = categoryName?.trim().toLowerCase();
  if (!c) return null;
  return c
    .split(/\s+/)
    .map((w, i, all) => (i === all.length - 1 && /[^s]s$/.test(w) ? w.slice(0, -1) : w))
    .join(" ");
}

/** Other words that already say what the product is, per type. */
const TYPE_SYNONYMS: Record<string, string[]> = {
  saree: ["saree", "sari", "mundu"],
  dhoti: ["dhoti", "mundu", "veshti"],
  necklace: ["necklace", "choker"],
  earring: ["earring", "jhumka", "stud"],
  trouser: ["trouser", "pant"],
};

function namesProductType(name: string, type: string): boolean {
  const last = type.split(" ").pop()!;
  const accepted = TYPE_SYNONYMS[last] ?? [last];
  return words(name).some((w) => accepted.some((t) => w === t || w === `${t}s` || w === `${t}es`));
}

/** One word in the house style: "green" → "Green", "off-white" → "Off-White", "14K" stays. */
function titleWord(w: string, first: boolean): string {
  if (/\d/.test(w) || (w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w))) return w;
  const lower = w.toLowerCase();
  if (!first && SMALL_WORDS.has(lower)) return lower;
  return lower
    .split("-")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join("-");
}

export function titleCase(s: string): string {
  return s
    .split(" ")
    .filter(Boolean)
    .map((w, i) => titleWord(w, i === 0))
    .join(" ");
}

/** "pink", "magenta" → "Pink and Magenta"; three or more get commas. */
function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Name

interface NameCleanup {
  value: string;
  reasons: string[];
}

/**
 * The DERIVED cleanup of a name: only rewrites whose meaning cannot change.
 * Returns the input untouched (and no reasons) when there is nothing to do.
 */
export function cleanName(raw: string, categoryName: string | null): NameCleanup {
  const reasons: string[] = [];
  let s = raw;

  if (s !== s.trim() || /\s{2,}/.test(s)) {
    reasons.push("Removes extra spaces.");
    s = s.trim().replace(/\s+/g, " ");
  }

  // "tie & dye", "tie and dye", "tie n dye" are all the one technique.
  if (/\btie\s*(?:&|and|n)\s*dye\b/i.test(s)) {
    s = s.replace(/\btie\s*(?:&|and|n)\s*dye\b/gi, "tie-dye");
    reasons.push("Writes “tie & dye” the usual way, as “Tie-Dye”.");
  }

  // "Mini Check - Pink+Magenta": a trailing list of colours belongs in front.
  const dash = s.match(/^(.+?)\s+[-–—:]\s+(.+)$/);
  if (dash) {
    const tail = dash[2]
      .split(/\s*(?:\+|&|,|\band\b)\s*/i)
      .map((t) => t.trim())
      .filter(Boolean);
    if (tail.length > 0 && tail.every((t) => COLOUR_SET.has(t.toLowerCase()))) {
      s = `${joinList(tail)} ${dash[1]}`;
      reasons.push("Moves the colours to the front instead of after a dash.");
    } else {
      s = `${dash[1]} ${dash[2]}`;
      reasons.push("Removes the dash — product names read better as one phrase.");
    }
  }

  // "Pink+Magenta" inside a word.
  if (/[A-Za-z]\+[A-Za-z]/.test(s)) {
    s = s.replace(/([A-Za-z]+)\+([A-Za-z]+)/g, "$1 and $2");
    reasons.push("Writes “+” as “and”.");
  }

  // Unambiguous abbreviations.
  const expanded: string[] = [];
  s = s
    .split(" ")
    .map((tok) => {
      const full = ABBREVIATIONS[tok.toLowerCase()];
      if (!full) return tok;
      expanded.push(`“${tok}” → “${full}”`);
      return full;
    })
    .join(" ");
  if (expanded.length) reasons.push(`Spells out abbreviations: ${expanded.join(", ")}.`);

  // "Saree Saree".
  const deduped = s.split(" ").filter((w, i, all) => i === 0 || w.toLowerCase() !== all[i - 1].toLowerCase());
  if (deduped.length !== s.split(" ").length) {
    s = deduped.join(" ");
    reasons.push("Removes a repeated word.");
  }

  const cased = titleCase(s);
  if (cased !== s) {
    // Only claimed as a reason when the ORIGINAL casing was inconsistent, not
    // merely because an expansion above came out lowercase.
    if (titleCase(raw.trim().replace(/\s+/g, " ")) !== raw.trim().replace(/\s+/g, " ")) {
      reasons.push("Capitalises each word, as the rest of the catalogue does.");
    }
    s = cased;
  }

  const type = productTypeFor(categoryName);
  if (type && s && !namesProductType(s, type)) {
    s = `${s} ${titleCase(type)}`;
    reasons.push(`Adds the product type, “${titleCase(type)}”, from the sub-category.`);
  }

  return { value: s, reasons: s === raw ? [] : reasons };
}

function checkName(input: ContentInput, out: Finding[]): string {
  const raw = input.name;
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) {
    out.push({
      id: "name:empty",
      field: "name",
      level: "problem",
      evidence: "MISSING",
      message: "No name yet.",
    });
    return "";
  }

  const others = input.otherProducts.map((p) => p.name);
  const clean = cleanName(raw, input.categoryName);
  const collides = (candidate: string) =>
    others.find((o) => normaliseForCompare(o) === normaliseForCompare(candidate));

  if (clean.reasons.length) {
    const taken = collides(clean.value);
    out.push({
      id: `name:clean:${raw}`,
      field: "name",
      level: "warn",
      evidence: "DERIVED",
      message: taken
        ? `${quote(name)} could be tidied, but the tidy version is already another product's name.`
        : `${quote(name)} could be clearer.`,
      reasons: clean.reasons,
      suggestion: taken ? undefined : { field: "name", value: clean.value },
    });
  }

  if (!input.categoryName) {
    out.push({
      id: "name:no-category",
      field: "name",
      level: "warn",
      evidence: "MISSING",
      message: "Pick a sub-category so the name can be checked for the product type.",
    });
  }

  // Exact and near collisions with what the shop already has.
  const exact = collides(name);
  if (exact) {
    out.push({
      id: `name:duplicate:${raw}`,
      field: "name",
      level: "problem",
      evidence: "VERIFIED",
      message: `Another product is already called ${quote(exact)}. Two pieces with one name can't be told apart in search, the basket or an order.`,
    });
  } else {
    const key = words(name).sort().join(" ");
    const near = others.find((o) => words(o).sort().join(" ") === key);
    if (near) {
      out.push({
        id: `name:near:${raw}`,
        field: "name",
        level: "warn",
        evidence: "VERIFIED",
        message: `Very close to an existing product, ${quote(near)}. Make sure they are different pieces, and that the names say how.`,
      });
    }
  }

  // Spelling hints — UNCERTAIN, never applied.
  for (const w of new Set(name.match(/[A-Za-z]+(?:-[A-Za-z]+)*/g) ?? [])) {
    const lw = w.toLowerCase();
    if (lw.length < 3 || VOCAB.has(lw) || ABBREVIATIONS[lw] || (COMMON.has(lw) && !COLOUR_NEAR(lw))) continue;
    const candidates = [...VOCAB].filter(
      (v) => !v.includes("-") && Math.abs(v.length - lw.length) <= 1 && editDistance(lw, v) === 1 && (lw.length > 3 || v[0] === lw[0])
    );
    if (candidates.length === 0) continue;
    const best = candidates.find((c) => COLOUR_SET.has(c)) ?? candidates[0];
    out.push({
      id: `name:typo:${lw}:${raw}`,
      field: "name",
      level: "warn",
      evidence: "UNCERTAIN",
      message: `${quote(w)} — did you mean ${quote(titleWord(best, false))}? Not changed: only you know which was meant.`,
    });
  }

  const marketing = words(name).filter((w) => MARKETING_WORDS.includes(w));
  if (marketing.length) {
    out.push({
      id: `name:marketing:${raw}`,
      field: "name",
      level: "warn",
      evidence: "UNCERTAIN",
      message: `${joinList(marketing.map((m) => quote(titleWord(m, false))))} describes how it should feel, not what it is. Keep it only if it is the usual trade name.`,
    });
  }

  if (/\s[|/\\]\s|[|]/.test(name)) {
    out.push({
      id: `name:separators:${raw}`,
      field: "name",
      level: "warn",
      evidence: "VERIFIED",
      message: "The name is split up with “|”. It is shown as a page title and breadcrumb, where one plain phrase reads better — the details belong in the description.",
    });
  }

  if (name.length > NAME_MAX) {
    out.push({
      id: `name:long:${raw}`,
      field: "name",
      level: "warn",
      evidence: "VERIFIED",
      message: `${name.length} characters — long for a title. Search results cut off around ${NAME_MAX}.`,
    });
  }

  const type = productTypeFor(input.categoryName);
  const descriptive = words(name).filter(
    (w) => !SMALL_WORDS.has(w) && !(type && namesProductType(w, type))
  );
  if (name.length < 8 || descriptive.length === 0) {
    out.push({
      id: `name:vague:${raw}`,
      field: "name",
      level: "warn",
      evidence: "VERIFIED",
      message: "Very short — say what makes this piece different: a colour, a border, a motif.",
    });
  }

  return clean.reasons.length && !collides(clean.value) ? clean.value : name;
}

/** "pin" is common English but is also one letter off a colour — worth the hint. */
function COLOUR_NEAR(lw: string): boolean {
  return COLOURS.some((c) => !c.includes("-") && editDistance(lw, c) === 1 && c[0] === lw[0]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Field consistency

function fabricWordsIn(text: string): string[] {
  return [...new Set(words(text).filter((w) => FABRIC_SET.has(w)))];
}

function checkFabric(input: ContentInput, isClothing: boolean, out: Finding[]) {
  const fabric = input.fabric.trim();
  const nameFabrics = fabricWordsIn(input.name);

  if (!fabric) {
    if (nameFabrics.length) {
      out.push({
        id: `fabric:empty-named:${input.name}`,
        field: "fabric",
        level: "warn",
        evidence: "MISSING",
        message: `The name says ${joinList(nameFabrics.map((f) => quote(titleWord(f, false))))}, but Fabric is empty. Fill it in if that is the cloth — it isn't copied over for you.`,
      });
    } else if (isClothing) {
      out.push({
        id: "fabric:empty",
        field: "fabric",
        level: "warn",
        evidence: "MISSING",
        message: "Fabric is empty. It is the material Google is told about, a filter on the shop, and what Ask Wovenne answers from — without it the product says nothing about what it is made of.",
      });
    }
    return;
  }

  const fabricWords = new Set(words(fabric));
  const conflicting = nameFabrics.filter((w) => !fabricWords.has(w));
  if (conflicting.length) {
    out.push({
      id: `fabric:conflict:${input.name}:${fabric}`,
      field: "fabric",
      level: "problem",
      evidence: "VERIFIED",
      message: `Fabric conflict: the name says ${joinList(conflicting.map((f) => quote(titleWord(f, false))))}, but the Fabric field says ${quote(fabric)}. Confirm which is correct — nothing has been changed.`,
    });
  }

  const nameClaims = CONSTRUCTION_CLAIMS.filter((c) => words(input.name).includes(c));
  const backed = nameClaims.filter((c) => fabricWords.has(c) || words(input.notes ?? "").includes(c));
  const unbacked = nameClaims.filter((c) => !backed.includes(c));
  if (unbacked.length) {
    out.push({
      id: `fabric:claim:${input.name}:${fabric}`,
      field: "fabric",
      level: "warn",
      evidence: "UNCERTAIN",
      message: `The name says ${quote(titleWord(unbacked[0], false))}, but neither Fabric nor the brand-knowledge notes say so. Confirm it is true before it goes live.`,
    });
  }

  spellingOfExisting(
    "fabric",
    fabric,
    input.otherProducts.map((p) => p.fabric),
    out
  );
}

/**
 * The colours a name states, split by what they colour. A colour sitting just
 * before a detail word ("border", "lines", "check", "embroidered"…) colours
 * that detail; any other colour is read as the body. "Lime Green Thick Border"
 * states a green BORDER and no body colour; "Pink Tie-Dye" states a pink body.
 * Colours joined by "and" are one group, so the red in "Red and Black Double
 * Line Border" is a border colour too.
 */
function coloursInName(name: string): { body: string[]; detail: string[] } {
  const ws = words(name);
  const body = new Set<string>();
  const detail = new Set<string>();
  ws.forEach((w, i) => {
    if (!COLOUR_SET.has(w)) return;
    let j = i + 1;
    while (j < ws.length && (COLOUR_SET.has(ws[j]) || ws[j] === "and")) j++;
    const following = ws.slice(j, j + 3);
    (following.some((f) => DETAIL_WORDS.has(f)) ? detail : body).add(w);
  });
  return { body: [...body], detail: [...detail] };
}

function checkColour(input: ContentInput, out: Finding[]) {
  const colour = input.colour.trim();
  if (!colour) {
    out.push({
      id: "colour:empty",
      field: "colour",
      level: "warn",
      evidence: "MISSING",
      message: "Colour is empty, so the product won't appear under any colour filter on the shop.",
    });
    return;
  }

  // Colour is the MAIN BODY colour (see the header).
  const { body, detail } = coloursInName(input.name);
  const colourWords = new Set(words(colour).flatMap((w) => [w, ...w.split("-")]));
  const has = (c: string) => colourWords.has(c) || colourWords.has(c.replace("gray", "grey"));
  const mismatched = body.filter((c) => !has(c));
  if (body.length && mismatched.length === body.length) {
    out.push({
      id: `colour:review:${input.name}:${colour}`,
      field: "colour",
      level: "warn",
      evidence: "UNCERTAIN",
      message: `Colour requires review: Colour should be the main body colour. The name suggests a ${joinList(mismatched.map((c) => quote(titleWord(c, false))))} body, but Colour is ${quote(colour)} — shoppers filtering by colour find it under ${quote(colour)}. Nothing has been changed.`,
    });
  } else if (body.length === 0 && detail.length) {
    // Colour holding only what the name calls a BORDER colour: probably the
    // border was entered where the body colour belongs.
    const fieldColours = [...colourWords].filter((w) => COLOUR_SET.has(w));
    if (fieldColours.length && fieldColours.every((w) => detail.includes(w))) {
      out.push({
        id: `colour:border:${input.name}:${colour}`,
        field: "colour",
        level: "warn",
        evidence: "UNCERTAIN",
        message: `Colour requires review: ${quote(colour)} is the colour the name gives the border. Colour should be the main body colour of the piece — border colours belong in the name and description. Nothing has been changed.`,
      });
    }
  }

  spellingOfExisting(
    "colour",
    colour,
    input.otherProducts.map((p) => p.colour),
    out
  );
}

/**
 * A new spelling of a value the shop already uses makes a second filter chip
 * for the same thing ("Off-white" and "Off White"). Offer the existing one.
 */
function spellingOfExisting(
  field: "fabric" | "colour",
  value: string,
  existing: (string | null)[],
  out: Finding[]
) {
  const same = existing.find((e) => e && e.trim() && e.trim() !== value && squash(e) === squash(value));
  if (!same) return;
  out.push({
    id: `${field}:spelling:${value}`,
    field,
    level: "warn",
    evidence: "DERIVED",
    message: `Other products spell this ${quote(same.trim())}. A different spelling shows up as a separate ${field} filter on the shop.`,
    suggestion: { field, value: same.trim() },
  });
}

function checkSizes(input: ContentInput, out: Finding[]) {
  const text = `${input.name} ${input.description}`;
  const saysAdjustable = /\badjustable\b|\bfree[\s-]?size\b|\bone[\s-]?size\b/i.test(text);
  const fixed = input.sizes.map((s) => s.trim()).filter((s) => s && !FREE_SIZE_LABELS.test(s));
  if (saysAdjustable && fixed.length) {
    out.push({
      id: `sizes:adjustable:${text}:${fixed.join(",")}`,
      field: "sizes",
      level: "problem",
      evidence: "VERIFIED",
      message: `Size / name conflict: the ${/\badjustable\b/i.test(input.name) ? "name" : "description"} says it is adjustable or one size, but the product has fixed size${fixed.length > 1 ? "s" : ""} ${fixed.map(quote).join(", ")}. Confirm which is correct.`,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Description

/** "Red Heart Embroidered Saree" → "red heart embroidered saree"; "14K" survives. */
function asPhrase(name: string): string {
  return name
    .split(" ")
    .map((w) => (/\d/.test(w) || (w.length > 1 && w === w.toUpperCase()) ? w : w.toLowerCase()))
    .join(" ");
}

/** "Cotton" → "cotton"; "Chanderi Silk" keeps its capitals (a proper noun is likely). */
function fabricPhrase(fabric: string): string {
  return /[A-Z]/.test(fabric.slice(1)) ? fabric : fabric[0].toLowerCase() + fabric.slice(1);
}

/**
 * A description built ONLY from the name and the Fabric field — nothing else is
 * known. One sentence, deliberately plain: it is a starting point the admin is
 * expected to add to, never a finished claim about the piece.
 */
export function draftDescription(name: string, fabric: string): string | null {
  const n = name.trim();
  const f = fabric.trim();
  if (!n || !f) return null;
  const phrase = asPhrase(n);
  const article = /^[aeiou]/i.test(phrase) ? "An" : "A";
  return `${article} ${phrase} in ${fabricPhrase(f)}.`;
}

function checkDescription(
  input: ContentInput,
  bestName: string,
  isJewellery: boolean,
  missing: string[],
  out: Finding[]
) {
  const raw = input.description;
  const desc = raw.trim();

  if (!desc) {
    // A name and a Fabric field that disagree would put the disagreement into
    // the copy ("a tissue … saree in cotton"). Wait until it is settled.
    const fabricWords = new Set(words(input.fabric));
    const unsettled = fabricWordsIn(input.name).some((w) => input.fabric.trim() && !fabricWords.has(w));
    const draft = isJewellery || unsettled ? null : draftDescription(bestName, input.fabric);
    out.push({
      id: `description:empty:${bestName}:${input.fabric}`,
      field: "description",
      level: "warn",
      evidence: draft ? "DERIVED" : "MISSING",
      message: draft
        ? "No description yet. Here is a plain one built only from the name and fabric — add what you know about the piece."
        : unsettled
          ? "No description yet. One can be suggested once the fabric conflict below is settled."
          : "No description yet, and the form doesn't hold enough to suggest one.",
      reasons: draft ? ["Uses only the Name and Fabric fields. Says nothing about weave, origin, zari, size or care."] : undefined,
      suggestion: draft ? { field: "description", value: draft } : undefined,
    });
    if (isJewellery) {
      missing.push("Metal, plating and stones — no field records them. Write them in the description only if you know them.");
      if (/\badjustable\b/i.test(input.name)) missing.push("Whether it really adjusts, and how.");
    } else if (!input.fabric.trim()) {
      missing.push("Fabric — needed before a description can say what it is made of.");
    }
    return;
  }

  if (raw !== desc || /\s{3,}/.test(desc)) {
    out.push({
      id: `description:spaces:${raw}`,
      field: "description",
      level: "warn",
      evidence: "DERIVED",
      message: "The description has extra spaces at the start or end.",
      suggestion: { field: "description", value: desc },
    });
  }

  if (desc.length < DESCRIPTION_MIN) {
    out.push({
      id: `description:short:${raw}`,
      field: "description",
      level: "warn",
      evidence: "VERIFIED",
      message: "Very short. A useful first sentence says what the piece is and what it is made of.",
    });
  } else if (desc.length > DESCRIPTION_MAX) {
    out.push({
      id: `description:long:${raw}`,
      field: "description",
      level: "warn",
      evidence: "VERIFIED",
      message: `${desc.length} characters. One to three sentences is plenty; heritage, craft and care have their own boxes.`,
    });
  }

  const lower = desc.toLowerCase();
  const phrases = [
    ...MARKETING_PHRASES.filter((p) => lower.includes(p)),
    ...DESCRIPTION_MARKETING_WORDS.filter((w) => words(desc).includes(w)),
  ];
  if (phrases.length) {
    out.push({
      id: `description:marketing:${raw}`,
      field: "description",
      level: "warn",
      evidence: "UNCERTAIN",
      message: `Reads like an advert: ${joinList(phrases.map(quote))}. Say what the piece is instead.`,
    });
  }

  // Claims the form can't back. Supported if the same claim appears in the
  // name, fabric or brand-knowledge notes the admin also typed. A jewellery
  // piece's metal, plating and stone have no field of their own — the
  // description is where they are MEANT to be written — so those are not
  // questioned there.
  const backing = `${input.name} ${input.fabric} ${input.notes ?? ""}`;
  const unbacked = CLAIM_PATTERNS.filter(
    ({ re, jewelleryFact }) => re.test(desc) && !re.test(backing) && !(isJewellery && jewelleryFact)
  ).map((c) => c.label);
  if (unbacked.length) {
    out.push({
      id: `description:claims:${raw}`,
      field: "description",
      level: "warn",
      evidence: "UNCERTAIN",
      message: `States ${joinList(unbacked)}, which no other field records. Make sure it is true — the product page and Ask Wovenne will repeat it as fact.`,
    });
  }

  const fabric = input.fabric.trim();
  if (fabric) {
    const fw = new Set(words(fabric));
    const other = fabricWordsIn(desc).filter((w) => !fw.has(w));
    if (other.length) {
      out.push({
        id: `description:fabric:${raw}:${fabric}`,
        field: "description",
        level: "warn",
        evidence: "VERIFIED",
        message: `The description mentions ${joinList(other.map(quote))}, but Fabric is ${quote(fabric)}. Confirm which is correct.`,
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point

/**
 * Check a product form. Pure: same input, same findings, no I/O, input never
 * mutated.
 */
export function checkProductContent(input: ContentInput): ContentCheck {
  const findings: Finding[] = [];
  const missing: string[] = [];
  const parent = input.parentCategoryName?.trim().toLowerCase() ?? "";
  const isJewellery = parent === "jewellery" || parent === "jewelry";
  const isClothing = !!input.categoryName && !isJewellery;

  const bestName = checkName(input, findings);
  checkDescription(input, bestName, isJewellery, missing, findings);
  checkFabric(input, isClothing, findings);
  checkColour(input, findings);
  checkSizes(input, findings);

  if (words(input.name).includes("zari")) {
    missing.push("Zari type (pure or tested) — not recorded. Don't state it unless you know.");
  }

  return { status: statusOf(findings), findings, missing };
}

/** The panel's headline: the worst level among the findings still showing. */
export function statusOf(findings: Finding[]): Level {
  if (findings.some((f) => f.level === "problem")) return "problem";
  if (findings.length) return "warn";
  return "ok";
}

/**
 * What "Use suggestion" does to the form: a copy with that ONE field replaced.
 * The caller decides nothing else — no save, no publish.
 */
export function applySuggestion<F extends Record<Suggestion["field"], string>>(form: F, s: Suggestion): F {
  return { ...form, [s.field]: s.value };
}

/**
 * The seam for a future model-backed suggester (natural rewrites of awkward
 * word order, fuller descriptions). Not implemented: there is no approved
 * product-content AI call yet. Whatever implements it must run server-side
 * behind the same admin + MFA gate as /api/admin/insights, return Findings with
 * honest evidence labels, and never mark a fact VERIFIED that the form does not
 * hold.
 */
export type ContentSuggester = (input: ContentInput) => Promise<Finding[]>;
