import { NextRequest, NextResponse } from "next/server";
import { streamChat, type ChatMessage } from "@/lib/chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * WhatsApp Business API webhook — SCAFFOLD / PLACEHOLDER.
 *
 * This routes inbound WhatsApp messages through the SAME shared chat handler as
 * the web widget (lib/chat → streamChat), so the WhatsApp bot answers in English
 * or Malayalam identically to "Ask Wovenne" on the site.
 *
 * ⚠️ NOT LIVE YET. To activate, you must:
 *   1. Connect a WhatsApp Business API provider (360dialog or Twilio) and point
 *      its webhook at  https://<your-domain>/api/whatsapp/webhook
 *   2. Set WHATSAPP_VERIFY_TOKEN in your env (and in the provider dashboard) so
 *      the GET verification handshake below succeeds.
 *   3. Map the provider's inbound payload shape to `ChatMessage[]` in POST (each
 *      provider formats messages differently — see parseInbound TODO below), and
 *      send the reply back via the provider's send-message API (TODO: sendReply).
 */

// GET — the verification handshake most providers (Meta/360dialog) perform once.
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  if (mode === "subscribe" && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(challenge ?? "", { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

// POST — inbound messages. Wired to the shared handler but intentionally inert
// until a provider is connected and parseInbound / sendReply are implemented.
export async function POST(req: NextRequest) {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ ok: true }); // ack malformed to avoid retries
  }

  // TODO(whatsapp): map the provider's inbound payload → { from, messages }.
  // e.g. Twilio sends form-encoded Body/From; 360dialog sends Meta's JSON shape.
  const parsed = parseInbound(payload);
  if (!parsed) return NextResponse.json({ ok: true });

  try {
    const stream = await streamChat(parsed.messages);
    const reply = (await stream.finalMessage()).content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");

    // TODO(whatsapp): send `reply` back to `parsed.from` via the provider's API.
    await sendReply(parsed.from, reply);
  } catch (err) {
    console.error("whatsapp webhook error:", err);
  }

  // Always 200 quickly so the provider doesn't retry.
  return NextResponse.json({ ok: true });
}

/** TODO(whatsapp): implement per-provider payload parsing. */
function parseInbound(
  _payload: unknown
): { from: string; messages: ChatMessage[] } | null {
  return null; // no provider connected yet
}

/** TODO(whatsapp): implement per-provider outbound send. */
async function sendReply(_to: string, _text: string): Promise<void> {
  // no-op until a provider (360dialog / Twilio) is wired up
}
