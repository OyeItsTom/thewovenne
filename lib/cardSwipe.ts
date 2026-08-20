/** Pure gesture decisions for ProductCard; the component only records points. */

export interface SwipeInput {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  index: number;
  imageCount: number;
  cancelled?: boolean;
  multiTouch?: boolean;
}
export interface SwipeDecision {
  kind: "tap" | "swipe" | "scroll" | "cancelled" | "ignored";
  nextIndex: number;
  suppressClick: boolean;
}

/** Direction shared by every mounted image: previous/current/next. */
export function cardImageOffset(imageIndex: number, currentIndex: number) {
  if (imageIndex < currentIndex) return -1 as const;
  if (imageIndex > currentIndex) return 1 as const;
  return 0 as const;
}

/** Movement below this is a tap, not a drag. Exported so the image viewer can
 *  recognise a tap by the same rule rather than inventing a second one. */
export const TAP_SLOP = 10;
const SWIPE_DISTANCE = 36;
const AXIS_BIAS = 1.15;

export function decideCardGesture(input: SwipeInput): SwipeDecision {
  const stay = input.index;
  if (input.cancelled) {
    return { kind: "cancelled", nextIndex: stay, suppressClick: false };
  }
  if (input.multiTouch || input.imageCount <= 1) {
    return { kind: "ignored", nextIndex: stay, suppressClick: false };
  }

  const dx = input.endX - input.startX;
  const dy = input.endY - input.startY;
  const x = Math.abs(dx);
  const y = Math.abs(dy);

  if (x <= TAP_SLOP && y <= TAP_SLOP) {
    return { kind: "tap", nextIndex: stay, suppressClick: false };
  }
  if (y >= x * AXIS_BIAS) {
    return { kind: "scroll", nextIndex: stay, suppressClick: false };
  }
  if (x < SWIPE_DISTANCE || x < y * AXIS_BIAS) {
    // Ambiguous movement is not a PDP tap. Suppress its synthetic click but do
    // not change the photograph.
    return { kind: "ignored", nextIndex: stay, suppressClick: true };
  }

  const wanted = dx < 0 ? stay + 1 : stay - 1;
  const nextIndex = Math.max(0, Math.min(input.imageCount - 1, wanted));
  return { kind: "swipe", nextIndex, suppressClick: true };
}
