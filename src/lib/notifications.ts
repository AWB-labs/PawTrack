/**
 * Petal — local notifications.
 *
 * **Local only, deliberately.** Remote push needs a development build: Expo Go
 * dropped push-token support in SDK 53, and everything Petal reminds you about
 * is already known on-device — a feeding time, a dose, a due date. Nothing here
 * touches `getExpoPushTokenAsync`. When remote push is added it belongs in a
 * separate module behind a dev-build check, not bolted onto these schedulers.
 *
 * Three things this module takes seriously:
 *
 *  1. **Cancellation has to be reliable.** OS notification ids are opaque and
 *     the OS won't tell you which of them belongs to Buddy's dinner. So every
 *     scheduled id is written to an AsyncStorage registry keyed by
 *     `kind:entityId:slot`. Delete a feeding schedule and the reminder actually
 *     dies, rather than firing forever for a meal that no longer exists.
 *  2. **Copy is the product.** A reminder is the only part of Petal most people
 *     see on a normal Tuesday. "Notification: feeding_schedule_1 due" is a
 *     failure. Every body below names the pet and sounds like a person, and the
 *     variant rotates by day so week three doesn't read like week one.
 *  3. **iOS caps pending notifications at 64.** A daily trigger costs one slot,
 *     not 365, which is why repeating triggers are used wherever the schedule
 *     is genuinely repeating — but `MAX_PER_PET` still guards the long tail.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { differenceInCalendarDays, endOfDay, getDayOfYear } from 'date-fns';
import * as Notifications from 'expo-notifications';
import { router, useRootNavigationState } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import type {
  Appointment,
  FeedingSchedule,
  ID,
  Medicine,
  Pet,
  TimeOfDay,
  Vaccination,
} from '@/data/types';
import { moss } from '@/theme/tokens';

import {
  applyTimeOfDay,
  countdownLabel,
  dueLabel,
  formatClock,
  formatDay,
  formatTimeOfDay,
  minutesToTimeOfDay,
  nextOccurrence,
  normalizeWeekdays,
  parseTimeOfDay,
  toDate,
  WEEKDAY_LONG,
} from './date';
import { hrefFor, toHref, type PetSection } from './deeplinks';
import { logError } from './errors';
import { formatPortion, possessive } from './format';

/* ------------------------------------------------------------- constants */

export const CHANNEL = {
  /** Things that need doing now. Full volume, heads-up on Android. */
  reminders: 'petal-reminders',
  /** Nudges that can wait. Silent, no vibration, no interruption. */
  updates: 'petal-updates',
} as const;

export type ChannelId = (typeof CHANNEL)[keyof typeof CHANNEL];
export type ChannelName = keyof typeof CHANNEL;

export type ReminderKind = 'feeding' | 'medicine' | 'vaccination' | 'appointment' | 'refill';

/** Where a tap lands, per kind. */
const SECTION_FOR: Record<ReminderKind, PetSection> = {
  feeding: 'feeding',
  medicine: 'medicine',
  vaccination: 'vaccinations',
  appointment: 'appointments',
  refill: 'medicine',
};

/**
 * Soft ceiling per pet. iOS keeps only the 64 soonest pending notifications
 * across the whole app, so a household with four pets and a rolling batch of
 * every-other-day doses can quietly evict the reminders that matter.
 */
const MAX_PER_PET = 24;

/** How many dose dates to pre-arm for schedules the OS can't express natively. */
const ROLLING_DOSE_DAYS = 7;

/**
 * Vaccinations get a warning, then a nudge on the day. Five days rather than
 * seven so the warning names the weekday — "due Friday" is something you can
 * picture and act on; "due next Friday" is something you forget by Wednesday.
 */
const VACCINATION_LEAD_DAYS = 5;
const VACCINATION_HOUR: TimeOfDay = '09:00';

/** Refill nudges land after work, when ringing the vet is still possible. */
const REFILL_HOUR: TimeOfDay = '18:00';
const REFILL_LEAD_DAYS = 3;

/** Mirrors `expo.plugins.expo-notifications.color` in app.json. */
const ANDROID_ACCENT = moss[500];

const STORAGE_KEY = 'petal.notifications.registry.v1';

/* ----------------------------------------------------------------- types */

export type PermissionOutcome =
  | { granted: true; provisional: boolean }
  | { granted: false; canAskAgain: boolean; reason: 'denied' | 'unsupported' };

export type ScheduleSkipReason =
  | 'reminders-off'
  | 'inactive'
  | 'no-permission'
  | 'in-the-past'
  | 'not-applicable'
  | 'invalid-time';

export type ScheduleResult =
  | { scheduled: true; ids: string[]; nextAt: string | null }
  | { scheduled: false; reason: ScheduleSkipReason };

/** Payload carried on every notification, so a tap knows where to go. */
export type NotificationPayload = {
  v: 1;
  kind: ReminderKind;
  channel: ChannelName;
  petId: ID;
  petName: string;
  entityId: ID;
  /** In-app path, resolved at schedule time. */
  path: string;
};

/** Everything needed to rebuild one pet's reminders from scratch. */
export type PetReminderBundle = {
  pet: Pet;
  feedingSchedules: readonly FeedingSchedule[];
  medicines: readonly Medicine[];
  vaccinations: readonly Vaccination[];
  appointments: readonly Appointment[];
};

export type RescheduleReport = {
  petId: ID;
  scheduled: number;
  skipped: number;
  /** True when `MAX_PER_PET` clipped the tail — the settings screen can say so. */
  truncated: boolean;
};

const SKIPPED = (reason: ScheduleSkipReason): ScheduleResult => ({ scheduled: false, reason });

/* ------------------------------------------------------------- registry */

