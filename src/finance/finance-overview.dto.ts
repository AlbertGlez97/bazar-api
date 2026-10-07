import { registerDecorator } from 'class-validator';
import { isCalendarDate } from './work-shift.dto.js';
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
export class FinanceOverviewDto {
  @CalendarDate() from!: string;
  @CalendarDate() to!: string;
}
