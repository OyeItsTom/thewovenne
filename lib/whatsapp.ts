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
  const number = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER;
  if (!number) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}
