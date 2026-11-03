import { NextRequest, NextResponse } from "next/server";
import { cronAuthorised } from "@/lib/cronAuth";
import { runConfirmationRecovery } from "@/lib/orderConfirmationRecovery";

/**
 * Order-confirmation recovery (WP-EMAIL-R1c-min).
 *
 * Called by the scheduler and by an authorised operator with the same bearer
 * token; both run the same bounded pass (lib/orderConfirmationRecovery).
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/order-confirmations
 *
 * 401 without a valid token, and when CRON_SECRET is not configured (fails
 * closed). 200 when the pass ran; 503 when email is not configured (nothing
 * was attempted); 500 when the pass could not run. The body is counts only.
 *
 * GET only — Vercel Cron uses GET. Never cached, never redirected (the
 * middleware matcher excludes /api).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

export async function GET(request: NextRequest) {
  if (!cronAuthorised(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    if (!process.env.CRON_SECRET || process.env.CRON_SECRET.length < 32) {
      console.error("Confirmation recovery: CRON_SECRET is not configured (or too short); refusing.");
    }
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const report = await runConfirmationRecovery();
  console.log(
    "Confirmation recovery:",
    JSON.stringify({
      ok: report.ok,
      error: report.error,
      emailConfigured: report.emailConfigured,
      staleClosed: report.staleClosed,
      orphansEnqueued: report.orphansEnqueued,
      attempted: report.attempted,
      outcomes: report.outcomes,
      stoppedEarly: report.stoppedEarly,
      summary: report.summary,
      durationMs: report.durationMs,
    })
  );

  const status = report.error ? 500 : report.emailConfigured ? 200 : 503;
  return NextResponse.json(report, { status, headers: NO_STORE });
}
