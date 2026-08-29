/**
 * A model that does exactly what it is told, and cannot reach the network.
 *
 * ══ WHY SCRIPTED RATHER THAN RECORDED ══
 *
 * A recorded-cassette approach would replay real Anthropic responses, which
 * sounds more faithful and is worse here. Half of what we need to evaluate is
 * behaviour a real model will not produce on demand: a provider 500, a timeout,
 * a malformed tool call, usage metadata that will not parse, and a model that
 * asks for tools forever. You cannot record what you cannot provoke. A script
 * produces all of it, identically, every run.
 *
 * The trade is real and stated in the report: this measures THE LOOP, not the
 * model's judgement. Whether Sonnet picks the right tool is a live-eval
 * question. Whether the loop bounds it, bills it, refuses it and tells the
 * truth about it is this one — and that is the half that can leak data or spend
 * money.
 *
 * ══ NO NETWORK, STRUCTURALLY ══
 *
 * This class imports no HTTP client and holds no key. There is no code path
 * from here to a socket. That is a stronger guarantee than a mocked-out fetch,
 * because there is nothing to un-mock.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { ChatProvider, ChatProviderStream } from "../provider";
import type { ScriptedTurn } from "./types";

/** Usage a turn reports when it says nothing about usage. Small and readable. */
const DEFAULT_USAGE = {
  input_tokens: 900,
  output_tokens: 120,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

export class ScriptedProviderError extends Error {
  constructor(
    message: string,
    readonly kind: "provider_error" | "timeout" | "overloaded"
  ) {
    super(message);
    this.name =
      kind === "timeout"
        ? "APIConnectionTimeoutError"
        : kind === "overloaded"
          ? "APIStatusError"
          : "APIError";
  }
}

/**
 * Splits text into a few deltas rather than one.
 *
 * A single delta would let a bug that only shows up across chunks — a partial
 * write, a yield that drops the tail — pass unnoticed.
 */
function deltasFor(text: string): string[] {
  if (text.length === 0) return [];
  const size = Math.max(8, Math.ceil(text.length / 4));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export class ScriptedProvider implements ChatProvider {
  /** Every set of params the loop sent, in order. Inspectable by graders. */
  readonly requests: Anthropic.MessageStreamParams[] = [];
  private index = 0;

  constructor(private readonly turns: ScriptedTurn[]) {}

  /** How many model calls the loop actually made. */
  get callCount(): number {
    return this.requests.length;
  }

  stream(params: Anthropic.MessageStreamParams): ChatProviderStream {
    this.requests.push(params);

    // Running past the end is a script that did not anticipate the loop's
    // behaviour. Answering with a bland final message instead would silently
    // convert "the loop looped more than we expected" into a pass, which is
    // exactly the bug an execution-bounds case exists to catch.
    const turn = this.turns[this.index];
    this.index += 1;
    if (!turn) {
      throw new ScriptedProviderError(
        `the loop asked for model call ${this.index}, but the script defines only ${this.turns.length}`,
        "provider_error"
      );
    }

    const toolCalls = turn.toolCalls ?? [];
    const wantsTools = toolCalls.length > 0 || turn.malformed === true;

    const content: Anthropic.ContentBlock[] = [];
    if (turn.text) {
      content.push({ type: "text", text: turn.text, citations: null } as Anthropic.ContentBlock);
    }
    for (const [i, call] of toolCalls.entries()) {
      content.push({
        type: "tool_use",
        id: `toolu_scripted_${this.index}_${i}`,
        name: call.name,
        input: call.input,
      } as Anthropic.ContentBlock);
    }

    const message = {
      id: `msg_scripted_${this.index}`,
      type: "message",
      role: "assistant",
      model: params.model,
      content,
      stop_reason: wantsTools ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: turn.usage === undefined ? DEFAULT_USAGE : turn.usage,
    } as unknown as Anthropic.Message;

    const error = turn.error;
    const textDeltas = deltasFor(turn.text ?? "");

    return {
      async *[Symbol.asyncIterator]() {
        // Thrown from the iterator so it surfaces exactly where a real SDK
        // failure would — mid-stream, inside the loop's try.
        if (error) throw new ScriptedProviderError(error.message, error.type);
        for (const text of textDeltas) {
          yield {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text },
          } as Anthropic.MessageStreamEvent;
        }
      },
      async finalMessage() {
        if (error) throw new ScriptedProviderError(error.message, error.type);
        return message;
      },
    };
  }
}

/**
 * A provider that fails loudly if anything asks it for a model call.
 *
 * Used to prove a code path makes no model call at all — a disabled feature, a
 * refused budget. "No call happened" is otherwise indistinguishable from "the
 * assertion was never reached".
 */
export function forbiddenProvider(reason: string): ChatProvider {
  return {
    stream() {
      throw new Error(`FORBIDDEN MODEL CALL: ${reason}`);
    },
  };
}
