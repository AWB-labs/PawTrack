/**
 * Petal — getting a vet appointment onto the phone's own calendar.
 *
 * Expo Go rules out `expo-calendar` (it needs a native permission and a
 * prebuild), so this module does the next best thing and hands the event to
 * something that already exists on every device. Two routes, in order:
 *
 *  1. **A calendar draft link.** An `https` "new event" URL opens the calendar
 *     app on Android, and Safari-then-Calendar on iOS, with every field already
 *     filled in. It is one tap from there to a real entry, and it needs no
 *     permission dialog at all.
 *  2. **The share sheet**, when nothing can open the link. The message carries
 *     the same facts in a form a person can paste into whatever they use.
 *
 * The RFC 5545 document is built regardless and travels on the payload: mail
 * clients, vet portals and desktop calendars all understand it, and having it
 * means "export this visit" is a one-line feature later rather than a rewrite.
 *
 * Nothing here reaches for a new dependency — the link is opened through the
 * `expo-linking` wrapper in `lib/deeplinks`, and sharing goes through
 * `lib/share`, so the fallbacks and failure copy stay consistent with the rest
 * of the app.
 */

import type { Appointment } from '@/data/types';
import { formatDurationMinutes, friendlyDateTime, toDate } from '@/lib/date';
import { openExternal } from '@/lib/deeplinks';
import { possessive } from '@/lib/format';
import { isDismissed, shareText } from '@/lib/share';

/* -------------------------------------------------------------------- types */

export type CalendarEventInput = {
  appointment: Appointment;
  petName: string;
  /** Human label for `appointment.type` — "Vaccination", "Check-up". */
  typeLabel?: string;
};

export type CalendarPayload = {
  title: string;
  description: string;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  /** RFC 5545 document, alarms included. */
  ics: string;
  /** Pre-filled "new event" link, openable by a calendar app or a browser. */
  url: string;
  /** The sentence that goes out when we fall back to the share sheet. */
  message: string;
};

export type CalendarOutcome =
  | { ok: true; via: 'calendar' | 'share'; payload: CalendarPayload }
  | { ok: false; reason: 'no-date' | 'dismissed' | 'failed'; message: string };

/* ---------------------------------------------------------------- constants */

const PRODUCT_ID = '-//Petal//Pet care//EN';

/**
 * Google's template endpoint is the one "create an event" URL that resolves
 * everywhere: the Google Calendar app claims it on Android, and on iOS it opens
 * in the browser where the user is one tap from adding it to whichever calendar
 * their account already syncs.
 */
const DRAFT_ENDPOINT = 'https://calendar.google.com/calendar/render';

/** A visit with no stated length still needs to occupy something. */
const DEFAULT_DURATION_MIN = 30;

/** RFC 5545 caps a content line at 75 octets, continuations start with a space. */
const LINE_LIMIT = 74;

/* ------------------------------------------------------------------ helpers */

