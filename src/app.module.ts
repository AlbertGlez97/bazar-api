import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './auth/auth.module.js';
import { MembersController } from './members/members.controller.js';
import { DevicesController } from './devices/devices.controller.js';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [AppController, MembersController, DevicesController],
  providers: [AppService],
})
export class AppModule {}
