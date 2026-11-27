import {
  getMonthBounds,
  getNzOffsetMinutes,
} from "../services/dispatchAggregation/dispatchAggregation";

// dates are NZ trading dates as YYYY-MM-DD strings, as the API has them

const DATE_FORMAT = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

export class InvalidDateError extends Error {}

// the first day of a year (2025), month (2025-03) or day (2025-03-14)
export function parseStart(input: string): string {
  const [year, month, day] = parse(input);
  return `${year}-${month ?? "01"}-${day ?? "01"}`;
}

// the last day of a year, month or day
export function parseEnd(input: string): string {
  const [year, month, day] = parse(input);
  if (day) {
    return `${year}-${month}-${day}`;
  }
  return month ? getMonthBounds(`${year}-${month}`).to : `${year}-12-31`;
}

function parse(input: string): [string, string | undefined, string | undefined] {
  const match = DATE_FORMAT.exec(input.trim());
  const [, year, month, day] = match ?? [];
  const isValid =
    match &&
    (!month || (+month >= 1 && +month <= 12)) &&
    (!day || (+day >= 1 && `${year}-${month}-${day}` <= getMonthBounds(`${year}-${month}`).to));
  if (!isValid) {
    throw new InvalidDateError(`Invalid date "${input}", expected YYYY, YYYY-MM or YYYY-MM-DD`);
  }
  return [year, month, day];
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(date) + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// each month from from's to to's, e.g. 2025-11, 2025-12, 2026-01
export function monthsBetween(from: string, to: string): string[] {
  const months = [] as string[];
  for (
    let month = from.slice(0, 7);
    month <= to.slice(0, 7);
    month = addDays(getMonthBounds(month).to, 1).slice(0, 7)
  ) {
    months.push(month);
  }
  return months;
}

// the instant an NZ time without an offset (e.g. 2026-11-07T18:00) is. the offset at the time read as UTC is only wrong
// within 13 hours of a daylight saving change, so it's checked again at the instant that gives
export function parseNzTime(time: string): number {
  const asUtc = Date.parse(`${time}Z`);
  const guess = asUtc - getNzOffsetMinutes(asUtc) * 60000;
  return asUtc - getNzOffsetMinutes(guess) * 60000;
}

export function todayInNz(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Auckland" }).format(now);
}