type RegistryEntry = {
  ids: string[];
  petId: ID;
  kind: ReminderKind;
  entityId: ID;
  /** Distinguishes the several reminders one entity can own (dose times, offsets). */
  slot: string;
  updatedAt: string;
};

type Registry = Record<string, RegistryEntry>;

let cache: Registry | null = null;
/** Serialises read-modify-write so two schedulers can't clobber each other. */
let writeQueue: Promise<unknown> = Promise.resolve();

function keyFor(kind: ReminderKind, entityId: ID, slot: string): string {
  return `${kind}:${entityId}:${slot}`;
}

async function readRegistry(): Promise<Registry> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    cache = isRegistry(parsed) ? parsed : {};
  } catch (error) {
    logError('notifications.readRegistry', error);
    cache = {};
  }
  return cache;
}

function isRegistry(value: unknown): value is Registry {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => undefined);
  return run;
}

async function persist(next: Registry): Promise<void> {
  cache = next;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    logError('notifications.persist', error);
  }
}

/* ---------------------------------------------------------- setup & perms */

let channelsReady = false;
let permissionCache: { value: PermissionOutcome; at: number } | null = null;
const PERMISSION_TTL_MS = 30_000;

/**
 * Foreground behaviour. Without a handler the OS drops notifications that
 * arrive while the app is open — which is exactly when a dinner reminder is
 * most useful, since you're probably already in the app.
 */
export function configureNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const payload = parseNotificationPayload(notification.request.content.data);
      const quiet = payload?.channel === 'updates';
      return {
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: !quiet,
        // A permanent red dot for a meal that's five minutes away is nagging.
        shouldSetBadge: false,
        priority: quiet
          ? Notifications.AndroidNotificationPriority.LOW
          : Notifications.AndroidNotificationPriority.HIGH,
      };
    },
    handleError: (id, error) => logError(`notifications.handle:${id}`, error),
  });
}

/**
 * Android channels. Two of them, because the OS lets users mute a channel
 * individually: someone who finds refill nudges noisy can silence those without
 * also silencing the dose that keeps their cat's thyroid in check.
 */
export async function ensureAndroidChannels(): Promise<void> {
  if (Platform.OS !== 'android' || channelsReady) return;
  try {
    await Notifications.setNotificationChannelAsync(CHANNEL.reminders, {
      name: 'Care reminders',
      description: 'Meals, medicine and appointments that need doing.',
      importance: Notifications.AndroidImportance.HIGH,
      lightColor: ANDROID_ACCENT,
      enableLights: true,
      enableVibrate: true,
      vibrationPattern: [0, 220, 120, 220],
      // Pet care isn't a secret, and a hidden reminder is a missed one.
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      showBadge: true,
      sound: 'default',
    });

    await Notifications.setNotificationChannelAsync(CHANNEL.updates, {
      name: 'Gentle nudges',
      description: 'Refill reminders and heads-ups that can wait until you look.',
      importance: Notifications.AndroidImportance.LOW,
      lightColor: ANDROID_ACCENT,
      enableLights: false,
      enableVibrate: false,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      showBadge: false,
      sound: null,
    });

    channelsReady = true;
  } catch (error) {
    logError('notifications.ensureAndroidChannels', error);
  }
}

function toOutcome(status: Notifications.NotificationPermissionsStatus): PermissionOutcome {
  const provisional = status.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
  if (status.granted || provisional) return { granted: true, provisional };
  return { granted: false, canAskAgain: status.canAskAgain, reason: 'denied' };
}

/** Current state, without prompting. Cached briefly so bulk scheduling is cheap. */
export async function getPermission(): Promise<PermissionOutcome> {
  if (permissionCache && Date.now() - permissionCache.at < PERMISSION_TTL_MS) {
    return permissionCache.value;
  }
  try {
    const value = toOutcome(await Notifications.getPermissionsAsync());
    permissionCache = { value, at: Date.now() };
    return value;
  } catch (error) {
    logError('notifications.getPermission', error);
    return { granted: false, canAskAgain: false, reason: 'unsupported' };
  }
}

/**
 * Ask. Call this from an explaining screen, never on first launch — a cold
 * permission prompt is the fastest way to a permanent "Don't Allow", and iOS
 * only ever asks once.
 */
export async function requestPermission(): Promise<PermissionOutcome> {
  try {
    const status = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: true, allowSound: true },
    });
    const value = toOutcome(status);
    permissionCache = { value, at: Date.now() };
    if (value.granted) await ensureAndroidChannels();
    return value;
  } catch (error) {
    logError('notifications.requestPermission', error);
    return { granted: false, canAskAgain: false, reason: 'unsupported' };
  }
}

/**
 * The graceful denied path. Reminders are a feature, not a gate — the copy says
 * what's lost and offers the one action that fixes it, then gets out of the way.
 */
export function permissionCopy(outcome: PermissionOutcome): {
  title: string;
  body: string;
  action: 'request' | 'openSettings' | 'none';
  actionLabel: string | null;
} {
  if (outcome.granted) {
    return outcome.provisional
      ? {
          title: 'Reminders are on, quietly',
          body: 'They’ll arrive silently in your notification centre. Turn on alerts if you’d rather be interrupted for a dose.',
          action: 'openSettings',
          actionLabel: 'Open settings',
        }
      : {
          title: 'Reminders are on',
          body: 'We’ll nudge you for meals, doses and vet visits — and never for anything else.',
          action: 'none',
          actionLabel: null,
        };
  }

  if (outcome.reason === 'unsupported') {
    return {
      title: 'Reminders aren’t available here',
      body: 'This device can’t schedule notifications. Everything still shows on the Today screen when you open Furry Tracker.',
      action: 'none',
      actionLabel: null,
    };
  }

  return outcome.canAskAgain
    ? {
        title: 'Never miss a dose',
        body: 'Let Furry Tracker send reminders and we’ll nudge you at feeding time, dose time and the day before a vet visit.',
        action: 'request',
        actionLabel: 'Turn on reminders',
      }
    : {
        title: 'Reminders are switched off',
        body: 'Notifications are off for Furry Tracker in your phone’s settings. Turn them back on and every schedule you’ve set starts working again.',
        action: 'openSettings',
        actionLabel: 'Open settings',
      };
}

