/**
 * MYRAA — TimezoneUtil (Stage 10.6)
 *
 * Timezone & recurrence utilities:
 *   - IANA timezone validation using built-in Intl.DateTimeFormat
 *   - Daylight Saving Time (DST) transition safety
 *   - Local wall-clock time preservation for recurring reminders
 *   - Bounded recurrence interval calculation
 */

import {
  MAX_FUTURE_HORIZON_DAYS,
  type RecurrenceRule,
} from "./ReminderTypes.ts";

/**
 * Validates whether a timezone identifier is a recognized IANA timezone string.
 */
export function isValidIanaTimezone(tz: string): boolean {
  if (!tz || typeof tz !== "string" || !tz.trim()) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates a due time string: must be parseable ISO date, not NaN.
 */
export function isValidDateString(dateStr: string): boolean {
  if (!dateStr || typeof dateStr !== "string") return false;
  const d = new Date(dateStr);
  return !isNaN(d.getTime());
}

/**
 * Extracts the local components (year, month, day, hour, minute, second)
 * of a UTC timestamp in a specific IANA timezone.
 */
export function getLocalComponents(utcDate: Date, timeZone: string): {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = dtf.formatToParts(utcDate);
  const findPart = (type: string): number => {
    const p = parts.find((pt) => pt.type === type);
    return p ? parseInt(p.value, 10) : 0;
  };

  return {
    year: findPart("year"),
    month: findPart("month"),
    day: findPart("day"),
    hour: findPart("hour") % 24, // formatToParts can sometimes return 24 for midnight
    minute: findPart("minute"),
    second: findPart("second"),
  };
}

/**
 * Converts a target local wall-clock date/time in an IANA timezone into an exact UTC Date.
 * Handles DST shifts by iterating to converge on the exact UTC offset.
 */
export function localToUtc(
  local: { year: number; month: number; day: number; hour: number; minute: number; second?: number },
  timeZone: string,
): Date {
  const targetSecond = local.second ?? 0;
  // Initial estimate in UTC
  let utcGuess = new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, targetSecond));

  // Refine guess by measuring timezone offset difference
  for (let iter = 0; iter < 4; iter++) {
    const comp = getLocalComponents(utcGuess, timeZone);
    const diffHours = local.hour - comp.hour;
    const diffMinutes = local.minute - comp.minute;
    const diffDays = local.day - comp.day;

    if (diffDays === 0 && diffHours === 0 && diffMinutes === 0) {
      break;
    }

    const adjustMs = (diffDays * 24 * 60 + diffHours * 60 + diffMinutes) * 60 * 1000;
    utcGuess = new Date(utcGuess.getTime() + adjustMs);
  }

  return utcGuess;
}

/**
 * Computes the next scheduled due time for a recurring reminder,
 * preserving the local wall-clock time across DST transitions.
 */
export function computeNextOccurrence(
  currentDueTimeUtc: string,
  timeZone: string,
  rule: RecurrenceRule,
): string | null {
  if (!isValidDateString(currentDueTimeUtc) || !isValidIanaTimezone(timeZone)) {
    return null;
  }

  const currentUtc = new Date(currentDueTimeUtc);
  const local = getLocalComponents(currentUtc, timeZone);

  let nextYear = local.year;
  let nextMonth = local.month;
  let nextDay = local.day;

  const interval = Math.max(1, rule.interval ?? 1);

  switch (rule.frequency) {
    case "daily": {
      // Advance by interval days in local calendar
      const d = new Date(Date.UTC(nextYear, nextMonth - 1, nextDay + interval));
      nextYear = d.getUTCFullYear();
      nextMonth = d.getUTCMonth() + 1;
      nextDay = d.getUTCDate();
      break;
    }
    case "weekly": {
      // Advance by interval * 7 days
      const d = new Date(Date.UTC(nextYear, nextMonth - 1, nextDay + interval * 7));
      nextYear = d.getUTCFullYear();
      nextMonth = d.getUTCMonth() + 1;
      nextDay = d.getUTCDate();
      break;
    }
    case "monthly": {
      // Advance by interval months
      nextMonth += interval;
      while (nextMonth > 12) {
        nextMonth -= 12;
        nextYear += 1;
      }
      // Ensure day doesn't exceed days in target month
      const maxDaysInMonth = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
      nextDay = Math.min(local.day, maxDaysInMonth);
      break;
    }
    case "custom_interval": {
      // interval specified in days
      const d = new Date(Date.UTC(nextYear, nextMonth - 1, nextDay + interval));
      nextYear = d.getUTCFullYear();
      nextMonth = d.getUTCMonth() + 1;
      nextDay = d.getUTCDate();
      break;
    }
    default:
      return null;
  }

  // Convert updated local wall-clock date/time back to UTC
  const nextUtc = localToUtc(
    {
      year: nextYear,
      month: nextMonth,
      day: nextDay,
      hour: local.hour,
      minute: local.minute,
      second: local.second,
    },
    timeZone,
  );

  // Check end date bound
  if (rule.endDate && isValidDateString(rule.endDate)) {
    const end = new Date(rule.endDate);
    if (nextUtc.getTime() > end.getTime()) {
      return null; // Recurrence ended
    }
  }

  // Check max future horizon (1 year)
  const maxHorizonMs = Date.now() + MAX_FUTURE_HORIZON_DAYS * 24 * 60 * 60 * 1000;
  if (nextUtc.getTime() > maxHorizonMs) {
    return null;
  }

  return nextUtc.toISOString();
}
