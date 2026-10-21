import sharp, { type OutputInfo } from "sharp";
import { sniffFormat } from "./imageNormalize";
import { STYLE_PHOTO_MAX_BYTES } from "./stylePhotoStorage";

/**
 * Proving a customer's "photograph" is one, on the server.
 *
 * The browser already re-encodes to JPEG (lib/stylePhoto.ts), but a browser is
 * not a boundary: anybody can post any bytes and call them image/jpeg, and
 * Storage only checks the label. So /api/style/submit runs every upload
 * through this before anything is stored:
 *
 *   1. the size, before reading further;
 *   2. the file's own signature must be JPEG — not the name, not the MIME type;
 *   3. libvips must decode it, under a pixel ceiling (a small file can claim
 *      enormous dimensions) and failing on any decoder warning;
 *   4. it is re-encoded from the decoded pixels as a FRESH JPEG.
 *
 * Step 4 is what makes the check worth having. Whatever rode along in the
 * original — a script appended after the image, an HTML payload in a comment,
 * EXIF with the customer's GPS position — is not in the output, because the
 * output is made from pixels only. What is stored is something we wrote.
 *
 * Server-only: imports sharp.
 */
export class StylePhotoRejected extends Error {}

/** Wider than the browser ever sends (2000); the ceiling, not the target. */
export const STYLE_PHOTO_MAX_WIDTH = 2000;
export const STYLE_PHOTO_MAX_HEIGHT = 4000;
/** Decoded-pixel ceiling: well above a 2000×4000 photo, far below a bomb. */
export const STYLE_PHOTO_MAX_INPUT_PIXELS = 40_000_000;

export interface NormalizedStylePhoto {
  jpeg: Buffer;
  width: number;
  height: number;
}

export async function normalizeStylePhoto(bytes: Uint8Array): Promise<NormalizedStylePhoto> {
  if (bytes.length === 0) throw new StylePhotoRejected("That file is empty. Please choose the photograph again.");
  if (bytes.length > STYLE_PHOTO_MAX_BYTES) {
    throw new StylePhotoRejected("That photograph is too large. Please choose it again and we'll shrink it.");
  }
  if (sniffFormat(bytes) !== "jpeg") {
    throw new StylePhotoRejected("That file isn't a photograph we can read. Please choose it again.");
  }

  let out: { data: Buffer; info: OutputInfo };
  try {
    const image = sharp(bytes, { limitInputPixels: STYLE_PHOTO_MAX_INPUT_PIXELS, failOn: "warning" });
    const meta = await image.metadata();
    if (meta.format !== "jpeg") throw new StylePhotoRejected("That file isn't a photograph we can read. Please choose it again.");
    out = await image
      .rotate() // honour the camera's orientation before the EXIF that carries it is dropped
      .resize({
        width: STYLE_PHOTO_MAX_WIDTH,
        height: STYLE_PHOTO_MAX_HEIGHT,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
  } catch (e) {
    if (e instanceof StylePhotoRejected) throw e;
    throw new StylePhotoRejected("That photograph couldn't be read. Please try another one.");
  }

  if (out.info.size > STYLE_PHOTO_MAX_BYTES) {
    throw new StylePhotoRejected("That photograph is too large. Please try one taken at a lower resolution.");
  }
  return { jpeg: out.data, width: out.info.width, height: out.info.height };
}

/**
 * The gallery's copy of an approved photograph: at most 1200 px wide.
 *
 * The gallery serves its copies unoptimised (so no long-lived optimizer cache
 * holds a photograph a customer may take down), which means every visitor gets
 * this one file. 1200 px covers the widest card at 2x and a phone at 3x, at
 * roughly a third of the bytes of the 2000 px original. Made from the original,
 * which normalizeStylePhoto already re-encoded, and re-encoded again here.
 */
export const STYLE_GALLERY_WIDTH = 1200;

export async function styleGalleryCopy(original: Uint8Array): Promise<Buffer> {
  return sharp(original, { limitInputPixels: STYLE_PHOTO_MAX_INPUT_PIXELS, failOn: "warning" })
    .resize({ width: STYLE_GALLERY_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
}
