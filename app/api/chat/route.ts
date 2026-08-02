import { NextRequest } from "next/server";
import { streamChat, chatConfigured, type ChatMessage } from "@/lib/chat";

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

  try {
    const claudeStream = await streamChat(messages, {
      orderId: body.orderId,
      email: body.email,
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let sentAnything = false;
        try {
          claudeStream.on("text", (delta: string) => {
            sentAnything = true;
            controller.enqueue(encoder.encode(delta));
          });
          await claudeStream.finalMessage();
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
