/**
 * The one place a wa.me link is built.
 *
 * WHY THIS EXISTS: five components each wrote the same template string, and
 * four of them interpolated the environment variable without checking it. Unset
 * — which is exactly its state in every Preview deployment — that produces
 *
 *   https://wa.me/undefined?text=…
 *
 * a link that renders normally, invites a click, and lands on a WhatsApp error.
 * AskWovenne wrote `?? ""` instead and got `https://wa.me/?text=…`, which fails
 * differently and just as quietly. Nobody noticed because Production has the
 * variable set, so the bug was invisible in the only place anyone looks.
 *
 * Returning null rather than a string is the whole point: a caller cannot spread
 * this into an href without deciding what an absent number means, and the answer
 * is always the same — render no link at all. A contact route that does not work
 * costs more trust than one that is not offered.
 *
 * SAFE IN CLIENT COMPONENTS. `process.env.NEXT_PUBLIC_*` is replaced with a
 * literal at build time wherever the expression appears, including here, so
 * bundled callers get the value inlined and no runtime lookup happens.
 */
export function whatsappHref(message: string): string | null {
  return whatsappHrefFor(process.env.NEXT_PUBLIC_WHATSAPP_NUMBER, message);
}

/**
 * The same link, for a number that came from somewhere other than the
 * environment — currently the footer, where the owner may override it.
 *
 * STILL ONE BUILDER. The point of this module is that no second place writes a
 * wa.me string; a caller with its own number passes it in rather than
 * interpolating its own template, so the validation below applies to every
 * link the site emits regardless of where the digits came from.
 *
 * VALIDATION, BECAUSE A TYPED NUMBER IS NOT AN ENVIRONMENT VARIABLE. Somebody
 * entering a number in an admin form will write it the way people write phone
 * numbers — "+91 98765 43210", "(91) 98765-43210" — and wa.me accepts none of
 * that. The separators people actually use are removed, and what must remain is
 * 8 to 15 digits, which is E.164's range. Anything else returns null and the
 * caller shows no link at all, which is the whole rule.
 */
export function whatsappHrefFor(
  number: string | null | undefined,
  message: string
): string | null {
  const digits = (number ?? "").replace(/[\s()+.-]/g, "");
  if (!/^[0-9]{8,15}$/.test(digits)) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}