/** Handler + channels + registry reconciliation, in the right order. */
export async function initNotifications(): Promise<void> {
  configureNotificationHandler();
  await ensureAndroidChannels();
  await syncRegistry();
}

/* -------------------------------------------------------------- copy bank */

type Copy = { title: string; body: string };

/**
 * Deterministic-but-varied. Seeded from the day of the year plus a hash of the
 * entity, so: the same reminder rescheduled twice in one day reads identically
 * (no flicker), two pets never get the same phrasing on the same day, and the
 * wording moves on tomorrow.
 */
function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function pick<C>(variants: readonly ((context: C) => Copy)[], entityId: string, context: C): Copy {
  const seed = getDayOfYear(new Date()) + hash(entityId);
  const variant = variants[seed % variants.length] ?? variants[0];
  return variant ? variant(context) : { title: 'Furry Tracker', body: '' };
}

/** Small numbers read better as words in a sentence. */
const SPELLED = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

function spell(count: number, noun: string): string {
  const n = Math.max(0, Math.round(count));
  const word = n <= 10 ? SPELLED[n] : String(n);
  return `${word} ${n === 1 ? noun : `${noun}s`}`;
}

type FeedingCopy = { name: string; label: string; portion: string; food: string };

const FEEDING_VARIANTS: readonly ((c: FeedingCopy) => Copy)[] = [
  (c) => ({
    title: `${possessive(c.name)} ${c.label.toLowerCase()} time! 🐾`,
    body: `${c.portion} of ${c.food} — the bowl awaits.`,
  }),
  (c) => ({
    title: `Bowl o’clock for ${c.name}`,
    body: `${c.label}: ${c.portion} of ${c.food}.`,
  }),
  (c) => ({
    title: `${c.name} is doing the hungry stare`,
    body: `${c.label} is due — ${c.portion} of ${c.food}.`,
  }),
  (c) => ({
    title: `${c.label} for ${c.name} 🍽️`,
    body: `${c.portion} of ${c.food}. Tick it off once it’s down.`,
  }),
  (c) => ({
    title: `Time to feed ${c.name}`,
    body: `${c.label} — ${c.portion} of ${c.food}.`,
  }),
  (c) => ({
    title: `${possessive(c.name)} ${c.label.toLowerCase()}, coming up`,
    body: `${c.portion} of ${c.food} whenever you’re ready.`,
  }),
];

type MedicineCopy = { name: string; medicine: string; dosage: string; timeLabel: string; withFood: boolean };

const MEDICINE_VARIANTS: readonly ((c: MedicineCopy) => Copy)[] = [
  (c) => ({
    title: `${possessive(c.name)} ${c.timeLabel} dose`,
    body: `${c.dosage} of ${c.medicine}${c.withFood ? ', with food' : ''}.`,
  }),
  (c) => ({
    title: `Medicine time for ${c.name} 💊`,
    body: `${c.medicine} — ${c.dosage}${c.withFood ? '. Tuck it into a snack.' : '.'}`,
  }),
  (c) => ({
    title: `${c.timeLabel}: ${c.medicine} for ${c.name}`,
    body: `${c.dosage}${c.withFood ? ', best given with food' : ''}. Log it once it’s down.`,
  }),
  (c) => ({
    title: `Don’t forget ${possessive(c.name)} ${c.medicine}`,
    body: `${c.dosage} due at ${c.timeLabel}${c.withFood ? ', with food' : ''}.`,
  }),
  (c) => ({
    title: `${c.name} is due a dose`,
    body: `${c.medicine}, ${c.dosage}${c.withFood ? ', with food' : ''}. Two taps and it’s logged.`,
  }),
];

type VaccinationCopy = { name: string; vaccine: string; due: string };

const VACCINATION_VARIANTS: readonly ((c: VaccinationCopy) => Copy)[] = [
  (c) => ({
    title: `${possessive(c.name)} ${c.vaccine} is ${c.due}`,
    body: 'Want to book it? A quick call now beats a scramble later.',
  }),
  (c) => ({
    title: `Vaccination coming up for ${c.name}`,
    body: `${c.vaccine} is ${c.due}. Tap to book it — or mark it done if you already have.`,
  }),
  (c) => ({
    title: `${c.vaccine} ${c.due}`,
    body: `${possessive(c.name)} booster is coming round again. Shall we get it in the diary?`,
  }),
  (c) => ({
    title: `Time to sort ${possessive(c.name)} ${c.vaccine}`,
    body: `It’s ${c.due}. Book it now and we’ll track the next one for you.`,
  }),
];

type AppointmentCopy = { name: string; reason: string; clinic: string | null; when: string; lead: string };

/**
 * `when` is built to read mid-sentence from either end ("9:30am tomorrow"), so
 * no variant has to worry about capitalising it or landing on the clumsy
 * "Today 9:30am" that a generic date formatter would hand back.
 */
function whenPhrase(at: Date, from: Date): string {
  const clock = formatClock(at);
  const days = differenceInCalendarDays(at, from);
  if (days === 0) return `${clock} today`;
  if (days === 1) return `${clock} tomorrow`;
  if (days > 1 && days < 7) return `${clock} on ${WEEKDAY_LONG[at.getDay()]}`;
  return `${clock} on ${formatDay(at, from)}`;
}

