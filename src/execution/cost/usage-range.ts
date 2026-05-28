/**
 * Helpers for parsing/normalizing the optional `from`/`to` window used by
 * `/api/usage` and `foreman usage`. Both surfaces accept `YYYY-MM-DD` and
 * default to the last 7 full days (UTC) ending now.
 *
 * Range is [fromInclusive, toExclusive). Treating the upper bound as
 * exclusive avoids the half-day-overlap bugs you get when both ends are
 * inclusive — a request for `from=2026-05-20&to=2026-05-26` returns
 * everything strictly before midnight UTC on the 27th, which matches what
 * a user typing those dates expects.
 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isIsoDate = (value: string): boolean => ISO_DATE_RE.test(value);

const startOfDayUtc = (date: Date): Date => {
  const next = new Date(date.getTime());
  next.setUTCHours(0, 0, 0, 0);
  return next;
};

const addDaysUtc = (date: Date, days: number): Date => {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const parseIsoDate = (value: string): Date => {
  if (!isIsoDate(value)) {
    throw new Error(`Invalid date "${value}". Expected YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date "${value}".`);
  }
  return parsed;
};

export type UsageRange = {
  fromInclusive: string;
  toExclusive: string;
  fromDate: string;
  toDate: string;
};

export const resolveUsageRange = (input: { from?: string; to?: string; now?: Date }): UsageRange => {
  const now = input.now ?? new Date();
  const today = startOfDayUtc(now);

  const explicitTo = input.to ? parseIsoDate(input.to) : null;
  const explicitFrom = input.from ? parseIsoDate(input.from) : null;

  const toInclusiveDay = explicitTo ?? today;
  const fromInclusiveDay = explicitFrom ?? addDaysUtc(toInclusiveDay, -6);

  if (fromInclusiveDay.getTime() > toInclusiveDay.getTime()) {
    throw new Error("`from` must be on or before `to`.");
  }

  const toExclusiveDay = addDaysUtc(toInclusiveDay, 1);

  return {
    fromInclusive: fromInclusiveDay.toISOString(),
    toExclusive: toExclusiveDay.toISOString(),
    fromDate: fromInclusiveDay.toISOString().slice(0, 10),
    toDate: toInclusiveDay.toISOString().slice(0, 10),
  };
};
