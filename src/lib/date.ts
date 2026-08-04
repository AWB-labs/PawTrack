/**
 * Petal — dates, clocks and ages.
 *
 * Three conventions this module defends, because getting them wrong is how
 * pet-care apps end up feeding a dog at 3am:
 *
 *  1. **`TimeOfDay` is wall-clock, not an instant.** A 7am feed is 7am in
 *     whatever timezone the household is standing in today. So every helper
 *     here resolves `"HH:mm"` against the *local* calendar (`setHours`, which
 *     is DST-correct) and never round-trips through UTC.
 *  2. **`DateOnly` is a local calendar day.** `parseISO('2026-03-05')` gives
 *     local midnight — unlike `new Date('2026-03-05')`, which gives UTC
 *     midnight and silently shifts the day for anyone west of Greenwich.
 *  3. **Day arithmetic is calendar-based, not 24h-based.** "Yesterday at
 *     11pm" is one day ago even though it was 90 minutes ago, so all the
 *     friendly labels count calendar days rather than elapsed milliseconds.
 *
 * Weekdays are `0=Sunday … 6=Saturday` throughout, matching `Date#getDay()` and
 * `FeedingSchedule.daysOfWeek`.
 */

import {
  addDays,
  differenceInCalendarDays,
  differenceInMinutes,
  differenceInMonths,
  eachDayOfInterval,
  endOfDay,
  format,
  isValid,
  parseISO,
  startOfDay,
} from 'date-fns';

import type { DateOnly, Pet, TimeOfDay } from '@/data/types';

/* ------------------------------------------------------------- primitives */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export type DateLike = Date | string | number;

export const WEEKDAY_LONG = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** All seven days, in `Date#getDay()` order. Handy default for schedules. */
export const EVERY_DAY: readonly number[] = [0, 1, 2, 3, 4, 5, 6];

const TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * The one coercion point. Returns `null` rather than an Invalid Date so a bad
 * value from storage degrades to "—" in the UI instead of "NaN/NaN/NaN".
 */
