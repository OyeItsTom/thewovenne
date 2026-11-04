/**
 * A customer's name, made fit for "Hello {name}," in an E1 email.
 *
 * Escaping is the layout's job; this only stops a name from rearranging or
 * flooding the line it sits in. Format characters (bidi overrides, zero-width
 * joiners) are removed, control characters become spaces, the first word is
 * kept and capped at 40 characters. A name containing < or > is not a real
 * name, and "Hello <a," helps nobody, so it falls back to "Hello,".
 *
 * WP-EMAIL-E4 (draft PR #222) carries the same rule inside its invoice
 * template; when both are merged they should share this one.
 */
export function greetingName(name: string | null | undefined): string | null {
  const cleaned = String(name ?? "")
    .replace(/[\p{Cf}\p{Co}\p{Cn}]/gu, "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .trim();
  if (!cleaned || /[<>]/.test(cleaned)) return null;
  const first = cleaned.split(/\s+/)[0];
  return Array.from(first).slice(0, 40).join("");
}

/**
 * Text written by an admin for a customer to read, made safe to show: control
 * and format characters out, whitespace collapsed, capped at `max` characters
 * with an ellipsis. Only the EMAIL copy is shortened; whatever was recorded
 * (a credit note's reason, a rejection reason) is untouched.
 */
export function customerVisibleText(value: string | null | undefined, max = 500): string | null {
  const cleaned = String(value ?? "")
    .replace(/[\p{Cf}\p{Co}\p{Cn}]/gu, "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, " ")
    .trim();
  if (!cleaned) return null;
  const chars = Array.from(cleaned);
  return chars.length <= max ? cleaned : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}
