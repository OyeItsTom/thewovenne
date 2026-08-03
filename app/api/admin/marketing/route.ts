import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { SUPABASE_URL, SUPABASE_ANON_KEY, createServiceClient } from "@/lib/supabase";
import { sendEmail, emailConfigured } from "@/lib/email";
import { getMarketingTargets, TRIGGERS, type MarketingTrigger } from "@/lib/marketing";
import {
  marketingHtml, marketingText, TRIGGER_SUBJECT,
} from "@/lib/emails/marketing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Send a marketing email to everyone eligible for one trigger.
 *
 * Gated here, not by middleware — the matcher covers /admin and /account, so
 * /api/admin/* is not intercepted and relying on it would leave this open to
 * anyone who guessed the path.
 *
 * CONSENT IS CHECKED TWICE, and neither check is the admin screen's filter.
 * marketing_targets() returns only consented account-holders, and
 * record_marketing_send() re-checks immediately before each send — a list built
 * a minute ago cannot outlive a withdrawal made since. The recording is what
 * authorises the send, not the other way round: if it returns false, nothing
 * goes out.
 */
export async function POST(req: NextRequest) {
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
  if (!user) return new NextResponse("Not found", { status: 404 });

  const { data: isAdmin, error: adminError } = await supabase.rpc("is_admin");
  if (adminError || isAdmin !== true) {
    return new NextResponse("Not found", { status: 404 });
  }

  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (!(aal?.nextLevel === "aal2" && aal.currentLevel === "aal2")) {
    return NextResponse.json(
      { error: "Finish two-factor verification first." },
      { status: 403 }
    );
  }

  if (!emailConfigured()) {
    return NextResponse.json(
      { error: "Email isn't configured — RESEND_API_KEY is missing." },
      { status: 503 }
    );
  }

  let body: { trigger?: string; dryRun?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const trigger = body.trigger as MarketingTrigger;
  if (!TRIGGERS.includes(trigger)) {
    return NextResponse.json({ error: "Unknown trigger." }, { status: 400 });
  }

  const admin = createServiceClient();
  const targets = await getMarketingTargets(admin, trigger);

  // A dry run answers "who would this reach" without sending anything. The
  // admin screen uses it, so pressing Send is never the first time anyone finds
  // out how many people are involved.
  if (body.dryRun) {
    return NextResponse.json({
      dryRun: true,
      count: targets.length,
      recipients: targets.map((t) => t.email),
    });
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://www.thewovenne.com";
  let sent = 0;
  let skipped = 0;
  const failures: string[] = [];

  for (const target of targets) {
    // Recorded BEFORE sending. If consent was withdrawn since the list was
    // built this returns false and nothing is sent — the wrong order here
    // would mean an email going out and then discovering it should not have.
    const { data: allowed } = await admin.rpc("record_marketing_send", {
      p_user_id: target.user_id,
      p_trigger: trigger,
      p_subject: TRIGGER_SUBJECT[trigger],
      p_resend_id: null,
      p_sent_by: user.id,
    });

    if (allowed !== true) {
      skipped += 1;
      continue;
    }

    const result = await sendEmail({
      to: target.email,
      subject: TRIGGER_SUBJECT[trigger],
      html: marketingHtml(trigger, target.name ?? "", target.items, siteUrl),
      text: marketingText(trigger, target.name ?? "", target.items, siteUrl),
    });

    if (result.ok) {
      sent += 1;
      if (result.id) {
        await admin
          .from("marketing_sends")
          .update({ resend_id: result.id })
          .eq("user_id", target.user_id)
          .eq("trigger", trigger)
          .is("resend_id", null);
      }
    } else {
      // The row stays. It records an attempt, and the cooldown it creates is a
      // feature: a provider having a bad minute should not turn into a retry
      // loop that mails someone repeatedly.
      failures.push(target.email);
    }
  }

  return NextResponse.json({ sent, skipped, failed: failures.length, failures });
}
