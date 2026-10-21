import { IsIn, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { SINGLE_USE_TOKEN_PATTERN } from '../common/single-use-token.js';
import { MAX_REASON_LENGTH } from './finance-rule-links.service.js';

/** The rules themselves are validated by `parseRulesConfig`, which reports every problem. */
export class SaveFinanceRulesDraftDto {
  @IsObject()
  config!: Record<string, unknown>;
}

/** Body of `POST /agreements/inspect`: the token from the emailed link. */
export class AgreementTokenDto {
  @IsString()
  @Matches(SINGLE_USE_TOKEN_PATTERN)
  token!: string;
}

/** Body of `POST /agreements/respond`. The reason is required (and checked) only to object. */
export class RespondAgreementDto extends AgreementTokenDto {
  @IsIn(['approve', 'object'])
  decision!: 'approve' | 'object';

  @IsOptional()
  @IsString()
  @MaxLength(MAX_REASON_LENGTH)
  reason?: string;
}
