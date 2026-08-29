/**
 * The one seam between the chat loop and the model.
 *
 * ══ WHY THIS EXISTS AT ALL ══
 *
 * `lib/chat.ts` builds its Anthropic client at module scope. That is fine for
 * production — one client per process is exactly right — but it means the loop
 * and the provider are welded together, and a test can only exercise the loop
 * by talking to Anthropic. An evaluation suite that costs money and needs a
 * network is an evaluation suite nobody runs.
 *
 * So the loop now takes an OPTIONAL provider. Absent, it uses the real client
 * and behaves exactly as it did before — the web route and the WhatsApp path
 * both pass nothing. Present, the loop is unchanged in every other respect and
 * the calls go wherever the caller says.
 *
 * ══ WHY THE INTERFACE IS SHAPED LIKE THE SDK ══
 *
 * This deliberately mirrors `anthropic.messages.stream(...)` rather than
 * inventing a tidier abstraction. The point of an evaluation is to exercise the
 * REAL loop; every difference between this interface and the SDK's is a place
 * where the thing under test stops being the thing that ships. So it returns an
 * async-iterable with a `finalMessage()`, because that is what the loop
 * consumes, and the production adapter below is a one-line pass-through.
 *
 * NOTHING HERE IS AN EVALUATION CONCERN. This file names no fixture, no case
 * and no scripted behaviour — it is the seam, not what gets pushed through it.
 */

import type Anthropic from "@anthropic-ai/sdk";

/**
 * A model stream, as the loop consumes it: iterate for deltas, then ask for the
 * assembled message.
 */
export interface ChatProviderStream
  extends AsyncIterable<Anthropic.MessageStreamEvent> {
  finalMessage(): Promise<Anthropic.Message>;
}

/** Anything that can answer a model call. */
export interface ChatProvider {
  stream(params: Anthropic.MessageStreamParams): ChatProviderStream;
}

/**
 * The production provider: the real SDK, wrapped and nothing more.
 *
 * Built lazily by the caller rather than here, so importing this module never
 * requires a key to be present.
 */
export function anthropicProvider(client: Anthropic): ChatProvider {
  return {
    stream: (params) => client.messages.stream(params) as ChatProviderStream,
  };
}