const APPOINTMENT_VARIANTS: readonly ((c: AppointmentCopy) => Copy)[] = [
  (c) => ({
    title: `${possessive(c.name)} appointment is ${c.lead}`,
    body: `${c.reason}${c.clinic ? ` at ${c.clinic}` : ''} — ${c.when}.`,
  }),
  (c) => ({
    title: `Vet trip ${c.lead} 🚗`,
    body: `${c.name}: ${c.reason}${c.clinic ? `, ${c.clinic}` : ''}. ${c.when}.`,
  }),
  (c) => ({
    title: `Heads up — ${c.name} is due at the vet`,
    body: `${c.reason}${c.clinic ? ` at ${c.clinic}` : ''}, ${c.when}. Leave a few minutes spare.`,
  }),
  (c) => ({
    title: `${c.reason} for ${c.name}`,
    body: `${c.when}${c.clinic ? ` at ${c.clinic}` : ''} — that’s ${c.lead}.`,
  }),
];

type RefillCopy = { name: string; medicine: string; remaining: string };

const REFILL_VARIANTS: readonly ((c: RefillCopy) => Copy)[] = [
  (c) => ({
    title: `${possessive(c.name)} ${c.medicine} is running low`,
    body: `${capitalise(c.remaining)} left — worth a refill this week.`,
  }),
  (c) => ({
    title: `Refill time for ${c.name}`,
    body: `${c.medicine} is down to ${c.remaining}. Worth ringing the vet before it runs out.`,
  }),
  (c) => ({
    title: `${capitalise(c.remaining)} of ${c.medicine} left`,
    body: `Order ${possessive(c.name)} refill now and there’s no gap in the course.`,
  }),
  (c) => ({
    title: 'Don’t get caught short',
    body: `${possessive(c.name)} ${c.medicine} has ${c.remaining} left. Time to reorder.`,
  }),
];

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/* --------------------------------------------------------- scheduling core */

function payloadFor(kind: ReminderKind, pet: Pet, entityId: ID, channel: ChannelName): NotificationPayload {
  return {
    v: 1,
    kind,
    channel,
    petId: pet.id,
    petName: pet.name,
    entityId,
    path: hrefFor({ kind: 'pet', petId: pet.id, section: SECTION_FOR[kind] }),
  };
}

export function parseNotificationPayload(raw: unknown): NotificationPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const data = raw as Partial<NotificationPayload>;
  if (data.v !== 1 || typeof data.petId !== 'string' || typeof data.path !== 'string') return null;
  if (typeof data.kind !== 'string' || !(data.kind in SECTION_FOR)) return null;
  return {
    v: 1,
    kind: data.kind,
    channel: data.channel === 'updates' ? 'updates' : 'reminders',
    petId: data.petId,
    petName: typeof data.petName === 'string' ? data.petName : '',
    entityId: typeof data.entityId === 'string' ? data.entityId : '',
    path: data.path,
  };
}

function contentFor(
  copy: Copy,
  payload: NotificationPayload,
  channel: ChannelName,
  urgent: boolean,
): Notifications.NotificationContentInput {
  return {
    title: copy.title,
    body: copy.body,
    data: { ...payload },
    sound: channel === 'reminders',
    color: ANDROID_ACCENT,
    // `timeSensitive` needs Apple's entitlement; without it iOS quietly treats
    // this as `active`, which is the behaviour we'd want anyway.
    interruptionLevel: urgent ? 'timeSensitive' : channel === 'updates' ? 'passive' : 'active',
    autoDismiss: true,
  };
}

/**
 * Replace every notification held under one key. Cancel-then-schedule is the
 * only ordering that can't leave a duplicate behind if the app dies mid-way.
 */
async function commit(
  kind: ReminderKind,
  petId: ID,
  entityId: ID,
  slot: string,
  requests: readonly Notifications.NotificationRequestInput[],
): Promise<string[]> {
  return enqueue(async () => {
    const registry = { ...(await readRegistry()) };
    const key = keyFor(kind, entityId, slot);

    await cancelIds(registry[key]?.ids ?? []);
    delete registry[key];

    const ids: string[] = [];
    for (const request of requests) {
      try {
        ids.push(await Notifications.scheduleNotificationAsync(request));
      } catch (error) {
        logError(`notifications.schedule:${kind}`, error);
      }
    }

    if (ids.length > 0) {
      registry[key] = { ids, petId, kind, entityId, slot, updatedAt: new Date().toISOString() };
    }
    await persist(registry);
    return ids;
  });
}

async function cancelIds(ids: readonly string[]): Promise<void> {
  await Promise.all(
    ids.map(async (id) => {
      try {
        await Notifications.cancelScheduledNotificationAsync(id);
      } catch {
        /* already fired or already cancelled — nothing to undo */
      }
    }),
  );
}

/** Cancel every reminder belonging to one entity, across all its slots. */
export async function cancelForEntity(kind: ReminderKind, entityId: ID): Promise<void> {
  await enqueue(async () => {
    const registry = { ...(await readRegistry()) };
    const doomed = Object.entries(registry).filter(
      ([, entry]) => entry.kind === kind && entry.entityId === entityId,
    );
    if (doomed.length === 0) return;

    await cancelIds(doomed.flatMap(([, entry]) => entry.ids));
    for (const [key] of doomed) delete registry[key];
    await persist(registry);
  });
}

