import { cookies, draftMode } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/supabase";

/**
 * Turn preview mode on, then send the admin to the page they want to inspect.
 *
 * Gated on is_admin() here rather than in middleware, because this route is
 * what grants the capability — a customer who guesses the URL must not be able
 * to read unpublished work.
 *
 * The redirect target is restricted to a path on this site. Without that, a
 * crafted link could bounce an admin to another origin, with the preview cookie
 * already set.
 */
export async function GET(request: NextRequest) {
  const store = cookies();
  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return store.getAll();
      },
      setAll() {},
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/admin/login", request.url));
  }

  const { data: isAdmin, error } = await supabase.rpc("is_admin");
  if (error || !isAdmin) {
    return new NextResponse("Not found", { status: 404 });
  }

  const requested = request.nextUrl.searchParams.get("path") ?? "/";
  // Must be a site-relative path: single leading slash, no scheme, no host.
  const path =
    requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";

  draftMode().enable();
  return NextResponse.redirect(new URL(path, request.url));
}