export function toDate(value: DateLike | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return isValid(value) ? value : null;
  if (typeof value === 'number') {
    const d = new Date(value);
    return isValid(d) ? d : null;
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = parseISO(trimmed);
  return isValid(parsed) ? parsed : null;
}

/** Coerce or throw — for internal call sites where a bad date is a real bug. */
function requireDate(value: DateLike, label: string): Date {
  const d = toDate(value);
  if (!d) throw new RangeError(`${label}: expected a valid date, received ${String(value)}`);
  return d;
}

export function toISO(value: DateLike): string {
  return requireDate(value, 'toISO').toISOString();
}

/** `YYYY-MM-DD` in the device's timezone. */
export function toDateOnly(value: DateLike): DateOnly {
  return format(requireDate(value, 'toDateOnly'), 'yyyy-MM-dd');
}

/** Local midnight for a `YYYY-MM-DD`. */
export function fromDateOnly(value: DateOnly): Date | null {
  return toDate(value);
}

export function isSameLocalDay(a: DateLike, b: DateLike): boolean {
  const left = toDate(a);
  const right = toDate(b);
  if (!left || !right) return false;
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

export function startOfLocalDayISO(value: DateLike = new Date()): string {
  return startOfDay(requireDate(value, 'startOfLocalDayISO')).toISOString();
}

export function endOfLocalDayISO(value: DateLike = new Date()): string {
  return endOfDay(requireDate(value, 'endOfLocalDayISO')).toISOString();
}

/** The `[from, to]` pair most "what happened today" queries want. */
export function localDayBoundsISO(value: DateLike = new Date()): { from: string; to: string } {
  return { from: startOfLocalDayISO(value), to: endOfLocalDayISO(value) };
}

/* ------------------------------------------------------------------ clock */

export function isTimeOfDay(value: string): boolean {
  return TIME_PATTERN.test(value.trim());
}

export function parseTimeOfDay(value: TimeOfDay): { hour: number; minute: number } | null {
  const match = TIME_PATTERN.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Minutes since local midnight — the sort key for a day's schedule. */
export function timeOfDayToMinutes(value: TimeOfDay): number | null {
  const parsed = parseTimeOfDay(value);
  return parsed ? parsed.hour * 60 + parsed.minute : null;
}

export function compareTimeOfDay(a: TimeOfDay, b: TimeOfDay): number {
  return (timeOfDayToMinutes(a) ?? 0) - (timeOfDayToMinutes(b) ?? 0);
}

export function minutesToTimeOfDay(minutes: number): TimeOfDay {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const hour = Math.floor(wrapped / 60);
  const minute = wrapped % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** `Date` → `"08:30"`. */
export function toTimeOfDay(value: DateLike): TimeOfDay {
  return format(requireDate(value, 'toTimeOfDay'), 'HH:mm');
}

/**
 * `"08:30"` → `"8:30am"`, `"20:00"` → `"8pm"`.
 * Dropping `:00` matters more than it sounds — a schedule list of "7am · 12pm ·
 * 6pm" scans instantly where "7:00 AM · 12:00 PM" reads like a train timetable.
 */
export function formatTimeOfDay(value: TimeOfDay): string {
  const parsed = parseTimeOfDay(value);
  if (!parsed) return value;
  const date = new Date(2000, 0, 1, parsed.hour, parsed.minute);
  return format(date, parsed.minute === 0 ? 'haaa' : 'h:mmaaa');
}

/** `Date` → `"6:30pm"` / `"6pm"`. */
export function formatClock(value: DateLike): string {
  const date = requireDate(value, 'formatClock');
  return format(date, date.getMinutes() === 0 ? 'haaa' : 'h:mmaaa');
}

/** Coarse bucket, for labelling an unnamed dose slot ("Evening dose"). */
export function timeSlotLabel(value: TimeOfDay): string {
  const minutes = timeOfDayToMinutes(value);
  if (minutes === null) return 'Scheduled';
  if (minutes < 5 * 60) return 'Overnight';
  if (minutes < 11 * 60) return 'Morning';
  if (minutes < 14 * 60) return 'Midday';
  if (minutes < 17 * 60) return 'Afternoon';
  if (minutes < 21 * 60) return 'Evening';
  return 'Night';
}

/** Stamp a wall-clock time onto a calendar day, DST-safely. */
export function applyTimeOfDay(day: DateLike, time: TimeOfDay): Date | null {
  const base = toDate(day);
  const parsed = parseTimeOfDay(time);
  if (!base || !parsed) return null;
  const next = new Date(base.getFullYear(), base.getMonth(), base.getDate(), parsed.hour, parsed.minute, 0, 0);
  return isValid(next) ? next : null;
}

/** Drop invalid entries, dedupe, sort. An empty/absent list means "every day". */
export function normalizeWeekdays(days?: readonly number[] | null): number[] {
  if (!days || days.length === 0) return [...EVERY_DAY];
  const cleaned = [...new Set(days.map((d) => Math.trunc(d)).filter((d) => d >= 0 && d <= 6))];
  return cleaned.length > 0 ? cleaned.sort((a, b) => a - b) : [...EVERY_DAY];
}

/**
 * The next time `time` comes round on one of `daysOfWeek`, strictly after
 * `from`. Eight iterations because a weekly slot can be at most seven days out
 * and the eighth covers "today, but the time has already passed".
 */
export function nextOccurrence(
  time: TimeOfDay,
  daysOfWeek?: readonly number[] | null,
  from: DateLike = new Date(),
): Date | null {
  const base = toDate(from);
  if (!base || !isTimeOfDay(time)) return null;
  const days = normalizeWeekdays(daysOfWeek);

  for (let offset = 0; offset <= 7; offset += 1) {
    const day = addDays(base, offset);
    if (!days.includes(day.getDay())) continue;
    const candidate = applyTimeOfDay(day, time);
    if (candidate && candidate.getTime() > base.getTime()) return candidate;
  }
  return null;
}

/** Every upcoming slot for a multi-time schedule, in chronological order. */
export function nextOccurrences(
  times: readonly TimeOfDay[],
  daysOfWeek?: readonly number[] | null,
  from: DateLike = new Date(),
): Date[] {
  return times
    .map((t) => nextOccurrence(t, daysOfWeek, from))
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());
}

/* -------------------------------------------------------- friendly labels */

/** `"Fri 3 Oct"`, or `"3 Oct 2023"` once the year stops being obvious. */
export function formatDay(value: DateLike, now: DateLike = new Date()): string {
  const date = requireDate(value, 'formatDay');
  const reference = toDate(now) ?? new Date();
  return date.getFullYear() === reference.getFullYear()
    ? format(date, 'EEE d MMM')
    : format(date, 'd MMM yyyy');
}

/** `"Today"` / `"Yesterday"` / `"Fri 3 Oct"`. */
export function friendlyDate(value: DateLike, now: DateLike = new Date()): string {
  const date = toDate(value);
  const reference = toDate(now) ?? new Date();
  if (!date) return '—';

  const days = differenceInCalendarDays(date, reference);
  if (days === 0) return 'Today';
  if (days === -1) return 'Yesterday';
  if (days === 1) return 'Tomorrow';
  if (days > 1 && days < 7) return WEEKDAY_LONG[date.getDay()] ?? formatDay(date, reference);
  if (days < -1 && days > -7) return `Last ${WEEKDAY_LONG[date.getDay()] ?? ''}`.trim();
  return formatDay(date, reference);
}

/** `"Yesterday 6:30pm"`, `"Fri 8am"`, `"3 Oct 2023, 4pm"`. */
export function friendlyDateTime(value: DateLike, now: DateLike = new Date()): string {
  const date = toDate(value);
  const reference = toDate(now) ?? new Date();
  if (!date) return '—';

  const days = differenceInCalendarDays(date, reference);
  const clock = formatClock(date);

  if (days === 0) return `Today ${clock}`;
  if (days === -1) return `Yesterday ${clock}`;
  if (days === 1) return `Tomorrow ${clock}`;
  if (Math.abs(days) < 7) {
    const weekday = WEEKDAY_SHORT[date.getDay()] ?? '';
    return `${weekday} ${clock}`.trim();
  }
  if (date.getFullYear() === reference.getFullYear()) return `${format(date, 'd MMM')}, ${clock}`;
  return `${format(date, 'd MMM yyyy')}, ${clock}`;
}

/** `"in 2 days"`, `"3 minutes ago"`, `"just now"`. */
export function relativeTime(value: DateLike, now: DateLike = new Date()): string {
  const date = toDate(value);
  const reference = toDate(now) ?? new Date();
  if (!date) return '—';

  const deltaMs = date.getTime() - reference.getTime();
  const future = deltaMs > 0;
  const absMs = Math.abs(deltaMs);

  if (absMs < 45 * 1000) return future ? 'in a moment' : 'just now';

  if (absMs < HOUR_MS) {
    const mins = Math.max(1, Math.round(absMs / MINUTE_MS));
    return wrap(future, `${mins} minute${mins === 1 ? '' : 's'}`);
  }

  const calendarDays = Math.abs(differenceInCalendarDays(date, reference));
  if (absMs < DAY_MS && calendarDays === 0) {
    const hours = Math.max(1, Math.round(absMs / HOUR_MS));
    return wrap(future, `${hours} hour${hours === 1 ? '' : 's'}`);
  }

  if (calendarDays === 1) return future ? 'tomorrow' : 'yesterday';
  if (calendarDays < 7) return wrap(future, `${calendarDays} days`);
  if (calendarDays < 31) {
    const weeks = Math.round(calendarDays / 7);
    return wrap(future, `${weeks} week${weeks === 1 ? '' : 's'}`);
  }

  const months = Math.max(1, Math.abs(differenceInMonths(date, reference)));
  if (months < 12) return wrap(future, `${months} month${months === 1 ? '' : 's'}`);

  const years = Math.round(months / 12);
  return wrap(future, `${years} year${years === 1 ? '' : 's'}`);
}

function wrap(future: boolean, phrase: string): string {
  return future ? `in ${phrase}` : `${phrase} ago`;
}

/**
 * Deadline-flavoured wording for anything with a due date — vaccinations,
 * refills, follow-ups. Overdue reads as a fact, never a telling-off.
 */
export function dueLabel(value: DateLike, now: DateLike = new Date()): string {
  const date = toDate(value);
  const reference = toDate(now) ?? new Date();
  if (!date) return 'No date set';

  const days = differenceInCalendarDays(date, reference);
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  if (days === -1) return 'a day overdue';
  if (days < -1) return `${Math.abs(days)} days overdue`;
  if (days < 7) return `due ${WEEKDAY_LONG[date.getDay()] ?? 'soon'}`;
  // "due next Friday" beats "due next week" — a weekday is something you can
  // picture, and picturing it is what gets the appointment booked.
  if (days < 14) return `due next ${WEEKDAY_LONG[date.getDay()] ?? 'week'}`;
  if (days < 31) return `due in ${Math.round(days / 7)} weeks`;
  return `due ${formatDay(date, reference)}`;
}

/** `"in 1 hour"`, `"in 30 minutes"` — for reminder-offset copy. */
export function countdownLabel(minutesAhead: number): string {
  const mins = Math.max(0, Math.round(minutesAhead));
  if (mins === 0) return 'now';
  if (mins < 60) return `in ${mins} minute${mins === 1 ? '' : 's'}`;
  if (mins < 60 * 24) {
    const hours = Math.round(mins / 60);
    return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const days = Math.round(mins / (60 * 24));
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

/** `90` → `"1 hr 30 min"`. Appointment durations, visit lengths. */
export function formatDurationMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  const hourPart = `${hours} hr`;
  return rest === 0 ? hourPart : `${hourPart} ${rest} min`;
}

export function minutesUntil(value: DateLike, now: DateLike = new Date()): number | null {
  const date = toDate(value);
  const reference = toDate(now) ?? new Date();
  return date ? differenceInMinutes(date, reference) : null;
}

/* -------------------------------------------------------------------- age */

export function ageInMonths(birthday: DateOnly | null | undefined, now: DateLike = new Date()): number | null {
  const born = toDate(birthday);
  const reference = toDate(now) ?? new Date();
  if (!born || born.getTime() > reference.getTime()) return null;
  return Math.max(0, differenceInMonths(reference, born));
}

/**
 * `"4 years 2 months"`, `"7 months"`, `"3 weeks"`.
 *
 * Precision tapers with age on purpose: a kitten's weeks matter, a nine-year-old
 * cat's months don't, and "9 years 0 months" is a robot talking.
 */
export function ageFromBirthday(
  birthday: DateOnly | null | undefined,
  now: DateLike = new Date(),
): string | null {
  const born = toDate(birthday);
  const reference = toDate(now) ?? new Date();
  if (!born || born.getTime() > reference.getTime()) return null;

  const days = differenceInCalendarDays(reference, born);
  if (days < 14) return `${days} day${days === 1 ? '' : 's'}`;
  if (days < 60) {
    const weeks = Math.floor(days / 7);
    return `${weeks} week${weeks === 1 ? '' : 's'}`;
  }

  const months = differenceInMonths(reference, born);
  if (months < 24) return `${months} month${months === 1 ? '' : 's'}`;

  const years = Math.floor(months / 12);
  const restMonths = months % 12;
  if (years >= 10 || restMonths === 0) return `${years} years`;
  return `${years} year${years === 1 ? '' : 's'} ${restMonths} month${restMonths === 1 ? '' : 's'}`;
}

/** For rescues with no known birthday — hedged wording, deliberately. */
export function ageFromApproxMonths(months: number | null | undefined): string | null {
  if (months === null || months === undefined || months < 0) return null;
  const whole = Math.round(months);
  if (whole < 12) return `about ${whole} month${whole === 1 ? '' : 's'}`;
  const years = Math.round(whole / 12);
  return `about ${years} year${years === 1 ? '' : 's'}`;
}

/** Whichever of the two the pet actually has. Null means "we genuinely don't know". */
export function describeAge(
  pet: Pick<Pet, 'birthday' | 'approximateAgeMonths'>,
  now: DateLike = new Date(),
): string | null {
  return ageFromBirthday(pet.birthday, now) ?? ageFromApproxMonths(pet.approximateAgeMonths);
}

/* ----------------------------------------------------------------- ranges */

export type DateWindow = { start: DateLike | null; end: DateLike | null };

/** Null bounds are open — matches how caregiver windows are stored. */
export function windowsOverlap(a: DateWindow, b: DateWindow): boolean {
  const aStart = toDate(a.start)?.getTime() ?? Number.NEGATIVE_INFINITY;
  const aEnd = toDate(a.end)?.getTime() ?? Number.POSITIVE_INFINITY;
  const bStart = toDate(b.start)?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bEnd = toDate(b.end)?.getTime() ?? Number.POSITIVE_INFINITY;
  if (aStart > aEnd || bStart > bEnd) return false;
  return aStart <= bEnd && bStart <= aEnd;
}

export function isWithinWindow(value: DateLike, window: DateWindow): boolean {
  const t = toDate(value)?.getTime();
  if (t === undefined) return false;
  const start = toDate(window.start)?.getTime() ?? Number.NEGATIVE_INFINITY;
  const end = toDate(window.end)?.getTime() ?? Number.POSITIVE_INFINITY;
  return t >= start && t <= end;
}

/** Inclusive list of calendar days — powers the week strip and adherence grid. */
export function dayRange(from: DateLike, to: DateLike): DateOnly[] {
  const start = toDate(from);
  const end = toDate(to);
  if (!start || !end) return [];
  const [lo, hi] = start.getTime() <= end.getTime() ? [start, end] : [end, start];
  return eachDayOfInterval({ start: startOfDay(lo), end: startOfDay(hi) }).map((d) =>
    format(d, 'yyyy-MM-dd'),
  );
}

/** The last `count` days ending today, oldest first. */
export function lastNDays(count: number, endingAt: DateLike = new Date()): DateOnly[] {
  const end = toDate(endingAt) ?? new Date();
  const n = Math.max(1, Math.trunc(count));
  return dayRange(addDays(end, -(n - 1)), end);
}

/** `[1,2,3,4,5]` → `"Weekdays"`, `[1,3,5]` → `"Mon, Wed & Fri"`. */
export function weekdaysLabel(days?: readonly number[] | null): string {
  const normalized = normalizeWeekdays(days);
  if (normalized.length === 7) return 'Every day';
  const key = normalized.join(',');
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '0,6') return 'Weekends';

  const names = normalized.map((d) => WEEKDAY_SHORT[d] ?? '').filter(Boolean);
  if (names.length === 1) return `${WEEKDAY_LONG[normalized[0] ?? 0]}s`;
  const last = names[names.length - 1];
  return `${names.slice(0, -1).join(', ')} & ${last}`;
}
