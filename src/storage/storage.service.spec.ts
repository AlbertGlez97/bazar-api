import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { LocalStorageService } from './storage.service.js';

it('uses the safe default upload directory for a blank example environment value', () => {
  const saved = process.env.PRODUCT_UPLOAD_DIR;
  try {
    process.env.PRODUCT_UPLOAD_DIR = '';
    expect(new LocalStorageService().root).toBe(resolve('uploads/products'));
  } finally {
    if (saved === undefined) delete process.env.PRODUCT_UPLOAD_DIR;
    else process.env.PRODUCT_UPLOAD_DIR = saved;
  }
});

describe('LocalStorageService#save image format rejection', () => {
  // Minimal ISO-BMFF `ftyp` box with a HEIC major brand — enough for our
  // byte-signature sniffing to recognize it as HEIC/HEIF without needing a
  // real (patent-encumbered) HEIC codec payload.
  function heicBuffer() {
    return Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]), // box size
      Buffer.from('ftyp', 'ascii'),
      Buffer.from('heic', 'ascii'), // major brand
      Buffer.from([0x00, 0x00, 0x00, 0x00]), // minor version
      Buffer.from('mif1heic', 'ascii'), // compatible brands
    ]);
  }

  it('rejects a HEIC/HEIF upload with a specific, friendly message', async () => {
    const service = new LocalStorageService();
    await expect(
      service.save({ buffer: heicBuffer(), mimetype: 'image/heic' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('HEIC/HEIF'),
    });
  });

  it('rejects a non-image, non-HEIC upload with the generic format message', async () => {
    const service = new LocalStorageService();
    await expect(
      service.save({
        buffer: Buffer.from('<html>bad</html>'),
        mimetype: 'image/png',
      }),
    ).rejects.toMatchObject({
      message: 'Unsupported image format. Only PNG, JPEG or WebP images are accepted.',
    });
  });
});

describe('LocalStorageService#save JPEG mimetype handling', () => {
  async function jpegBuffer() {
    return sharp({
      create: { width: 8, height: 8, channels: 3, background: '#cc3300' },
    })
      .jpeg()
      .toBuffer();
  }

  async function withTempService(run: (service: LocalStorageService) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), 'bazar-storage-'));
    const saved = process.env.PRODUCT_UPLOAD_DIR;
    process.env.PRODUCT_UPLOAD_DIR = dir;
    try {
      await run(new LocalStorageService());
    } finally {
      if (saved === undefined) delete process.env.PRODUCT_UPLOAD_DIR;
      else process.env.PRODUCT_UPLOAD_DIR = saved;
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('accepts a JPEG declared as image/jpg as an alias of image/jpeg', async () => {
    await withTempService(async (service) => {
      await expect(
        service.save({ buffer: await jpegBuffer(), mimetype: 'image/jpg' }),
      ).resolves.toMatchObject({ path: expect.stringMatching(/\.png$/) });
    });
  });

  it('accepts a JPEG whose declared mimetype names another format', async () => {
    await withTempService(async (service) => {
      await expect(
        service.save({ buffer: await jpegBuffer(), mimetype: 'image/png' }),
      ).resolves.toMatchObject({ path: expect.stringMatching(/\.png$/) });
    });
  });

  it('accepts a WebP declared as image/jpg', async () => {
    await withTempService(async (service) => {
      const webp = await sharp({
        create: { width: 8, height: 8, channels: 3, background: '#0033cc' },
      })
        .webp()
        .toBuffer();
      await expect(
        service.save({ buffer: webp, mimetype: 'image/jpg' }),
      ).resolves.toMatchObject({ path: expect.stringMatching(/\.png$/) });
    });
  });

  it.each(['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'])(
    'rejects a non-PNG/JPEG/WebP file regardless of declared mimetype (%s)',
    async (mimetype) => {
      await withTempService(async (service) => {
        const gif = await sharp({
          create: { width: 8, height: 8, channels: 3, background: '#00cc33' },
        })
          .gif()
          .toBuffer();
        await expect(service.save({ buffer: gif, mimetype })).rejects.toMatchObject({
          message: 'Unsupported image format. Only PNG, JPEG or WebP images are accepted.',
        });
      });
    },
  );
});
