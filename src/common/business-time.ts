import { BadRequestException } from '@nestjs/common';

// No part of this project has previously had to decide *which calendar
// day* a stored UTC instant (Timestamptz) falls on — occurredAt/receivedAt
// were only ever compared to each other as raw instants (see
// SalesService.occurredAtIssue), never bucketed into "days" or "weeks".
// BE-08's weekly commission cutover and day/range reports are the first
// features that need that decision, so it is made explicitly here rather
// than left implicit.
//
// The bazar operates in Mexico City. Mexico's 2022 time-reform abolished
// DST for the whole country except a narrow northern-border strip, so
// Mexico City (and the rest of the "zona centro") now sits at a fixed
// UTC-6 year-round. That means a plain fixed-offset calculation is
// accurate here without needing a full IANA timezone database/library
// (e.g. luxon, date-fns-tz) as a new dependency — a real win for a
// two-person bazar, not a shortcut that will need revisiting once DST
// resumes, because it does not.
export const BUSINESS_TZ_OFFSET_MINUTES = -6 * 60;

/** Shifts a UTC instant so its `getUTCFullYear/Month/Date/Day` getters
 * read as if they were local (business-timezone) wall-clock getters. Only
 * ever used internally to *read* the local day/weekday of an instant —
 * never persisted or returned to a caller (that would be the wrong
 * instant). */
function toLocalReadable(date: Date): Date {
  return new Date(date.getTime() + BUSINESS_TZ_OFFSET_MINUTES * 60_000);
}

/** Inverse of {@link toLocalReadable}: converts a "local-wall-clock read
 * as UTC getters" Date back into the real UTC instant it represents. */
function fromLocalReadable(local: Date): Date {
  return new Date(local.getTime() - BUSINESS_TZ_OFFSET_MINUTES * 60_000);
}

/**
 * Resolves the Sunday 00:00:00 (inclusive) – Saturday 23:59:59.999
 * (inclusive) business-timezone week that contains `instant`.
 *
 * The cutover is domingo-a-sábado (not lunes-a-domingo) per the approved
 * commission periodicity: a colaborador's week "resets" every Sunday
 * morning, matching how the bazar's own operating cadence is described by
 * the socios, not an ISO-8601 week convention.
 */
export function currentWeekRange(instant: Date): { from: Date; to: Date } {
  const local = toLocalReadable(instant);
  const dayOfWeek = local.getUTCDay(); // 0 (Sun) .. 6 (Sat), read as local
  const localSundayStart = new Date(
    Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate() - dayOfWeek,
      0,
      0,
      0,
      0,
    ),
  );
  const localSaturdayEnd = new Date(
    localSundayStart.getTime() + 7 * 86_400_000 - 1,
  );
  return {
    from: fromLocalReadable(localSundayStart),
    to: fromLocalReadable(localSaturdayEnd),
  };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses a report/commission date-range query boundary.
 *
 * A caller (a socio typing a plain day into a form field, e.g. "de
 * 2025-01-01 a 2025-01-01" for "just today") reasonably expects a
 * date-only value to mean the *whole local day*, not the single UTC
 * midnight instant `new Date('2025-01-01')` would otherwise resolve to
 * (which is 6h before Mexico City's own midnight, silently clipping the
 * first six hours of that day's sales). A date-only `from` therefore
 * resolves to that local day's start; a date-only `to` resolves to that
 * local day's end. A full ISO-8601 instant (with a time component and/or
 * explicit offset) is never reinterpreted — it is used exactly as given,
 * since the caller was already explicit about the instant they meant.
 */
export function parseRangeBoundary(
  value: string,
  boundary: 'start' | 'end',
): Date {
  if (DATE_ONLY.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    const local =
      boundary === 'start'
        ? new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0))
        : new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
    return fromLocalReadable(local);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new BadRequestException(`Invalid date: ${value}`);
  return parsed;
}
