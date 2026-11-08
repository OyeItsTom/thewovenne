import { NextRequest, NextResponse } from "next/server";
import { adminApiGate } from "@/lib/adminApiGate";
import { isSameOrigin } from "@/lib/sameOrigin";
import { createRSCClient } from "@/lib/supabaseRSC";
import { verifyAndRecordRefund, REFUND_ID } from "@/lib/refundLedger";
import { runReconciliation } from "@/lib/paymentReconciliation";
import { reconcileDeps, refundLedgerDeps } from "@/lib/refundProviders";

/**
 * Refunds and reconciliation (OS-3, 0080). Admin only.
 *
 * NOTHING HERE STARTS A REFUND. Refunds are made in Razorpay's dashboard by a
 * person. This route lets an admin:
 *   claim      record the refund id Razorpay's dashboard showed them, against
 *              an obligation — then immediately ask Razorpay about it;
 *   verify     ask Razorpay again about a refund already in the ledger;
 *   close      close an obligation WITHOUT a verified refund (Test-mode
 *              payment, or money returned outside Razorpay), with a reason;
 *   note       add a reconciliation note;
 *   resolve    resolve or accept a discrepancy, with a note;
 *   reconcile  run (or resume) a bounded, read-only reconciliation.
 *
 * WHO. adminApiGate (session alive, not idle) → same-origin → is_admin(),
 * which requires staff + aal2 + a live session (0067). claim / close / note /
 * resolve run AS THE ADMIN through their own session, so the database records
 * auth.uid() and enforces is_admin() itself. verify and reconcile need
 * Razorpay's answer, which only the server can obtain; they run with the
 * service role after the check above, and pass the admin's id as the actor.
 * An admin cannot submit an amount or a status anywhere: only a refund id.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  action?: string;
  obligationId?: string;
  refundId?: string;
  note?: string;
  kind?: string;
  reason?: string;
  discrepancyId?: number;
  resolution?: string;
  from?: string;
  to?: string;
  resumeFrom?: number | null;
};

export async function POST(request: NextRequest) {
  const ended = await adminApiGate(request);
  if (ended) return ended;
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Cross-site request refused." }, { status: 403 });

  const supabase = createRSCClient();
  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (isAdmin !== true) return new NextResponse("Not found", { status: 404 });
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Your session has ended." }, { status: 401 });

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  const asAdmin = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true, result: data });
  };

  switch (body.action) {
    case "claim": {
      const refundId = (body.refundId ?? "").trim();
      if (!body.obligationId || !REFUND_ID.test(refundId)) {
        return NextResponse.json({ error: "Give the obligation and a Razorpay refund id (rfnd_…)." }, { status: 400 });
      }
      const { data, error } = await supabase.rpc("admin_claim_refund", {
        p_obligation_id: body.obligationId,
        p_refund_id: refundId,
        p_note: body.note ?? null,
      });
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      // The id is saved (counts for nothing yet). Now ask Razorpay.
      const verified = await verifyAndRecordRefund(refundId, { source: "admin_verify", actor: user.id }, refundLedgerDeps());
      return NextResponse.json({ ok: true, claim: data, verification: verified });
    }
    case "verify": {
      const refundId = (body.refundId ?? "").trim();
      if (!REFUND_ID.test(refundId)) return NextResponse.json({ error: "Not a Razorpay refund id." }, { status: 400 });
      // Only refunds already in the ledger (read through the admin's own RLS).
      const { data: known } = await supabase
        .from("payment_refunds")
        .select("id")
        .eq("razorpay_refund_id", refundId)
        .maybeSingle();
      if (!known) return NextResponse.json({ error: "That refund id is not in the ledger. Record it against an obligation first." }, { status: 404 });
      const verified = await verifyAndRecordRefund(refundId, { source: "admin_verify", actor: user.id }, refundLedgerDeps());
      return NextResponse.json({ ok: verified.ok, verification: verified }, { status: verified.ok ? 200 : 502 });
    }
    case "close":
      return asAdmin("admin_close_refund_obligation", {
        p_obligation_id: body.obligationId ?? null,
        p_kind: body.kind ?? null,
        p_reason: body.reason ?? null,
      });
    case "note":
      return asAdmin("admin_add_refund_note", {
        p_obligation_id: body.obligationId ?? null,
        p_discrepancy_id: body.discrepancyId ?? null,
        p_note: body.note ?? null,
      });
    case "resolve":
      return asAdmin("admin_resolve_discrepancy", {
        p_id: body.discrepancyId ?? null,
        p_resolution: body.resolution ?? null,
        p_note: body.note ?? null,
      });
    case "reconcile": {
      const from = body.from ? new Date(body.from) : undefined;
      const to = body.to ? new Date(body.to) : undefined;
      if ((from && isNaN(from.getTime())) || (to && isNaN(to.getTime()))) {
        return NextResponse.json({ error: "Bad dates." }, { status: 400 });
      }
      const result = await runReconciliation(
        { from, to, resumeFrom: body.resumeFrom ?? null, actor: user.id, maxPages: 5 },
        reconcileDeps()
      );
      return NextResponse.json({ ok: result.ok, result }, { status: result.status === "not_started" ? 400 : 200 });
    }
    default:
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
}
