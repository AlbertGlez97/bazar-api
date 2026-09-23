import type { NestExpressApplication } from '@nestjs/platform-express';
import { LocalStorageService } from './storage.service.js';

export function configureStaticStorage(app: NestExpressApplication) {
  app.useStaticAssets(app.get(LocalStorageService).root, {
    prefix: '/uploads/products/',
    index: false,
    redirect: false,
    dotfiles: 'deny',
    setHeaders: (response) => {
      // Uploaded images are served from the same origin as the API; these
      // headers stop a browser from ever executing a served file as script
      // or HTML even if content-sniffing or a mislabeled MIME type would
      // otherwise allow it (defense in depth beyond the upload-time
      // signature/format checks in LocalStorageService.save).
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; sandbox",
      );
    },
  });
}
