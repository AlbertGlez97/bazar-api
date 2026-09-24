import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './auth/auth.module.js';
import { MembersModule } from './members/members.module.js';
import { DevicesController } from './devices/devices.controller.js';
import { ProductsModule } from './products/products.module.js';
import { SalesModule } from './sales/sales.module.js';
import { IncidenciasModule } from './incidencias/incidencias.module.js';
import { CommissionsModule } from './commissions/commissions.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { DeudasModule } from './deudas/deudas.module.js';

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
  ],
  controllers: [AppController, DevicesController],
  providers: [AppService],
})
export class AppModule {}