export async function cancelAllForPet(petId: ID): Promise<void> {
  await enqueue(async () => {
    const registry = { ...(await readRegistry()) };
    const doomed = Object.entries(registry).filter(([, entry]) => entry.petId === petId);
    if (doomed.length === 0) return;

    await cancelIds(doomed.flatMap(([, entry]) => entry.ids));
    for (const [key] of doomed) delete registry[key];
    await persist(registry);
  });
}

/** Used when the user turns reminders off wholesale, or signs out. */
export async function cancelEverything(): Promise<void> {
  await enqueue(async () => {
    try {
      await Notifications.cancelAllScheduledNotificationsAsync();
    } catch (error) {
      logError('notifications.cancelEverything', error);
    }
    await persist({});
  });
}

/**
 * Drop registry rows whose notifications the OS no longer has — non-repeating
 * ones expire after firing, and without this the registry grows forever and
 * `cancelForEntity` spends its time cancelling ghosts.
 */
export async function syncRegistry(): Promise<void> {
  await enqueue(async () => {
    let live: Set<string>;
    try {
      const scheduled = await Notifications.getAllScheduledNotificationsAsync();
      live = new Set(scheduled.map((request) => request.identifier));
    } catch (error) {
      logError('notifications.syncRegistry', error);
      return;
    }

    const registry = { ...(await readRegistry()) };
    let changed = false;
    for (const [key, entry] of Object.entries(registry)) {
      const ids = entry.ids.filter((id) => live.has(id));
      if (ids.length === entry.ids.length) continue;
      changed = true;
      if (ids.length === 0) delete registry[key];
      else registry[key] = { ...entry, ids };
    }
    if (changed) await persist(registry);
  });
}

/** How many reminders a pet currently holds — for the notifications settings row. */
export async function countScheduledForPet(petId: ID): Promise<number> {
  const registry = await readRegistry();
  return Object.values(registry)
    .filter((entry) => entry.petId === petId)
    .reduce((total, entry) => total + entry.ids.length, 0);
}

/* --------------------------------------------------------------- feeding */

/**
 * A daily trigger when the schedule runs every day, weekly triggers otherwise.
 * Both are *repeating*, so a seven-day-a-week breakfast costs one of iOS's 64
 * pending slots rather than seven.
 */
export async function scheduleFeedingReminder(
  pet: Pet,
  schedule: FeedingSchedule,
): Promise<ScheduleResult> {
  if (!schedule.active) {
    await cancelForEntity('feeding', schedule.id);
    return SKIPPED('inactive');
  }
  if (!schedule.remindersOn) {
    await cancelForEntity('feeding', schedule.id);
    return SKIPPED('reminders-off');
  }

  const time = parseTimeOfDay(schedule.time);
  if (!time) return SKIPPED('invalid-time');

  const permission = await getPermission();
  if (!permission.granted) return SKIPPED('no-permission');

  const payload = payloadFor('feeding', pet, schedule.id, 'reminders');
  const copy = pick(FEEDING_VARIANTS, schedule.id, {
    name: pet.name,
    label: schedule.label,
    portion: formatPortion(schedule.portion, schedule.unit),
    food: schedule.foodName,
  });
  const content = contentFor(copy, payload, 'reminders', false);

  const days = normalizeWeekdays(schedule.daysOfWeek);
  const requests: Notifications.NotificationRequestInput[] =
    days.length === 7
      ? [
          {
            content,
            trigger: {
              type: Notifications.SchedulableTriggerInputTypes.DAILY,
              hour: time.hour,
              minute: time.minute,
              channelId: CHANNEL.reminders,
            },
          },
        ]
      : days.map((day) => ({
          content,
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
            // expo counts weekdays 1–7 from Sunday; the domain counts 0–6.
            weekday: day + 1,
            hour: time.hour,
            minute: time.minute,
            channelId: CHANNEL.reminders,
          },
        }));

  const ids = await commit('feeding', pet.id, schedule.id, '', requests);
  const next = nextOccurrence(schedule.time, days);
  return { scheduled: true, ids, nextAt: next ? next.toISOString() : null };
}

/* -------------------------------------------------------------- medicine */

const DOSES_PER_DAY: Record<Medicine['frequency'], number> = {
  daily: 1,
  twiceDaily: 2,
  threeTimesDaily: 3,
  everyOtherDay: 0.5,
  weekly: 1 / 7,
  monthly: 1 / 30,
  asNeeded: 0,
};

/** `endsAt` is a calendar day, so the course runs to the *end* of it. */
function medicineWindowOpen(medicine: Medicine, now = new Date()): boolean {
  const end = toDate(medicine.endsAt);
  return !end || endOfDay(end).getTime() >= now.getTime();
}

/**
 * One dose slot. Which native trigger fits depends on the frequency:
 * `daily`/`twiceDaily`/`threeTimesDaily` map straight onto DAILY, weekly and
 * monthly onto their own triggers, and `everyOtherDay` — which no OS trigger
 * expresses — gets a rolling batch of DATE triggers, re-armed on every
 * `rescheduleAllForPet`.
 */
