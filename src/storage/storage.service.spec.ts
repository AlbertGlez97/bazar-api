import { resolve } from 'node:path';
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
