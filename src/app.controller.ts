import { ApiExample } from './docs/api-example.decorator.js';
import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service.js';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiExample('root')
  getHello(): string {
    return this.appService.getHello();
  }
}