export async function scheduleMedicineReminder(
  pet: Pet,
  medicine: Medicine,
  timeOfDay: TimeOfDay,
): Promise<ScheduleResult> {
  const slot = timeOfDay;

  if (!medicine.active || !medicineWindowOpen(medicine)) {
    await cancelSlot('medicine', medicine.id, slot);
    return SKIPPED('inactive');
  }
  if (!medicine.remindersOn) {
    await cancelSlot('medicine', medicine.id, slot);
    return SKIPPED('reminders-off');
  }
  if (medicine.frequency === 'asNeeded') {
    await cancelSlot('medicine', medicine.id, slot);
    return SKIPPED('not-applicable');
  }

  const time = parseTimeOfDay(timeOfDay);
  if (!time) return SKIPPED('invalid-time');

  const permission = await getPermission();
  if (!permission.granted) return SKIPPED('no-permission');

  const payload = payloadFor('medicine', pet, medicine.id, 'reminders');
  const copy = pick(MEDICINE_VARIANTS, `${medicine.id}:${timeOfDay}`, {
    name: pet.name,
    medicine: medicine.name,
    dosage: medicine.dosage,
    timeLabel: formatTimeOfDay(timeOfDay),
    withFood: medicine.withFood,
  });
  // A missed thyroid dose matters more than a missed dinner; this is the one
  // reminder in Petal that asks to break through Focus.
  const content = contentFor(copy, payload, 'reminders', true);

  const requests = medicineRequests(medicine, time, content);
  if (requests.length === 0) return SKIPPED('in-the-past');

  const ids = await commit('medicine', pet.id, medicine.id, slot, requests);
  const next = nextDoseAt(medicine, timeOfDay);
  return { scheduled: true, ids, nextAt: next ? next.toISOString() : null };
}

function medicineRequests(
  medicine: Medicine,
  time: { hour: number; minute: number },
  content: Notifications.NotificationContentInput,
): Notifications.NotificationRequestInput[] {
  const channelId = CHANNEL.reminders;
  const start = toDate(medicine.startsAt) ?? new Date();

  switch (medicine.frequency) {
    case 'weekly':
      return [
        {
          content,
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
            weekday: start.getDay() + 1,
            hour: time.hour,
            minute: time.minute,
            channelId,
          },
        },
      ];

    case 'monthly':
      return [
        {
          content,
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.MONTHLY,
            day: start.getDate(),
            hour: time.hour,
            minute: time.minute,
            channelId,
          },
        },
      ];

    case 'everyOtherDay':
      return rollingDoseDates(medicine, minutesToTimeOfDay(time.hour * 60 + time.minute)).map((date) => ({
        content,
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date,
          channelId,
        },
      }));

    default:
      return [
        {
          content,
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DAILY,
            hour: time.hour,
            minute: time.minute,
            channelId,
          },
        },
      ];
  }
}

/** The next `ROLLING_DOSE_DAYS` alternating-day slots that are still ahead of us. */
function rollingDoseDates(medicine: Medicine, timeOfDay: TimeOfDay, now = new Date()): Date[] {
  const start = toDate(medicine.startsAt);
  if (!start) return [];
  const endOfCourse = toDate(medicine.endsAt);
  const end = endOfCourse ? endOfDay(endOfCourse) : null;

  const dates: Date[] = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  // Jump straight to today's neighbourhood rather than walking from the start
  // date, which for a two-year-old prescription is thousands of iterations.
  const elapsedDays = Math.floor((now.getTime() - cursor.getTime()) / 86_400_000);
  if (elapsedDays > 0) cursor.setDate(cursor.getDate() + elapsedDays - (elapsedDays % 2));

  for (let step = 0; step < ROLLING_DOSE_DAYS * 2 && dates.length < ROLLING_DOSE_DAYS; step += 1) {
    const at = applyTimeOfDay(cursor, timeOfDay);
    if (at && at.getTime() > now.getTime() && (!end || at.getTime() <= end.getTime())) {
      dates.push(at);
    }
    cursor.setDate(cursor.getDate() + 2);
  }
  return dates;
}

function nextDoseAt(medicine: Medicine, timeOfDay: TimeOfDay): Date | null {
  if (medicine.frequency === 'everyOtherDay') return rollingDoseDates(medicine, timeOfDay)[0] ?? null;
  const start = toDate(medicine.startsAt);
  if (medicine.frequency === 'weekly' && start) return nextOccurrence(timeOfDay, [start.getDay()]);
  return nextOccurrence(timeOfDay);
}

/** Every dose slot for one medicine, with stale slots cleaned up first. */
export async function scheduleMedicineReminders(pet: Pet, medicine: Medicine): Promise<ScheduleResult[]> {
  await cancelStaleSlots('medicine', medicine.id, medicine.timesOfDay);
  const results: ScheduleResult[] = [];
  for (const time of medicine.timesOfDay) {
    results.push(await scheduleMedicineReminder(pet, medicine, time));
  }
  return results;
}

async function cancelSlot(kind: ReminderKind, entityId: ID, slot: string): Promise<void> {
  await enqueue(async () => {
    const registry = { ...(await readRegistry()) };
    const key = keyFor(kind, entityId, slot);
    const entry = registry[key];
    if (!entry) return;
    await cancelIds(entry.ids);
    delete registry[key];
    await persist(registry);
  });
}

/** Drop slots that no longer exist — a dose time the owner deleted, say. */
async function cancelStaleSlots(kind: ReminderKind, entityId: ID, keep: readonly string[]): Promise<void> {
  const alive = new Set(keep);
  await enqueue(async () => {
    const registry = { ...(await readRegistry()) };
    const doomed = Object.entries(registry).filter(
      ([, entry]) => entry.kind === kind && entry.entityId === entityId && !alive.has(entry.slot),
    );
    if (doomed.length === 0) return;
    await cancelIds(doomed.flatMap(([, entry]) => entry.ids));
    for (const [key] of doomed) delete registry[key];
    await persist(registry);
  });
}

/* ---------------------------------------------------------- vaccinations */

/**
 * Two date triggers: a week's warning (enough time to get an appointment) and
 * one on the day itself. Whichever has already passed is simply not scheduled,
 * so adding a vaccination that's due tomorrow still gets its day-of nudge.
 */
