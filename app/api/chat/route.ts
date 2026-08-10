import { NextRequest } from "next/server";
import { streamChat, chatConfigured, type ChatMessage } from "@/lib/chat";
import {
  anonymousCaller,
  consumeChatQuota,
  quotaMessage,
  signedInCaller,
} from "@/lib/chatQuota";
import { createRSCClient } from "@/lib/supabaseRSC";
import { getStoreSettings } from "@/lib/storeSettings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Ask Wovenne" web chat endpoint. Streams the assistant's reply back as plain
 * text tokens so the widget can render it live. Order tracking is gated on an
 * exact orderId + email match (handled in lib/chat).
 */
export async function POST(req: NextRequest) {
  // Checked before anything streams: once the response has started the status
  // code is already sent, and a key problem can only be reported in-band.
  if (!chatConfigured()) {
    console.error(
      "chat: ANTHROPIC_API_KEY is missing or not a real key — the concierge is disabled."
    );
    return new Response(
      "Ask Wovenne isn't set up yet. Please message us on WhatsApp and we'll help straight away.",
      { status: 503 }
    );
  }

  let body: {
    messages?: ChatMessage[];
    orderId?: string | null;
    email?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid request body.", { status: 400 });
  }

  const messages = (body.messages ?? []).filter(
    (m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
  );
  if (messages.length === 0) {
    return new Response("No messages provided.", { status: 400 });
  }

  // The admin switch is checked on the server, not just by hiding the widget:
  // this endpoint is public, and a hidden widget still leaves it answering
  // anyone who calls it directly.
  const settings = await getStoreSettings();
  if (!settings.ask_wovenne_enabled) {
    return new Response(
      "Ask Wovenne is unavailable at the moment. Please message us on WhatsApp and we'll help straight away.",
      { status: 503 }
    );
  }

  // Enforced HERE rather than in the widget. A cap the browser applies is a
  // suggestion — this endpoint is public, and anything worth rate-limiting
  // against will call it directly rather than through the UI.
  //
  // Checked after validation but before the model call, so a rejected request
  // costs nothing, and a malformed one doesn't spend the caller's allowance.
  //
  // WHO IS ASKING IS DECIDED FROM THE SESSION COOKIE, NOT FROM THE BODY. A
  // signed-in customer gets the larger allowance; the browser cannot claim it by
  // sending a user id, because nothing here reads one. A failed session read is
  // treated as anonymous — the cautious direction, and the same conflation the
  // admin middleware was fixed for is not a risk here, since the consequence is
  // a smaller allowance rather than a denial.
  //
  // ONE MESSAGE COSTS ONE MESSAGE, whatever the concierge does next. A reply that
  // needs three lookups is three model calls and still a single spend — the cap
  // is on what the customer asked for, not on how hard the answer was to find.
  let caller = anonymousCaller(req);
  // The email is kept for the concierge as well as the quota: it is what turns
  // order tracking on. Verified here and passed down, never read from the body —
  // an email in a request body is a claim, and the concierge would be looking up
  // orders against it.
  let verifiedEmail: string | null = null;
  try {
    const {
      data: { user },
    } = await createRSCClient().auth.getUser();
    if (user) {
      caller = signedInCaller(user.id);
      verifiedEmail = user.email ?? null;
    }
  } catch (err) {
    console.error("chat: session read failed, treating as anonymous:", err);
  }

  const quota = await consumeChatQuota(caller);
  if (!quota.allowed) {
    return new Response(quotaMessage(quota.resetAt), {
      status: 429,
      headers: { "Retry-After": "600" },
    });
  }

  try {
    const replyStream = streamChat(messages, {
      orderId: body.orderId,
      // The session's address wins over anything the browser sent. The body form
      // still works for a caller that supplies both an id and an email (the
      // WhatsApp path, one day), but a signed-in customer never has to type
      // theirs — and cannot be talked into typing somebody else's.
      email: verifiedEmail ?? body.email,
      // Only the misses are logged. A tool that found what it was asked for is
      // the system working; a tool that found nothing is either a gap in the
      // catalogue or a piece whose story nobody has written yet, and both are
      // worth seeing without reading every transcript.
      onTool: (name, found) => {
        if (!found) console.warn(`concierge: ${name} found nothing`);
      },
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let sentAnything = false;
        try {
          // A generator now, not one Anthropic stream: a single customer message
          // can become several model calls with lookups between them, and this
          // side neither knows nor cares how many. Text arrives in order.
          for await (const delta of replyStream) {
            sentAnything = true;
            controller.enqueue(encoder.encode(delta));
          }
          controller.close();
        } catch (err) {
          // The status line has already gone out, so erroring the stream just
          // drops the connection and the widget shows nothing. Say something
          // useful instead and close cleanly; the log is what raises the alarm.
          console.error("chat stream error:", err);
          if (!sentAnything) {
            controller.enqueue(
              encoder.encode(
                "Sorry — I can't reach my notes just now. Please try again, or message us on WhatsApp and we'll help straight away."
              )
            );
          }
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  } catch (err) {
    console.error("chat route error:", err);
    return new Response("Sorry — Ask Wovenne is unavailable right now.", {
      status: 500,
    });
  }
}
