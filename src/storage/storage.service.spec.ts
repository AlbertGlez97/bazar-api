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
