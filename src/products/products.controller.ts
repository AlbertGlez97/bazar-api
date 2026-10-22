import { ApiExample } from '../docs/api-example.decorator.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard.js';
import { ProductsService } from './products.service.js';
import { SocioGuard } from '../auth/socio.guard.js';
import {
  CreateProductDto,
  PatchProductDto,
  ProductListDto,
  RestockProductDto,
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
/**
 * Writes (`create`, `patch`, `image`, `deactivate`, `reactivate`) require
 * {@link SocioGuard} (socio-only); reads (`list`, `findOne`, `audit`) only
 * require {@link AuthGuard}, since colaboradores must be able to browse
 * the catalog and price history to sell, even though they cannot change
 * it. `list`'s `includeInactive` is additionally gated to socios via the
 * optional `x-member-id` header, without requiring a full guard/selection
 * (see {@link ProductsService.list}).
 */
@ApiTags('products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(
    @Inject(ProductsService) private readonly products: ProductsService,
  ) {}
  @Post()
  @ApiExample('productCreate')
  @UseGuards(SocioGuard)
  create(
    @Req() req: AuthenticatedRequest,
    @Body(validate(CreateProductDto)) dto: CreateProductDto,
  ) {
    return this.products.create(req, dto);
  }
  @Patch(':id')
  @ApiExample('productPatch')
  @UseGuards(SocioGuard)
  patch(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(validate(PatchProductDto)) dto: PatchProductDto,
  ) {
    return this.products.patch(req, id, dto);
  }
  @Post(':id/restock')
  @ApiOperation({
    summary: 'Restock a product sold by quantity (socios only)',
    description:
      'Adds pieces to the stock, atomically, and records an append-only ' +
      'StockMovement plus an audit row. Returns { product, movement }. ' +
      'If a unit cost is given the product cost becomes the weighted ' +
      'average (see ProductsService.restock). 400 for a unique piece, a ' +
      'deactivated product or a stock above the maximum; 404 if the ' +
      'product is not in this context.',
  })
  @UseGuards(SocioGuard)
  restock(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(validate(RestockProductDto)) dto: RestockProductDto,
  ) {
    return this.products.restock(req, id, dto);
  }
  @Get()
  @ApiExample('products')
  @UseGuards(AuthGuard)
  list(
    @Req() req: AuthenticatedRequest,
    @Query(validate(ProductListDto)) query: ProductListDto,
    @Headers('x-member-id') requestingMemberId?: string,
  ) {
    return this.products.list(
      req.account.contextId,
      query,
      requestingMemberId,
      req.account.memberId,
    );
  }
  // Declared before `:id` so "suggestions" is never read as a product id.
  @Get('suggestions')
  @ApiOperation({
    summary: 'Brands, presentations and categories already in use (socios only)',
    description:
      'Distinct brands, presentations and categories of the active products ' +
      'of the business, at most 200 of each, alphabetical, to suggest them in ' +
      'the product form. Categories are grouped ignoring case, accents and ' +
      'extra spaces and shown with their most frequent spelling. Returns ' +
      '{ brands: string[], presentations: string[], categories: string[] } ' +
      'and nothing else about the products.',
  })
  @UseGuards(SocioGuard)
  suggestions(@Req() req: AuthenticatedRequest) {
    return this.products.suggestions(req.account.contextId);
  }
  @Get(':id')
  @ApiOperation({
    summary: 'Get a single product',
    description:
      'Returns the product regardless of active status (a deactivated ' +
      "product is still individually fetchable; only the default list " +
      'hides it). 404 if it does not exist in this context. The purchase ' +
      'cost is only included when x-member-id identifies an active socio.',
  })
  @UseGuards(AuthGuard)
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('x-member-id') requestingMemberId?: string,
  ) {
    return this.products.findOne(
      req.account.contextId,
      id,
      requestingMemberId,
      req.account.memberId,
    );
  }
  @Get(':id/audit')
  @ApiExample('productAudit')
  @UseGuards(AuthGuard)
  audit(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(validate(ProductListDto)) query: ProductListDto,
    @Headers('x-member-id') requestingMemberId?: string,
  ) {
    return this.products.audits(
      req.account.contextId,
      id,
      query,
      requestingMemberId,
      req.account.memberId,
    );
  }
  @Post(':id/image')
  @ApiExample('productImage')
  @UseGuards(SocioGuard)
  @UseInterceptors(
    FileInterceptor('image', {
      // fields: 0 rejects any multipart field besides the file itself, so
      // an attacker cannot smuggle extra form fields past the JSON DTO
      // validation that only applies to the JSON-body endpoints.
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
  @Delete(':id')
  @ApiOperation({
    summary: 'Deactivate a product (soft delete)',
    description:
      'Sets active=false; the row and its full history (audits, sale ' +
      'items, deudas) are preserved. Idempotent: deactivating an already ' +
      'inactive product just returns its current state, not an error.',
  })
  @UseGuards(SocioGuard)
  deactivate(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.products.deactivate(req, id);
  }
  @Patch(':id/reactivate')
  @ApiOperation({
    summary: 'Reactivate a deactivated product',
    description:
      'Sets active=true again. Idempotent: reactivating an already ' +
      'active product just returns its current state.',
  })
  @UseGuards(SocioGuard)
  reactivate(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.products.reactivate(req, id);
  }
}
