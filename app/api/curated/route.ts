import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/supabase";
import { getCuratedProducts } from "@/lib/curated";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The curated set for whoever is asking.
 *
 * EXISTS SO THE HOMEPAGE CAN BE CACHED AGAIN. Personalising on the server made
 * the whole page uncacheable — measured at 993 ms to first byte against 64–130
 * ms everywhere else, on the page that greets the most first-time visitors.
 *
 * Now the page ships cached new arrivals to everyone instantly, and only a
 * signed-in customer's browser calls this to swap in something better. Guests
 * — the majority, and the ones whose first impression matters most — never
 * touch it.
 *
 * The scoring itself is unchanged and still runs on the server, where the
 * catalogue already is. Nothing about which products a customer sees moved
 * into the browser; only the decision to ask.
 */
export async function GET() {
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

  // No session means nothing to personalise from, and the cached page already
  // shows the right thing. Saying so is cheaper than computing it again.
  if (!user) {
    return NextResponse.json({ reason: "new", products: [], basedOn: 0 });
  }

  const set = await getCuratedProducts(supabase, true);

  // Only worth sending back if it actually differs from what the page already
  // rendered. "new" means the fallback won, which is what is on screen.
  if (set.reason !== "personal") {
    return NextResponse.json({ reason: "new", products: [], basedOn: 0 });
  }

  return NextResponse.json(set);
}
