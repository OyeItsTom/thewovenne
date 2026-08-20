/**
 * The rules a product photograph is held to on its way into the catalogue.
 *
 * Everything here is pure: limits, container sniffing, the staging identity, the
 * resize arithmetic and the master's name. The route does the decoding and the
 * storage calls; this module is what can be tested without sharp, without a
 * bucket and without a session — which matters, because these are the rules that
 * decide whether an admin can be tricked into processing something, and whether
 * a photograph loses detail it will never get back.
 *
 * WHY ANY OF THIS EXISTS. A camera original off this catalogue is 13–27MB and
 * about 50 megapixels, and nothing on the site can display more than 1920 across
 * (next.config's deviceSizes ceiling, set in #132). So every product photograph
 * has been paying storage, egress and optimizer input cost for pixels no
 * customer has ever seen. Measured on twelve representative photographs, the
 * normalized master is ~21% of the original with no visible loss.
 */

/** Bumped when the pipeline's output would change. Part of the master's name. */
export const NORMALIZER_VERSION = 1;

/**
 * The short edge is the governing dimension, not the long one.
 *
 * The optimizer never emits more than 1920 across, and a portrait photograph is
 * served across its SHORT edge. Capping the long edge at 2400 — the obvious
 * reading — would leave a 3:4 portrait master 1800 wide, BELOW the ceiling, and
 * the storefront could never get a full-width variant again. Capping the short
 * edge at 2400 leaves 25% headroom above 1920 whatever the aspect ratio.
 *
 * The long-edge limit is a safety rail for panoramas, where holding the short
 * edge at 2400 would otherwise produce something enormous.
 */
export const TARGET_SHORT_EDGE = 2400;
export const MAX_LONG_EDGE = 4200;

/** Refused before anything expensive happens. */
export const MAX_INPUT_BYTES = 40 * 1024 * 1024;
export const MAX_INPUT_PIXELS = 80_000_000;
/** Smaller than this is not a product photograph; it is an icon or a mistake. */
export const MIN_EDGE = 200;

/** A year. Safe only because master names are content-addressed — see masterKey. */
export const MASTER_CACHE_CONTROL = "31536000";
/** Staging exists for seconds and is deleted. Nothing should hold on to it. */
export const STAGING_CACHE_CONTROL = "60";

export const STAGING_PREFIX = "staging";
export const MASTER_PREFIX = "products";

export type NormalizeFormat = "jpeg" | "png" | "webp" | "avif" | "gif";

export class ImageRejected extends Error {
  constructor(
    message: string,
    /** Short machine reason for the log; the message is what the admin reads. */
    readonly reason: string
  ) {
    super(message);
  }
}

/* ─────────────────────────────── container sniffing ─────────────────────── */

const HEIF_BRANDS = ["heic", "heix", "hevc", "hevx", "mif1", "msf1"];

/**
 * What the bytes actually are.
 *
 * The extension and the browser's `type` are both supplied by whoever is
 * uploading, and neither survives contact with a file that has been renamed.
 * This reads the container's own signature instead, which is the only claim the
 * file makes about itself that it cannot lie about without also being unreadable.
 */
export function sniffFormat(bytes: Uint8Array): NormalizeFormat | "heif" | null {
  const at = (i: number) => bytes[i] ?? -1;
  const ascii = (start: number, length: number) =>
    Array.from(bytes.slice(start, start + length))
      .map((b) => String.fromCharCode(b))
      .join("");

  if (bytes.length < 12) return null;

  // JPEG — including MPO, which is a JPEG carrying extra frames in APP2. The
  // catalogue is full of them: every phone original here sniffs as JPEG and
  // libvips decodes the primary frame, which is the photograph.
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "jpeg";

  if (
    at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 &&
    at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a
  ) {
    return "png";
  }

  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "webp";
  if (ascii(0, 3) === "GIF") return "gif";

  // ISO-BMFF: AVIF and HEIC share a container and differ only by brand.
  if (ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4).toLowerCase();
    if (brand === "avif" || brand === "avis") return "avif";
    if (HEIF_BRANDS.includes(brand)) return "heif";
  }

  return null;
}

/**
 * Sniff and decide, with the messages an admin should actually see.
 *
 * HEIC is recognised specifically so it can be refused for what it is. It is the
 * iPhone default, so "unsupported image" would be a mystery; the person needs to
 * know it is the phone's format setting, not their photograph.
 */
export function assertAcceptedFormat(bytes: Uint8Array): NormalizeFormat {
  const format = sniffFormat(bytes);
  if (format === "heif") {
    throw new ImageRejected(
      "iPhone HEIC photos aren't supported yet. On the phone: Settings → Camera → Formats → Most Compatible, or export the photo as JPEG and upload that.",
      "heif_not_supported"
    );
  }
  if (!format) {
    throw new ImageRejected(
      "That file doesn't look like an image we can read. Use a JPEG, PNG or WebP photograph.",
      "unknown_container"
    );
  }
  return format;
}

/* ─────────────────────────────── staging identity ───────────────────────── */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STAGING_EXT = ["jpg", "jpeg", "png", "webp", "avif", "gif"] as const;

