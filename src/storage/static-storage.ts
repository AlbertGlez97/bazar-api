import type { NestExpressApplication } from '@nestjs/platform-express';
import { LocalStorageService } from './storage.service.js';

export function configureStaticStorage(app: NestExpressApplication) {
  app.useStaticAssets(app.get(LocalStorageService).root, {
    prefix: '/uploads/products/',
    index: false,
    redirect: false,
    dotfiles: 'deny',
    setHeaders: (response) => {
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; sandbox",
      );
    },
  });
}
