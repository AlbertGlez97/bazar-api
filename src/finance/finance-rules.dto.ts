import { IsObject } from 'class-validator';

/** The rules themselves are validated by `parseRulesConfig`, which reports every problem. */
export class SaveFinanceRulesDraftDto {
  @IsObject()
  config!: Record<string, unknown>;
}
