/**
 * YouTube URLs in, one ID out.
 *
 * The admin pastes whatever their browser gave them, which is one of at least
 * five shapes plus whatever tracking parameters were attached. Normalising once
 * on input means the embed never has to guess, and the database holds one kind
 * of thing rather than five.
 */

const ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * Returns the video ID, or null if there isn't one in there.
 *
 * Deliberately strict about the ID itself: eleven characters of a known
 * alphabet. A near-miss is far more likely to be a mistyped paste than a new
 * URL format, and storing it would produce a product page with a dead player
 * on it.
 */
export function youtubeId(input: string): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;

  // Already an ID.
  if (ID.test(raw)) return raw;

  let url: URL;
  try {
    url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "");

  // youtu.be/ID
  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0];
    return ID.test(id) ? id : null;
  }

  if (host !== "youtube.com" && host !== "m.youtube.com" && host !== "youtube-nocookie.com") {
    return null;
  }

  // youtube.com/watch?v=ID
  const v = url.searchParams.get("v");
  if (v && ID.test(v)) return v;

  // /embed/ID, /shorts/ID, /live/ID, /v/ID
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length >= 2 && ["embed", "shorts", "live", "v"].includes(parts[0])) {
    return ID.test(parts[1]) ? parts[1] : null;
  }

  return null;
}

/**
 * The thumbnail YouTube serves for a video.
 *
 * hqdefault exists for every video; maxresdefault does not, and a missing one
 * returns a grey placeholder image rather than a 404 — which would look like a
 * bug on the product page.
 */
export function youtubeThumbnail(id: string): string {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

/**
 * Privacy-preserving embed URL.
 *
 * youtube-nocookie.com, and no autoplay. The player is only ever inserted
 * after a deliberate click, so nothing from YouTube loads for a visitor who
 * never asked for the video.
 */
export function youtubeEmbedUrl(id: string): string {
  return `https://www.youtube-nocookie.com/embed/${id}?rel=0&modestbranding=1`;
}
