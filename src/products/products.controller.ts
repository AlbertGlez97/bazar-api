import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard.js';
import { ProductsService } from './products.service.js';
import { SocioGuard } from './socio.guard.js';
import {
  CreateProductDto,
  PatchProductDto,
  ProductListDto,
} from './dto/product.dto.js';
import { MAX_IMAGE_BYTES } from '../storage/storage.service.js';
import type {} from 'multer';

const validate = (expectedType: new () => object) =>
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });
@Controller('products')
export class ProductsController {
  constructor(
    @Inject(ProductsService) private readonly products: ProductsService,
  ) {}
  @Post()
  @UseGuards(SocioGuard)
  create(
    @Req() req: AuthenticatedRequest,
    @Body(validate(CreateProductDto)) dto: CreateProductDto,
  ) {
    return this.products.create(req, dto);
  }
  @Patch(':id')
  @UseGuards(SocioGuard)
  patch(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(validate(PatchProductDto)) dto: PatchProductDto,
  ) {
    return this.products.patch(req, id, dto);
  }
  @Get()
  @UseGuards(AuthGuard)
  list(
    @Req() req: AuthenticatedRequest,
    @Query(validate(ProductListDto)) query: ProductListDto,
  ) {
    return this.products.list(req.account.contextId, query);
  }
  @Get(':id/audit')
  @UseGuards(AuthGuard)
  audit(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(validate(ProductListDto)) query: ProductListDto,
  ) {
    return this.products.audits(req.account.contextId, id, query);
  }
  @Post(':id/image')
  @UseGuards(SocioGuard)
  @UseInterceptors(
    FileInterceptor('image', {
      limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0 },
    }),
  )
  image(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.products.image(req, id, file);
  }
}
