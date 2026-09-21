// Reimbursement cycles are half-months in Kenyan time:
//   Cycle 1 — the 1st to the 15th, batched to HR on the 16th at 08:00 EAT.
//   Cycle 2 — the 16th to the last day, batched on the 1st of the next month at 08:00 EAT.
//
// Everything here works in EAT explicitly rather than the server's local zone, so a claim
// submitted at 23:30 on the 15th lands in Cycle 1 wherever the server happens to run.
// EAT has no daylight saving, so a fixed offset is exact rather than an approximation.
export const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;
export const BATCH_HOUR_EAT = 8;
export const TIMEZONE = 'Africa/Nairobi';

const pad = (value) => String(value).padStart(2, '0');

/** Calendar fields of an instant, as they read on a clock in Nairobi. */
export function eatParts(date = new Date()) {
  const shifted = new Date(date.getTime() + EAT_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(), // 0-indexed
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/** The instant at which a given Nairobi wall-clock time occurs. Month overflow is handled. */
export function fromEat(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  return new Date(Date.UTC(year, month, day, hour, minute, second, ms) - EAT_OFFSET_MS);
}

/**
 * The cycle an instant belongs to, with its bounds and the moment it gets batched to HR.
 *
 * @param {Date|string|number} [date]
 * @returns {{key: string, label: string, year: number, month: number, start: Date, end: Date, batchAt: Date, range: string}}
 */
export function getCycleDetails(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return getCycleDetails(new Date());

  const { year, month, day } = eatParts(value);
  const first = day <= 15;

  const start = first ? fromEat(year, month, 1) : fromEat(year, month, 16);
  // The end of Cycle 2 is one millisecond before the next month begins, which sidesteps
  // having to know whether the month has 28, 29, 30 or 31 days.
  const end = first ? fromEat(year, month, 15, 23, 59, 59, 999) : new Date(fromEat(year, month + 1, 1).getTime() - 1);
  const batchAt = first ? fromEat(year, month, 16, BATCH_HOUR_EAT) : fromEat(year, month + 1, 1, BATCH_HOUR_EAT);
  const lastDay = new Date(fromEat(year, month + 1, 1).getTime() - 1);

  return {
    key: `${year}-${pad(month + 1)}-C${first ? 1 : 2}`,
    label: first ? 'Cycle 1' : 'Cycle 2',
    year,
    month,
    start,
    end,
    batchAt,
    range: first ? `1–15 ${monthName(year, month)}` : `16–${eatParts(lastDay).day} ${monthName(year, month)}`,
  };
}

/** Shorthand for tagging a claim at submission time. */
export const cycleKeyOf = (date = new Date()) => getCycleDetails(date).key;
export const cycleLabelOf = (date = new Date()) => getCycleDetails(date).label;

/** The cycle immediately before the one containing `date`. */
export function previousCycle(date = new Date()) {
  const current = getCycleDetails(date);
  return getCycleDetails(new Date(current.start.getTime() - 1));
}

/** Rebuilds a cycle from its key, e.g. "2026-09-C2". Returns null if the key is malformed. */
export function cycleFromKey(key) {
  const match = /^(\d{4})-(\d{2})-C([12])$/.exec(String(key || ''));
  if (!match) return null;
  const [, year, month, which] = match;
  return getCycleDetails(fromEat(Number(year), Number(month) - 1, which === '1' ? 1 : 16, 12));
}

/** True once a cycle's 08:00 EAT batch moment has passed. */
export function isClosed(cycle, now = new Date()) {
  return now.getTime() >= cycle.batchAt.getTime();
}

function monthName(year, month) {
  return new Date(Date.UTC(year, month, 15)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
}