export async function scheduleVaccinationDue(
  pet: Pet,
  vaccination: Vaccination,
): Promise<ScheduleResult> {
  const due = toDate(vaccination.dueAt);
  if (!due) {
    await cancelForEntity('vaccination', vaccination.id);
    return SKIPPED('not-applicable');
  }

  const permission = await getPermission();
  if (!permission.granted) return SKIPPED('no-permission');

  const now = Date.now();
  const dayOf = applyTimeOfDay(due, VACCINATION_HOUR);
  const lead = dayOf ? new Date(dayOf.getTime() - VACCINATION_LEAD_DAYS * 86_400_000) : null;

  const payload = payloadFor('vaccination', pet, vaccination.id, 'reminders');
  const slots: { slot: string; at: Date }[] = [];
  if (lead && lead.getTime() > now) slots.push({ slot: 'lead', at: lead });
  if (dayOf && dayOf.getTime() > now) slots.push({ slot: 'due', at: dayOf });

  if (slots.length === 0) {
    await cancelForEntity('vaccination', vaccination.id);
    return SKIPPED('in-the-past');
  }

  // The lead reminder stops being schedulable a week before the day-of one
  // does, so its registry row has to be retired explicitly.
  await cancelStaleSlots('vaccination', vaccination.id, slots.map((s) => s.slot));

  const ids: string[] = [];
  for (const { slot, at } of slots) {
    const copy = pick(VACCINATION_VARIANTS, `${vaccination.id}:${slot}`, {
      name: pet.name,
      vaccine: vaccination.name,
      due: dueLabel(due, at),
    });
    const scheduled = await commit('vaccination', pet.id, vaccination.id, slot, [
      {
        content: contentFor(copy, payload, 'reminders', false),
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: at,
          channelId: CHANNEL.reminders,
        },
      },
    ]);
    ids.push(...scheduled);
  }

  return { scheduled: true, ids, nextAt: slots[0]?.at.toISOString() ?? null };
}

/* ---------------------------------------------------------- appointments */

/**
 * One reminder per entry in `reminderOffsets` — typically a day before and an
 * hour before. Offsets already in the past are skipped rather than fired
 * immediately, which is what a naive implementation does when you add an
 * appointment for this afternoon.
 */
export async function scheduleAppointmentReminders(
  pet: Pet,
  appointment: Appointment,
): Promise<ScheduleResult> {
  if (appointment.status === 'cancelled' || appointment.status === 'completed' || appointment.status === 'missed') {
    await cancelForEntity('appointment', appointment.id);
    return SKIPPED('not-applicable');
  }

  const at = toDate(appointment.at);
  if (!at) return SKIPPED('invalid-time');

  const permission = await getPermission();
  if (!permission.granted) return SKIPPED('no-permission');

  const now = Date.now();
  const payload = payloadFor('appointment', pet, appointment.id, 'reminders');

  // Longest lead first, and only offsets that haven't already elapsed — adding
  // an appointment for this afternoon must not fire yesterday's "day before".
  const live = [...new Set(appointment.reminderOffsets)]
    .sort((a, b) => b - a)
    .map((offset) => ({ offset, fireAt: new Date(at.getTime() - offset * 60_000) }))
    .filter(({ fireAt }) => fireAt.getTime() > now);

  await cancelStaleSlots('appointment', appointment.id, live.map(({ offset }) => String(offset)));

  const ids: string[] = [];
  let earliest: Date | null = null;

  for (const { offset, fireAt } of live) {
    const copy = pick(APPOINTMENT_VARIANTS, `${appointment.id}:${offset}`, {
      name: pet.name,
      reason: appointment.reason,
      clinic: appointment.clinic,
      when: whenPhrase(at, fireAt),
      lead: countdownLabel(offset),
    });

    const scheduled = await commit('appointment', pet.id, appointment.id, String(offset), [
      {
        content: contentFor(copy, payload, 'reminders', offset <= 120),
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: fireAt,
          channelId: CHANNEL.reminders,
        },
      },
    ]);
    ids.push(...scheduled);
    if (!earliest || fireAt.getTime() < earliest.getTime()) earliest = fireAt;
  }

  if (ids.length === 0) return SKIPPED('in-the-past');
  return { scheduled: true, ids, nextAt: earliest ? earliest.toISOString() : null };
}

/* --------------------------------------------------------------- refills */

/**
 * The quiet one. Fires on the `updates` channel — silent, low priority — because
 * "you have three doses left" is information, not an emergency, and a reminder
 * that vibrates for something you can't act on at 6am trains people to swipe
 * everything away.
 */
export async function scheduleRefillNudge(pet: Pet, medicine: Medicine): Promise<ScheduleResult> {
  if (!medicine.active || !medicine.remindersOn) {
    await cancelForEntity('refill', medicine.id);
    return SKIPPED('reminders-off');
  }

  const permission = await getPermission();
  if (!permission.granted) return SKIPPED('no-permission');

  const now = new Date();
  const explicit = toDate(medicine.refillAt);
  const perDay = DOSES_PER_DAY[medicine.frequency];
  const remaining = medicine.remainingDoses;

  let fireAt: Date | null = null;
  if (explicit) {
    fireAt = applyTimeOfDay(explicit, REFILL_HOUR);
  } else if (remaining !== null && perDay > 0) {
    const daysLeft = remaining / perDay;
    const target = new Date(now.getTime() + (daysLeft - REFILL_LEAD_DAYS) * 86_400_000);
    fireAt = applyTimeOfDay(target, REFILL_HOUR);
  }

  if (!fireAt) {
    await cancelForEntity('refill', medicine.id);
    return SKIPPED('not-applicable');
  }

  const requests: Notifications.NotificationRequestInput[] = [];
  const copy = pick(REFILL_VARIANTS, medicine.id, {
    name: pet.name,
    medicine: medicine.name,
    remaining: remaining === null ? 'not much' : spell(remaining, 'dose'),
  });
  const content = contentFor(copy, payloadFor('refill', pet, medicine.id, 'updates'), 'updates', false);

  if (fireAt.getTime() > now.getTime()) {
    requests.push({
      content,
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: fireAt,
        channelId: CHANNEL.updates,
      },
    });
  } else if (remaining !== null && perDay > 0 && remaining / perDay <= REFILL_LEAD_DAYS) {
    // Already inside the window — nudge in a couple of hours rather than never,
    // and rather than the instant it's noticed (which is usually mid-scroll).
    requests.push({
      content,
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: 2 * 60 * 60,
        repeats: false,
        channelId: CHANNEL.updates,
      },
    });
  }

  if (requests.length === 0) {
    await cancelForEntity('refill', medicine.id);
    return SKIPPED('in-the-past');
  }

  const ids = await commit('refill', pet.id, medicine.id, '', requests);
  return { scheduled: true, ids, nextAt: fireAt.getTime() > now.getTime() ? fireAt.toISOString() : null };
}

