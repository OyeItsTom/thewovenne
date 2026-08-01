import { draftMode } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

/**
 * Leave preview mode. No admin check — turning preview OFF can only ever
 * reduce what the caller sees, so gating it would just be a way to get stuck
 * in preview after a session expires.
 */
export async function GET(request: NextRequest) {
  draftMode().disable();

  const requested = request.nextUrl.searchParams.get("path") ?? "/";
  const path =
    requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";

  return NextResponse.redirect(new URL(path, request.url));
}