/** `20260912T140000Z`. UTC throughout — an appointment is an instant, not a wall clock. */
function stamp(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

/** Escape the four characters iCalendar treats as structure. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function fold(line: string): string {
  if (line.length <= LINE_LIMIT) return line;
  const parts = [line.slice(0, LINE_LIMIT)];
  let rest = line.slice(LINE_LIMIT);
  while (rest.length > 0) {
    parts.push(` ${rest.slice(0, LINE_LIMIT - 1)}`);
    rest = rest.slice(LINE_LIMIT - 1);
  }
  return parts.join('\r\n');
}

function query(params: Record<string, string | null>): string {
  return Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== null && entry[1] !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
}

/* ------------------------------------------------------------------ builder */

/**
 * Everything a calendar needs, derived once. Returns `null` only when the
 * appointment has no parseable time — which is a data fault, not a user error,
 * so the caller turns it into "we couldn't read the date" rather than a crash.
 */
export function buildCalendarPayload(input: CalendarEventInput): CalendarPayload | null {
  const { appointment, petName, typeLabel } = input;

  const startsAt = toDate(appointment.at);
  if (!startsAt) return null;

  const minutes = appointment.durationMin > 0 ? appointment.durationMin : DEFAULT_DURATION_MIN;
  const endsAt = new Date(startsAt.getTime() + minutes * 60_000);

  const title = `${petName} — ${appointment.reason}`;
  const location = appointment.clinicAddress ?? appointment.clinic ?? null;

  const detail = [
    typeLabel ? `${typeLabel} for ${petName}` : `Vet visit for ${petName}`,
    appointment.clinic ? `Clinic: ${appointment.clinic}` : null,
    appointment.vetName ? `Vet: ${appointment.vetName}` : null,
    `Allow ${formatDurationMinutes(minutes)}`,
    appointment.clinicPhone ? `Phone: ${appointment.clinicPhone}` : null,
    appointment.notes?.trim() ? `Notes: ${appointment.notes.trim()}` : null,
    'Added from Petal 🐾',
  ].filter((line): line is string => line !== null);

  const description = detail.join('\n');

  const message = [
    `${possessive(petName)} vet visit`,
    '',
    `${appointment.reason}${appointment.clinic ? ` at ${appointment.clinic}` : ''}`,
    friendlyDateTime(startsAt),
    location && location !== appointment.clinic ? location : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  return {
    title,
    description,
    location,
    startsAt,
    endsAt,
    ics: buildIcs(appointment, { title, description, location, startsAt, endsAt }),
    url: `${DRAFT_ENDPOINT}?${query({
      action: 'TEMPLATE',
      text: title,
      dates: `${stamp(startsAt)}/${stamp(endsAt)}`,
      details: description,
      location,
    })}`,
    message,
  };
}

type IcsFields = {
  title: string;
  description: string;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
};

/**
 * The event as a standards document. Each reminder offset becomes a `VALARM`,
 * so an entry imported into a real calendar keeps the nudges the owner chose
 * here instead of silently losing them.
 */
export function buildIcs(appointment: Appointment, fields: IcsFields): string {
  const alarms = [...new Set(appointment.reminderOffsets)]
    .filter((offset) => Number.isFinite(offset) && offset > 0)
    .sort((a, b) => b - a)
    .flatMap((offset) => [
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeText(fields.title)}`,
      `TRIGGER:-PT${Math.round(offset)}M`,
      'END:VALARM',
    ]);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODUCT_ID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:petal-appointment-${appointment.id}@petal.app`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(fields.startsAt)}`,
    `DTEND:${stamp(fields.endsAt)}`,
    `SUMMARY:${escapeText(fields.title)}`,
    `DESCRIPTION:${escapeText(fields.description)}`,
    fields.location ? `LOCATION:${escapeText(fields.location)}` : null,
    `STATUS:${appointment.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
    ...alarms,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter((line): line is string => line !== null);

  return lines.map(fold).join('\r\n');
}

/* ------------------------------------------------------------------ actions */

/** Hand the draft link to whatever handles calendars on this device. */
export async function openInCalendar(payload: CalendarPayload): Promise<boolean> {
  return openExternal(payload.url);
}

/** The fallback route — the same facts, through the system share sheet. */
export async function shareCalendarInvite(payload: CalendarPayload): Promise<CalendarOutcome> {
  const outcome = await shareText(payload.message, payload.url);
  if (outcome.ok) return { ok: true, via: 'share', payload };
  if (isDismissed(outcome)) return { ok: false, reason: 'dismissed', message: '' };
  return { ok: false, reason: 'failed', message: outcome.message };
}

/**
 * The one call a screen makes. Tries the calendar, falls back to sharing, and
 * always comes back with something the UI can say out loud.
 */
export async function addToCalendar(input: CalendarEventInput): Promise<CalendarOutcome> {
  const payload = buildCalendarPayload(input);
  if (!payload) {
    return {
      ok: false,
      reason: 'no-date',
      message: 'This visit doesn’t have a readable date yet. Open it and set the day and time first.',
    };
  }

  if (await openInCalendar(payload)) return { ok: true, via: 'calendar', payload };
  return shareCalendarInvite(payload);
}

export const calendar = {
  buildCalendarPayload,
  buildIcs,
  openInCalendar,
  shareCalendarInvite,
  addToCalendar,
};

export default calendar;
