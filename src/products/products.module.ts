import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { ProductsController } from './products.controller.js';
import { ProductsService } from './products.service.js';
import {
  LocalStorageService,
  StorageService,
} from '../storage/storage.service.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [ProductsController],
  providers: [
    ProductsService,
    LocalStorageService,
    { provide: StorageService, useExisting: LocalStorageService },
  ],
  exports: [LocalStorageService],
})
export class ProductsModule {}
