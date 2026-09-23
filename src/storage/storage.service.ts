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
  readonly root = resolve(process.env.PRODUCT_UPLOAD_DIR ?? 'uploads/products');
  private key(key: string) {
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
    if (!png && !jpeg && !webp)
      throw new BadRequestException('Unsupported image signature');
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
        throw new Error(
          'Only nonanimated PNG/JPEG/WebP with matching MIME are accepted',
        );
      }
      bytes = await image.rotate().png().toBuffer();
      if (bytes.length > MAX_IMAGE_BYTES)
        throw new Error('Normalized image exceeds 5 MiB');
    } catch {
      throw new BadRequestException(
        'Invalid, unsupported or oversized decoded image',
      );
    }
    const key = `${randomUUID()}.png`;
    await mkdir(this.root, { recursive: true });
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
