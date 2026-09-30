import {
  BadRequestException,
  Injectable,
  PayloadTooLargeException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import sharp from 'sharp';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Names, in one place, the image formats this service will actually accept
 * and store — kept as a single source of truth so the controller/frontend
 * docs and any client-side validation can be described from the same list
 * instead of drifting from what the byte-signature/sharp checks below
 * really enforce.
 */
export const ACCEPTED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

const ACCEPTED_FORMATS_MESSAGE =
  'Unsupported image format. Only PNG, JPEG or WebP images are accepted.';

// ISO-BMFF `ftyp` major/compatible brands used by HEIC/HEIF photos (the
// default "high efficiency" format on modern phone cameras). Sharp's
// npm-distributed prebuilt libvips binary does NOT include HEVC/HEIC decode
// support (only AVIF) — see node_modules/sharp docs: "Support for
// patent-encumbered HEIC images requires the use of a globally-installed
// libvips compiled with support for libheif, libde265 and x265" — so these
// are rejected by signature before ever reaching sharp, with a message that
// tells the user what to do instead of a generic decode error.
const HEIC_BRANDS = new Set([
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
]);

function isHeicSignature(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  if (buffer.toString('ascii', 4, 8) !== 'ftyp') return false;
  return HEIC_BRANDS.has(buffer.toString('ascii', 8, 12));
}

/**
 * Internal marker for a decode/re-encode failure that already carries a
 * specific, user-facing explanation — as opposed to an unexpected sharp/
 * libvips error, which is never shown to the client verbatim.
 */
class InvalidImageError extends Error {}

/**
 * Storage is behind this interface (rather than ProductsService calling the
 * filesystem directly) so the local disk implementation can later be
 * swapped for an object store (e.g. MinIO) without touching the products
 * module — disk storage is a stopgap, not a long-term architectural
 * decision.
 */
export abstract class StorageService {
  abstract save(file: {
    buffer: Buffer;
    mimetype: string;
  }): Promise<{ path: string; url: string }>;
  abstract getUrl(key: string): string;
  abstract remove(key: string): Promise<void>;
}

@Injectable()
export class LocalStorageService extends StorageService {
  readonly root = resolve(process.env.PRODUCT_UPLOAD_DIR || 'uploads/products');
  private key(key: string) {
    // Keys are always our own randomUUID().png, never a client-supplied
    // filename; this also blocks path traversal (`../`) if a stored key is
    // ever passed back in from an untrusted source.
    if (!/^[0-9a-f-]{36}\.png$/.test(key))
      throw new BadRequestException('Invalid image key');
    return key;
  }
  getUrl(key: string) {
    return `/uploads/products/${this.key(key)}`;
  }
  async remove(key: string) {
    await unlink(join(this.root, this.key(key)));
  }
  /**
   * Validates and normalizes an uploaded image before it is ever written to
   * disk, then saves it under a fresh random name.
   *
   * The declared MIME type from the client is never trusted alone: the
   * byte signature and the actual decoded format (via sharp) must agree
   * with it, so a file renamed/relabeled to look like an image (e.g. an
   * SVG or HTML payload served with an `image/png` content-type) is
   * rejected rather than stored and served back with an image
   * content-type. Animated images (`pages > 1`) are rejected because the
   * product photo is a single still image, not a slideshow/GIF-like asset.
   * The image is always re-encoded to PNG (`.rotate().png()`) rather than
   * stored byte-for-byte, both to strip embedded metadata/orientation
   * quirks and so every stored file has one predictable, safe format
   * regardless of what was uploaded.
   *
   * @throws BadRequestException when the file is missing, its signature or
   * decoded format/MIME/page-count do not match an accepted still
   * PNG/JPEG/WebP, or the re-encoded result is invalid. HEIC/HEIF (and other
   * recognized-but-unsupported) rejections get a specific, actionable
   * message; a genuinely undecodable/corrupt buffer falls back to the
   * generic message below.
   * @throws PayloadTooLargeException when the raw upload exceeds
   * {@link MAX_IMAGE_BYTES} (the re-encoded size is checked separately and
   * surfaces as a BadRequestException, since by that point it is a
   * decoding/normalization outcome rather than a rejected raw upload).
   */
  async save(file: { buffer: Buffer; mimetype: string }) {
    if (!file?.buffer?.length)
      throw new BadRequestException('Image is required');
    if (file.buffer.length > MAX_IMAGE_BYTES)
      throw new PayloadTooLargeException();
    const signature = file.buffer;
    const png = signature
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg =
      signature[0] === 255 && signature[1] === 216 && signature[2] === 255;
    const webp =
      signature.toString('ascii', 0, 4) === 'RIFF' &&
      signature.toString('ascii', 8, 12) === 'WEBP';
    if (!png && !jpeg && !webp) {
      if (isHeicSignature(signature))
        throw new BadRequestException(
          'HEIC/HEIF images are not supported. Please export or share the ' +
            'photo as JPEG, PNG or WebP (on iPhone: Settings > Camera > ' +
            'Formats > Most Compatible) and try again.',
        );
      throw new BadRequestException(ACCEPTED_FORMATS_MESSAGE);
    }
    let bytes: Buffer;
    try {
      const image = sharp(file.buffer, {
        failOn: 'warning',
        limitInputPixels: 16_000_000,
      });
      const metadata = await image.metadata();
      const format = metadata.format;
      if (
        !['png', 'jpeg', 'webp'].includes(format ?? '') ||
        file.mimetype !== `image/${format}` ||
        (metadata.pages ?? 1) !== 1
      ) {
        throw new InvalidImageError(ACCEPTED_FORMATS_MESSAGE);
      }
      bytes = await image.rotate().png().toBuffer();
      if (bytes.length > MAX_IMAGE_BYTES)
        throw new InvalidImageError(
          'Image is too large after processing (over 5 MB once decoded). ' +
            'Try a smaller or lower-resolution photo.',
        );
    } catch (error) {
      if (error instanceof InvalidImageError)
        throw new BadRequestException(error.message);
      throw new BadRequestException(
        'Invalid, unsupported or oversized decoded image',
      );
    }
    const key = `${randomUUID()}.png`;
    await mkdir(this.root, { recursive: true });
    // 'wx' fails instead of overwriting if the random key were ever to
    // collide with an existing file, rather than silently clobbering it.
    const handle = await open(join(this.root, key), 'wx');
    try {
      await handle.writeFile(bytes);
    } catch (error) {
      await handle.close();
      await unlink(join(this.root, key));
      throw error;
    }
    await handle.close();
    return { path: key, url: this.getUrl(key) };
  }
}