/* ------------------------------------------------------------ reschedule */

/**
 * Rebuild one pet's reminders from the current data.
 *
 * Called after any schedule edit and on app foreground, because two things
 * silently invalidate what's pending: rolling every-other-day batches run out,
 * and a device that crosses a timezone keeps firing on the old wall clock until
 * the repeating triggers are re-created.
 */
export async function rescheduleAllForPet(bundle: PetReminderBundle): Promise<RescheduleReport> {
  const { pet } = bundle;
  await cancelAllForPet(pet.id);

  const permission = await getPermission();
  if (!permission.granted) {
    return { petId: pet.id, scheduled: 0, skipped: 0, truncated: false };
  }

  let scheduled = 0;
  let skipped = 0;
  let truncated = false;

  const tally = (result: ScheduleResult): boolean => {
    if (result.scheduled) scheduled += result.ids.length;
    else skipped += 1;
    if (scheduled >= MAX_PER_PET) {
      truncated = true;
      return false;
    }
    return true;
  };

  // Order matters: the soonest and least skippable first, so if the cap bites
  // it takes the vaccination-in-eleven-months rather than tonight's dose.
  for (const medicine of bundle.medicines) {
    const results = await scheduleMedicineReminders(pet, medicine);
    if (!results.every(tally)) return { petId: pet.id, scheduled, skipped, truncated };
  }

  for (const schedule of bundle.feedingSchedules) {
    if (!tally(await scheduleFeedingReminder(pet, schedule))) break;
  }

  if (!truncated) {
    for (const appointment of bundle.appointments) {
      if (!tally(await scheduleAppointmentReminders(pet, appointment))) break;
    }
  }

  if (!truncated) {
    for (const medicine of bundle.medicines) {
      if (!tally(await scheduleRefillNudge(pet, medicine))) break;
    }
  }

  if (!truncated) {
    for (const vaccination of bundle.vaccinations) {
      if (!tally(await scheduleVaccinationDue(pet, vaccination))) break;
    }
  }

  return { petId: pet.id, scheduled, skipped, truncated };
}

/** Sequential on purpose — parallel scheduling races the registry write queue. */
export async function rescheduleAllForPets(bundles: readonly PetReminderBundle[]): Promise<RescheduleReport[]> {
  const reports: RescheduleReport[] = [];
  for (const bundle of bundles) reports.push(await rescheduleAllForPet(bundle));
  return reports;
}

/* --------------------------------------------------------------- routing */

/**
 * Send a notification tap to the thing that needs doing.
 *
 * `useLastNotificationResponse` covers both cases in one hook — a cold start
 * from a tap, and a tap while the app was already backgrounded — and it replays
 * the last response on mount, which is why taps are de-duped by identifier
 * rather than trusted to fire once.
 */
export function useNotificationRouting(): void {
  const response = Notifications.useLastNotificationResponse();
  const navigationState = useRootNavigationState();
  const handled = useRef<string | null>(null);

  const navigatorReady = Boolean(navigationState?.key);

  useEffect(() => {
    if (!response || !navigatorReady) return;
    // Ignore custom action buttons; only a tap on the notification body means
    // "take me there".
    if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;

    const identifier = response.notification.request.identifier;
    if (handled.current === identifier) return;

    const payload = parseNotificationPayload(response.notification.request.content.data);
    if (!payload) return;

    handled.current = identifier;
    router.push(toHref(payload.path));
  }, [response, navigatorReady]);
}

/** Fire a notification right now — used by the settings screen's "preview" row. */
export async function sendPreview(pet: Pet): Promise<void> {
  const permission = await getPermission();
  if (!permission.granted) return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: contentFor(
        {
          title: `This is how ${pet.name} will nudge you 🐾`,
          body: 'Meals, doses and vet visits will arrive looking just like this.',
        },
        payloadFor('feeding', pet, pet.id, 'reminders'),
        'reminders',
        false,
      ),
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: 2,
        repeats: false,
        channelId: CHANNEL.reminders,
      },
    });
  } catch (error) {
    logError('notifications.sendPreview', error);
  }
}

export const notifications = {
  CHANNEL,
  initNotifications,
  configureNotificationHandler,
  ensureAndroidChannels,
  getPermission,
  requestPermission,
  permissionCopy,
  scheduleFeedingReminder,
  scheduleMedicineReminder,
  scheduleMedicineReminders,
  scheduleVaccinationDue,
  scheduleAppointmentReminders,
  scheduleRefillNudge,
  cancelForEntity,
  cancelAllForPet,
  cancelEverything,
  rescheduleAllForPet,
  rescheduleAllForPets,
  syncRegistry,
  countScheduledForPet,
  parseNotificationPayload,
  sendPreview,
};

export default notifications;
