/**
 * Turning a value into a <script type="application/ld+json"> body, safely.
 *
 * NO REACT, NO NEXT, NO DATABASE — the escaping rules and the pruning rules are
 * the whole of the security surface here, so they live where they can be read
 * and tested on their own, like lib/footer.ts and lib/sitemapRoutes.ts.
 *
 * ── WHY ESCAPING IS NOT OPTIONAL ──
 *
 * A JSON-LD block is JSON inside HTML, and the HTML parser reaches it first. It
 * does not know or care that it is looking at JSON: the first literal
 * "</script" in the text ends the element, and everything after it is parsed as
 * markup. Product descriptions, review bodies and reviewer names are written by
 * people — a customer whose review says "</script><img onerror=...>" would
 * otherwise be writing HTML into every page that quotes them.
 *
 * So `<`, `>` and `&` are emitted as <, > and &. Those are legal
 * JSON string escapes that parse back to the same characters, which means the
 * structured data Google reads is identical while the HTML parser never sees a
 * tag. U+2028 and U+2029 are escaped too: they are valid inside a JSON string
 * but are line terminators to a JavaScript parser, and a JSON-LD block can be
 * read by either.
 *
 * ── WHY PRUNING IS NOT OPTIONAL ──
 *
 * JSON.stringify drops `undefined` from objects but keeps `null`, and turns NaN
 * and Infinity into `null` without complaint. Either way the result is a
 * property that is present and empty — "price": null — which is worse than an
 * absent one: it is a claim that we know the value and it is nothing. Google's
 * own guidance and this project's data rule agree that a field we cannot fill
 * truthfully should not be there at all, so pruning happens before serialising
 * rather than at every call site.
 */

/** A value that survived pruning: JSON-safe, with nothing empty left in it. */
export type JsonLdValue =
  | string
  | number
  | boolean
  | JsonLdValue[]
  | { [key: string]: JsonLdValue };

/**
 * Drop everything that cannot be stated truthfully.
 *
 * Removed: undefined, null, NaN, ±Infinity, empty strings, and any object or
 * array left with nothing in it once its own members have been pruned. A node
 * whose every property fell away is not an empty node, it is no node.
 *
 * Kept: 0 and false, which are values rather than absences — a rating of 0 is
 * gated elsewhere, and this function must not start making editorial decisions.
 */
export function prune(value: unknown): JsonLdValue | undefined {
  if (value === null || value === undefined) return undefined;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    const items = value
      .map(prune)
      .filter((item): item is JsonLdValue => item !== undefined);
    return items.length > 0 ? items : undefined;
  }

  if (typeof value === "object") {
    const out: Record<string, JsonLdValue> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = prune(raw);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  // Functions, symbols, bigints: not representable, and never intended.
  return undefined;
}

/**
 * The characters that would let a string escape its <script> element, plus the
 * two that would break a JavaScript parser reading the same block.
 *
 *   003c 003e 0026   <, > and &. Escaping `<` alone would stop "</script>";
 *                    the other two go so that no fragment of the output can be
 *                    read as markup or an entity under a parser's error
 *                    recovery.
 *   2028 2029        Line and paragraph separators. Legal inside a JSON string
 *                    and invisible in an editor, but line TERMINATORS to a
 *                    JavaScript parser.
 *
 * WRITTEN AS CODE POINTS, AND THE PATTERN IS DERIVED FROM THEM. An earlier
 * draft of this file spelled the character class out as a regular-expression
 * literal, and the two separators went into it as themselves rather than as
 * escapes — which made the literal span a line break and stopped the file
 * compiling. The characters this module exists to neutralise are exactly the
 * ones that cannot be trusted to survive being typed, so they are named by
 * number here and never appear in the source at all. One list feeds both the
 * matching and the replacing, so the two cannot disagree.
 */
const UNSAFE_CODE_POINTS = [0x3c, 0x3e, 0x26, 0x2028, 0x2029];

/** A code point as the JSON escape that represents it: 0x3c -> \u003c */
function unicodeEscape(code: number): string {
  return `\\u${code.toString(16).padStart(4, "0")}`;
}

const UNSAFE = new RegExp(`[${UNSAFE_CODE_POINTS.map(unicodeEscape).join("")}]`, "g");

/**
 * Serialise a node for embedding in HTML.
 *
 * Returns null when nothing survives pruning, so a caller renders no <script>
 * at all rather than an empty one.
 */
export function serializeJsonLd(value: unknown): string | null {
  const cleaned = prune(value);
  if (cleaned === undefined) return null;
  return JSON.stringify(cleaned).replace(UNSAFE, (char) =>
    unicodeEscape(char.charCodeAt(0))
  );
}
