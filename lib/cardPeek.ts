export type PeekStage = "idle" | "waiting" | "peeking" | "returning" | "done";

export type PeekAction =
  | "visible"
  | "hidden"
  | "timer"
  | "return"
  | "complete"
  | "interact";

export interface PeekContext {
  imageCount: number;
  reducedMotion: boolean;
}

/** Pure lifecycle for the one-time, non-navigating gallery discovery peek. */
export function nextPeekStage(
  stage: PeekStage,
  action: PeekAction,
  context: PeekContext
): PeekStage {
  if (stage === "done") return "done";
  if (action === "interact") return "done";
  if (context.imageCount <= 1 || context.reducedMotion) return "done";

  if (stage === "idle" && action === "visible") return "waiting";
  if (stage === "waiting" && action === "timer") return "peeking";
  if (stage === "peeking" && action === "return") return "returning";
  if (stage === "returning" && action === "complete") return "done";

  // Leaving before the timer or during the movement cancels this card's one
  // opportunity. It cannot restart when the customer scrolls back.
  if (action === "hidden" && stage !== "idle") return "done";
  return stage;
}
