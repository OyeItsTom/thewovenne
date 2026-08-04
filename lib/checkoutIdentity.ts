import type { SupabaseClient } from "@supabase/supabase-js";
import { EMPTY_ADDRESS, type ShippingAddress } from "./orderDetails";

/**
 * What we already know about whoever is checking out.
 *
 * A signed-in customer has told us their name and email once already; asking
 * again is asking them to prove they are still the person who just logged in.
 * So those come from the account and are not editable in the form — changing
 * the email at checkout would send the receipt somewhere the account cannot
 * see, which is how an order goes missing.
 *
 * The delivery address and phone ARE asked every time, on purpose. A delivery
 * address is per-parcel, not per-person: gifts, offices, a different city this
 * month. They are pre-filled from the saved address (0035) when there is one,
 * and otherwise from the last order — a starting point, fully editable, never
 * assumed.
 */
export interface CheckoutIdentity {
  signedIn: boolean;
  /** Empty for guests, who type their own. */
  email: string;
  name: string;
  /** Best guess from the last order, for the customer to confirm or change. */
  phone: string;
  address: ShippingAddress;
  /** True when phone/address came from a previous order rather than nothing. */
  prefilledFromLastOrder: boolean;
}

const GUEST: CheckoutIdentity = {
  signedIn: false,
  email: "",
  name: "",
  phone: "",
  address: { ...EMPTY_ADDRESS },
  prefilledFromLastOrder: false,
};

export async function getCheckoutIdentity(
  supabase: SupabaseClient
): Promise<CheckoutIdentity> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return GUEST;

  // A staff session checks out as a guest — the second place admin identity
  // could surface in customer-facing UI. Middleware keeps admins out of
  // /account, but /checkout is a shop page anyone may reach, and prefilling it
  // would print a staff name and address into the order form. Admin emails are
  // already refused at the customer login form, so an order placed from a
  // staff session should carry whatever the person actually types.
  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (isAdmin === true) return GUEST;

  // The wider select is tried first and falls back to the columns that have
  // always existed. This is deploy-ordering insurance, not defensive habit: if
  // this code ships before migration 0035 runs, an unknown column here would
  // 400 and take the CHECKOUT down. Costing one extra query on that path is a
  // trade worth making; it disappears the moment the migration is applied.
  let profile: {
    full_name?: string | null;
    email?: string | null;
    default_address?: unknown;
    default_phone?: string | null;
  } | null = null;

  const wide = await supabase
    .from("profiles")
    .select("full_name, email, default_address, default_phone")
    .eq("id", user.id)
    .maybeSingle();

  if (wide.error) {
    const narrow = await supabase
      .from("profiles")
      .select("full_name, email")
      .eq("id", user.id)
      .maybeSingle();
    profile = narrow.data;
  } else {
    profile = wide.data;
  }

  // RLS scopes this to the customer's own orders (0023 matches on auth.email()
  // from the JWT), so no email filter is needed and adding one would imply the
  // policy were optional.
  const { data: lastOrder } = await supabase
    .from("orders")
    .select("customer_phone, shipping_address")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // The saved address wins: it is what the customer deliberately chose as
  // their usual, whereas the last order might have been a one-off gift sent
  // somewhere else entirely.
  const saved = (profile?.default_address ?? null) as ShippingAddress | null;
  const fromOrder = (lastOrder?.shipping_address ?? null) as ShippingAddress | null;
  const addr = saved?.line1 ? saved : fromOrder;
  const phone = profile?.default_phone || lastOrder?.customer_phone || "";

  return {
    signedIn: true,
    email: profile?.email ?? user.email ?? "",
    name: profile?.full_name ?? "",
    phone,
    address: addr ? { ...EMPTY_ADDRESS, ...addr } : { ...EMPTY_ADDRESS },
    // Only claimed for the last-order guess. A saved address is the customer's
    // own choice and needs no explaining; "from your last order" does.
    prefilledFromLastOrder: !saved?.line1 && Boolean(fromOrder?.line1 || lastOrder?.customer_phone),
  };
}
