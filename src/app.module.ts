import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseModule } from './database/database.module.js';
import { TenantContextMiddleware } from './database/tenant-context.middleware.js';
import { AuthModule } from './auth/auth.module.js';
import { MembersModule } from './members/members.module.js';
import { DevicesController } from './devices/devices.controller.js';
import { ProductsModule } from './products/products.module.js';
import { SalesModule } from './sales/sales.module.js';
import { IncidenciasModule } from './incidencias/incidencias.module.js';
import { CommissionsModule } from './commissions/commissions.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { DeudasModule } from './deudas/deudas.module.js';
import { BusinessRegistrationModule } from './business-registration/business-registration.module.js';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    MembersModule,
    ProductsModule,
    SalesModule,
    IncidenciasModule,
    CommissionsModule,
    ReportsModule,
    DeudasModule,
    BusinessRegistrationModule,
  ],
  controllers: [AppController, DevicesController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // BE-11: establishes the per-request tenant scope before any guard
    // runs; see TenantContextMiddleware's own doc comment.
    // Explicit optional wildcard: it matches every path (and the bare root)
    // with or without the global prefix. A plain '*' becomes '/api/v1/*'
    // behind the prefix, which path-to-regexp v8 rejects and Nest only
    // auto-converts after logging a LegacyRouteConverter warning.
    consumer.apply(TenantContextMiddleware).forRoutes('{*path}');
  }
}

