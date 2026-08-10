import { youtubeId } from "./youtube";

/**
 * What a customer may send us, and how it is shown.
 *
 * Pure functions and constants, no client and no network, so the submission
 * form, the gallery, the admin queue and the tests all agree about what a valid
 * link is and what guidance customers are given. Duplicating any of this in a
 * component is how the form starts accepting something the gallery cannot draw.
 */

// ══ Photograph guidance ═══════════════════════

/**
 * GUIDANCE, NOT RULES — the distinction is the whole point.
 *
 * Customers are sending a photo of themselves in a shirt, taken on a phone, not
 * delivering assets. So the recommended size is stated, undersized photographs
 * are accepted anyway with a gentle note, and only the things that genuinely
 * break are refused: a file we cannot decode, or one big enough to fail the
 * upload. A form that rejects a good photograph for being 900px tall costs a
 * submission and gains nothing.
 */
export const PHOTO_GUIDANCE = {
  /** The shape our layout is built around. Portrait, because people are. */
  recommendedWidth: 1200,
  recommendedHeight: 1500,
  /** Below this the photograph will look soft at full width. Advisory only. */
  minComfortableWidth: 800,
  /** Anything larger is downscaled in the browser before it is uploaded. */
  maxUploadWidth: 2000,
  /** After downscaling, nothing should come near this. Refused if it does. */
  maxBytes: 8 * 1024 * 1024,
  /**
   * HEIC IS ACCEPTED HERE AND NOWHERE ELSE IN THE CODEBASE, and it is not a
   * contradiction of lib/storage.ts. That module refuses HEIC because Chrome,
   * Firefox and Edge cannot render it, so storing one produces a broken image
   * for most visitors. The submission path never stores it: every photograph is
   * drawn to a canvas and re-encoded as JPEG on the way out, and a browser that
   * can decode HEIC — Safari, i.e. the iPhone that produced it — therefore
   * uploads a JPEG. A browser that cannot decode it fails at that step and is
   * told what to do, which is the same outcome as refusing the extension but
   * without turning away the phone photographs this feature exists for.
   */
  acceptAttribute: "image/jpeg,image/png,image/webp,image/heic,image/heif",
  /** What the form says, kept here so the copy and the numbers cannot drift. */
  get help(): string {
    return `Around ${this.recommendedWidth}×${this.recommendedHeight} or larger looks best — but a phone photo is perfect, it doesn't need to be a shoot. Daylight and a plain background photograph beautifully. JPEG, PNG, WebP or an iPhone HEIC, up to ${Math.round(
      this.maxBytes / (1024 * 1024)
    )}MB.`;
  },
} as const;

/**
 * Whether a photograph will look soft at the size we draw it. Never a refusal —
 * the form says so and uploads it anyway.
 *
 * JUDGED ON THE WIDTH, not the longest edge. A gallery column has a fixed width
 * and lets height do what it likes, so a 640×800 portrait is stretched across
 * more pixels than it has and looks soft, while a 1200×600 landscape at the same
 * column width is fine. Measuring the longest edge would call the first one
 * comfortable, which is exactly backwards.
 */
export function isBelowComfortable(width: number | null, height: number | null): boolean {
  if (!width || !height) return false;
  return width < PHOTO_GUIDANCE.minComfortableWidth;
}

// ══ Video links ═══════════════════════════════

export type StylePlatform = "instagram" | "youtube";

export interface StyleLink {
  platform: StylePlatform;
  /** Canonical URL — what gets stored and what the button opens. */
  url: string;
  /**
   * A thumbnail we can draw, or null when there is not one to be had.
   *
   * YOUTUBE HAS ONE AND INSTAGRAM DOES NOT, and that asymmetry is deliberate
   * rather than unfinished. YouTube serves thumbnails from a predictable address
   * with no key and no agreement. Instagram's oEmbed now requires a Meta app
   * with oEmbed Read approval — a review process, not a token — so the honest
   * options were to block this feature on Meta's review queue, ask customers to
   * upload a still they have already posted, or show Instagram links as a card
   * with the caption and a button. The card was chosen: nothing is faked, and
   * the customer's Reel is one tap away.
   */
  thumbnailUrl: string | null;
  /** Platform id where we have one. Kept for building the thumbnail. */
  id: string | null;
}

const INSTAGRAM_HOSTS = ["instagram.com", "instagr.am"];
/** Shortcodes are 11ish characters of the URL-safe alphabet. */
const INSTAGRAM_SHORTCODE = /^[A-Za-z0-9_-]{5,32}$/;

/**
 * Recognise what a customer pasted, or refuse it.
 *
 * ONLY INSTAGRAM AND YOUTUBE, because those are the two the brief names and
 * because every accepted host is one whose embedded content we would be
 * publishing beside our own. Returns null for anything else, including a bare
 * domain or a link to a profile rather than a post — a profile is not a piece of
 * content and would show a customer's whole feed under our name.
 */
export function parseStyleLink(input: string): StyleLink | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();

  // ── YouTube ──
  // Delegated to lib/youtube.ts rather than re-parsed: the product video already
  // solved the five-URL-shapes problem and a second parser would drift from it.
  if (host.includes("youtu")) {
    const id = youtubeId(raw);
    if (!id) return null;
    return {
      platform: "youtube",
      url: `https://www.youtube.com/watch?v=${id}`,
      // hqdefault, not maxresdefault: maxres does not exist for every video and
      // 404s as a broken image, while hqdefault is always generated.
      thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      id,
    };
  }

  // ── Instagram ──
  if (INSTAGRAM_HOSTS.includes(host)) {
    const parts = url.pathname.split("/").filter(Boolean);
    // /p/<code>, /reel/<code>, /reels/<code>, /tv/<code>. A bare /<username> is
    // a profile, not a post, and is refused.
    const kind = parts[0]?.toLowerCase();
    if (!["p", "reel", "reels", "tv"].includes(kind ?? "")) return null;
    const code = parts[1];
    if (!code || !INSTAGRAM_SHORTCODE.test(code)) return null;
    // Normalised to /reel/ for reels and /p/ for posts, without the query string
    // — Instagram links arrive carrying igsh tracking parameters.
    const path = kind === "tv" ? "tv" : kind === "p" ? "p" : "reel";
    return {
      platform: "instagram",
      url: `https://www.instagram.com/${path}/${code}/`,
      thumbnailUrl: null,
      id: code,
    };
  }

  return null;
}

/** "Watch on YouTube" / "Watch on Instagram", for the button. */
export function watchLabel(platform: StylePlatform): string {
  return platform === "youtube" ? "Watch on YouTube" : "Watch on Instagram";
}

/**
 * What the form tells someone whose link was not understood.
 *
 * Names the two platforms and the shape of a link rather than saying "invalid":
 * the most common cause is pasting a profile instead of a post, and "invalid
 * URL" leaves them retrying the same thing.
 */
export const LINK_HELP =
  "Paste the link to a single Instagram post or Reel, or a YouTube video — not your profile page.";
