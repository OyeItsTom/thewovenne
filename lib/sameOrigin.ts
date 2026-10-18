import type { NextRequest } from "next/server";

/**
 * A state-changing POST from one of our own pages, said so.
 *
 * A form on another site carries its own Origin; a request with none is not
 * one our pages make. Cookies alone are not proof of intent.
 */
export function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  try {
    return !!origin && new URL(origin).host === new URL(request.url).host;
  } catch {
    // "null" or garbage: not us.
    return false;
  }
}
