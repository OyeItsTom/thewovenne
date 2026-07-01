import { NextRequest } from "next/server";
import { streamChat, type ChatMessage } from "@/lib/chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Ask Wovenne" web chat endpoint. Streams the assistant's reply back as plain
 * text tokens so the widget can render it live. Order tracking is gated on an
 * exact orderId + email match (handled in lib/chat).
 */
export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return new Response("Chat is not configured yet.", { status: 503 });
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
        try {
          claudeStream.on("text", (delta: string) => {
            controller.enqueue(encoder.encode(delta));
          });
          await claudeStream.finalMessage();
          controller.close();
        } catch (err) {
          console.error("chat stream error:", err);
          controller.error(err);
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
