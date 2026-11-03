import { adminApiGate } from "@/lib/adminApiGate";
import { NextRequest, NextResponse } from "next/server";
import { createRSCClient } from "@/lib/supabaseRSC";
import { createServiceClient } from "@/lib/supabase";
import { isSameOrigin } from "@/lib/sameOrigin";
import { attemptOrderConfirmation } from "@/lib/orderConfirmationDelivery";
import { performDispatch, type DispatchRequestBody } from "@/lib/dispatchOrder";
import type { ShipmentEmailRow } from "@/lib/shipmentEmailState";

/**
 * Dispatch an order to India Post Speed Post, and email the customer once
 * (WP-EMAIL-E3c). Replaces the Orders screen's plain "Mark shipped" UPDATE,
 * which 0075 now refuses.
 *
 * In order: the admin session must still exist and not be idle (adminApiGate,
 * first in every /api/admin handler — admin-session-lifecycle checks it); the
 * request must come from our own pages (a cross-site form carries its own
 * Origin) before anything changes; is_admin() — two factors and a
 * live session, 0067 — answers 404 otherwise, as the cancel route does. Then
 * lib/dispatchOrder: the number is checked again, and dispatch_order() runs
 * with the admin's own session, deciding paid, status, address and the one
 * email intent itself.
 *
 * The service key is used only after that, server side, for R1's send attempt
 * and to read back what Resend said. It never reaches the browser.
 */
export const runtime = "nodejs";
// One R1 attempt is bounded at 10 s (CONFIRMATION_TIMEOUT_MS) plus a few
// database calls; this leaves room without letting a request hang.
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const ended = await adminApiGate(request);
  if (ended) return ended;

  if (!isSameOrigin(request)) return NextResponse.json({ ok: false, error: "Not allowed." }, { status: 403 });

  const session = createRSCClient();
  const { data: isAdmin } = await session.rpc("is_admin");
  if (isAdmin !== true) return new NextResponse("Not found", { status: 404 });

  let body: DispatchRequestBody;
  try {
    body = (await request.json()) as DispatchRequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "That request could not be read." }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, error: "That request could not be read." }, { status: 400 });
  }

  const service = createServiceClient();
  const reply = await performDispatch(body, {
    session,
    attempt: (id) => attemptOrderConfirmation(id, { supabase: service }),
    readEmail: async (id) => {
      const { data, error } = await service
        .from("order_email_deliveries")
        .select("status, possibly_accepted, attempts, last_error_code")
        .eq("id", id)
        .maybeSingle();
      if (error) return null;
      return (data as ShipmentEmailRow | null) ?? null;
    },
  });

  return NextResponse.json(reply.body, { status: reply.status, headers: { "Cache-Control": "no-store" } });
}