/**
 * The staging object's key, built by the SERVER from two constrained values.
 *
 * THE CALLER NEVER SUPPLIES A PATH. It supplies a UUID and an extension, both
 * matched against a fixed pattern, and the key is assembled here. That is the
 * whole defence: `..`, an absolute path, a percent-encoded traversal, another
 * bucket's prefix and a `products/` master key are not rejected by a filter that
 * has to anticipate them — they are unrepresentable, because nothing the caller
 * sends is ever concatenated into a path.
 */
export function stagingKey(id: string, ext: string): string {
  const clean = (id ?? "").trim().toLowerCase();
  const extension = (ext ?? "").trim().toLowerCase().replace(/^\./, "");
  if (!UUID.test(clean)) {
    throw new ImageRejected("That upload could not be identified.", "bad_staging_id");
  }
  if (!(STAGING_EXT as readonly string[]).includes(extension)) {
    throw new ImageRejected("That upload could not be identified.", "bad_staging_ext");
  }
  return `${STAGING_PREFIX}/${clean}.${extension}`;
}

/* ──────────────────────────────── resize rules ──────────────────────────── */

export interface Dimensions {
  width: number;
  height: number;
}

/**
 * The size to write, given the size the photograph is actually DISPLAYED at.
 *
 * Callers must pass display dimensions — width and height already swapped for an
 * EXIF orientation of 5 to 8 — because a portrait photograph stored sideways
 * would otherwise be measured on the wrong edge and resized to the wrong shape.
 *
 * NEVER ENLARGES. A 1122px original stays 1122px: scaling it up would cost bytes
 * and add nothing, and the catalogue genuinely contains sources below the target.
 */
export function targetSize(display: Dimensions): Dimensions {
  const { width, height } = display;
  if (width <= 0 || height <= 0) {
    throw new ImageRejected("That photograph has no usable size.", "zero_dimension");
  }
  const scale = Math.min(
    1,
    TARGET_SHORT_EDGE / Math.min(width, height),
    MAX_LONG_EDGE / Math.max(width, height)
  );
  if (scale >= 1) return { width: Math.round(width), height: Math.round(height) };
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Whether the photograph is being resized at all, for the log and the tests. */
export function needsResize(display: Dimensions): boolean {
  const t = targetSize(display);
  return t.width !== Math.round(display.width) || t.height !== Math.round(display.height);
}

export function assertUsableSource(display: Dimensions): void {
  const pixels = display.width * display.height;
  if (pixels > MAX_INPUT_PIXELS) {
    throw new ImageRejected(
      "That photograph is too large to process. Please use one under 80 megapixels.",
      "too_many_pixels"
    );
  }
  if (Math.min(display.width, display.height) < MIN_EDGE) {
    throw new ImageRejected(
      `That image is only ${display.width}×${display.height}. Product photographs need to be at least ${MIN_EDGE}px on the short side.`,
      "too_small"
    );
  }
}

export function assertUsableBytes(size: number): void {
  if (size <= 0) throw new ImageRejected("That file is empty.", "empty");
  if (size > MAX_INPUT_BYTES) {
    throw new ImageRejected(
      `That file is ${(size / 1048576).toFixed(0)}MB. Please use a photograph under ${MAX_INPUT_BYTES / 1048576}MB.`,
      "too_many_bytes"
    );
  }
}

/* ──────────────────────────────── the master ────────────────────────────── */

/**
 * A master's name, derived from what it contains.
 *
 * CONTENT-ADDRESSED SO A RETRY IS FREE. The same source normalized by the same
 * pipeline version always lands on the same key, so a retried or double-clicked
 * upload finds the object already there instead of producing master-A, master-B
 * and master-C for one photograph. `upsert: false` then makes "already exists"
 * the successful case rather than a collision to resolve.
 *
 * THE VERSION IS IN THE NAME because the hash describes the SOURCE, not the
 * output. When the pipeline changes, the same source must produce a different
 * key or the old master would be served forever under a name that claims to
 * describe the new one.
 *
 * NOTE FOR WHOEVER WRITES THE ORPHAN SWEEP. Two products uploading the identical
 * file share one object. Cleanup must therefore count references across the
 * catalogue, never delete per-product.
 */
export function masterKey(sourceSha256: string, ext: "jpg" | "webp"): string {
  const hash = (sourceSha256 ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new ImageRejected("That photograph could not be identified.", "bad_hash");
  }
  return `${MASTER_PREFIX}/${hash.slice(0, 32)}-v${NORMALIZER_VERSION}.${ext}`;
}

/**
 * JPEG unless the photograph genuinely carries transparency.
 *
 * A product cut out against nothing is a real thing and flattening it onto white
 * would be destructive, so alpha takes a lossless WebP master instead. This is
 * decided from whether the alpha channel is ACTUALLY used, not from whether the
 * file format has one: a PNG with a fully opaque alpha channel is a photograph
 * somebody exported carelessly, and it should compress like one.
 */
export function masterEncoding(hasRealAlpha: boolean): {
  ext: "jpg" | "webp";
  contentType: string;
} {
  return hasRealAlpha
    ? { ext: "webp", contentType: "image/webp" }
    : { ext: "jpg", contentType: "image/jpeg" };
}

/** The encoder settings the quality gate was measured against. */
export const JPEG_MASTER = {
  quality: 92,
  chromaSubsampling: "4:4:4" as const,
  progressive: true,
};
