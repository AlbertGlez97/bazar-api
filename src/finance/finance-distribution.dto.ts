import { IsIn, IsInt, Max, Min, registerDecorator } from 'class-validator';
import { MAX_MINOR_UNITS } from '../common/money.js';
import { isCalendarDate } from './work-shift.dto.js';

export const WORK_BASES = ['WORK_SHIFTS', 'KNOWN_MINUTES'] as const;
export type WorkBasis = (typeof WORK_BASES)[number];
export const BPS_TOTAL = 10000;

// Strict date-only period with from preceding to, same rule as the overview.
function OrderedPeriod(endProperty: string) {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'orderedPeriod',
      target: target.constructor,
      propertyName,
      validator: {
        validate(value: unknown, args) {
          const end: unknown = (args!.object as Record<string, unknown>)[
            endProperty
          ];
          return isCalendarDate(value) && isCalendarDate(end) && value < end;
        },
        defaultMessage: () =>
          'Both period dates must be valid YYYY-MM-DD values with from preceding to',
      },
    });
}
function CalendarDate() {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'calendarDate',
      target: target.constructor,
      propertyName,
      validator: {
        validate: isCalendarDate,
        defaultMessage: () => 'Date must be a valid YYYY-MM-DD calendar date',
      },
    });
}
// Cross-field rule: both shares are basis points of the same requested amount.
function SharesSumToTotal(partnerProperty: string) {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'sharesSumToTotal',
      target: target.constructor,
      propertyName,
      validator: {
        validate(value: unknown, args) {
          const partner = (args!.object as Record<string, unknown>)[
            partnerProperty
          ];
          return (
            typeof value === 'number' &&
            typeof partner === 'number' &&
            value + partner === BPS_TOTAL
          );
        },
        defaultMessage: () =>
          `partnerShareBps and workShareBps must add up to ${BPS_TOTAL}`,
      },
    });
}

export class FinanceDistributionSimulationDto {
  @OrderedPeriod('to') from!: string;
  @CalendarDate() to!: string;
  @IsInt() @Min(1) @Max(MAX_MINOR_UNITS) requestedAmountMinor!: number;
  @IsInt() @Min(0) @Max(BPS_TOTAL) partnerShareBps!: number;
  @IsInt()
  @Min(0)
  @Max(BPS_TOTAL)
  @SharesSumToTotal('partnerShareBps')
  workShareBps!: number;
  @IsIn(WORK_BASES) workBasis!: WorkBasis;
}
