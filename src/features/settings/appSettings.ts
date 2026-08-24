/**
 * Petal — the settings the device owns that `stores/preferences` doesn't.
 *
 * Phase 1's preference store covers the things the *first frame* depends on
 * (theme, haptics, units, the biometric switch). This module covers the rest of
 * the settings surface: which kinds of reminder the household wants, when it
 * wants to be left alone, and how quickly the lock re-arms.
 *
 * Two things are deliberate:
 *
 *  1. **The auto-lock ceiling is a minute, and that is not arbitrary.** The
 *     session store re-locks after a minute away whenever the lock is armed
 *     (`RELOCK_AFTER_MS`). A picker offering "after five minutes" would be
 *     writing a cheque the app can't cash, so the options stop where the
 *     guarantee stops. Anything *shorter* is honoured by the listener below,
 *     which is strictly stricter than the session store's own rule and
 *     therefore always fires first.
 *  2. **The listener is armed on import, not on mount.** A settings screen that
 *     owned it would only protect people who happened to be standing in
 *     settings. Every settings screen and the You tab import this module, so it
 *     arms as soon as anything that can *change* the setting is on screen.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { TimeOfDay } from '@/data/types';
import { formatTimeOfDay } from '@/lib/date';
import { getPreferences } from '@/stores/preferences';
import { useSession } from '@/stores/session';
// Type-only, so the icon set never reaches this module's runtime graph.
import type { IconName } from '@/ui/Icon';

/* -------------------------------------------------------------------- types */

export type ReminderCategory =
  | 'feeding'
  | 'medicine'
  | 'vaccinations'
  | 'appointments'
  | 'refills'
  | 'community';

export type QuietHours = {
  enabled: boolean;
  /** Wall clock, local — the same convention schedules use. */
  start: TimeOfDay;
  end: TimeOfDay;
};

export type AppSettingsState = {
  reminders: Record<ReminderCategory, boolean>;
  quietHours: QuietHours;
  /** Milliseconds away from Petal before the biometric lock re-arms. */
  autoLockAfterMs: number;

  setReminder: (category: ReminderCategory, enabled: boolean) => void;
  setAllReminders: (enabled: boolean) => void;
  setQuietHours: (patch: Partial<QuietHours>) => void;
  setAutoLockAfterMs: (ms: number) => void;
};

/* ---------------------------------------------------------------- constants */

/**
 * Categories in the order they matter to a household: the two that keep an
 * animal alive first, the paperwork after, the social layer last.
 */
export const REMINDER_CATEGORIES: readonly {
  id: ReminderCategory;
  label: string;
  description: string;
  icon: IconName;
}[] = [
  {
    id: 'feeding',
    label: 'Meals',
    description: 'A nudge at each feeding time on the schedule.',
    icon: 'restaurant-outline',
  },
  {
    id: 'medicine',
    label: 'Medicine',
    description: 'Every dose, at the time it’s due.',
    icon: 'medical-outline',
  },
  {
    id: 'vaccinations',
    label: 'Vaccinations',
    description: 'Five days before a booster is due, and again on the day.',
    icon: 'shield-checkmark-outline',
  },
  {
    id: 'appointments',
    label: 'Vet visits',
    description: 'The day before and an hour before, so you can leave in time.',
    icon: 'calendar-outline',
  },
  {
    id: 'refills',
    label: 'Refills',
    description: 'A quiet heads-up while there are still doses in the packet.',
    icon: 'bandage-outline',
  },
  {
    id: 'community',
    label: 'Community',
    description: 'Replies and likes on posts about your pets.',
    icon: 'chatbubbles-outline',
  },
];

export const AUTO_LOCK_OPTIONS: readonly { ms: number; label: string; hint: string }[] = [
  { ms: 0, label: 'Straight away', hint: 'Locks the moment Furry Tracker leaves the screen.' },
  { ms: 15_000, label: 'After 15 seconds', hint: 'Long enough to answer a text.' },
  { ms: 30_000, label: 'After 30 seconds', hint: 'A quick detour and back.' },
  { ms: 60_000, label: 'After a minute', hint: 'Furry Tracker’s usual.' },
];

/** The longest delay Petal can promise. See the note at the top of the file. */
export const MAX_AUTO_LOCK_MS = 60_000;

const ALL_ON: Record<ReminderCategory, boolean> = {
  feeding: true,
  medicine: true,
  vaccinations: true,
  appointments: true,
  refills: true,
  community: false,
};

const DEFAULT_QUIET_HOURS: QuietHours = { enabled: false, start: '22:00', end: '07:00' };

/* -------------------------------------------------------------------- store */

export const useAppSettings = create<AppSettingsState>()(
  persist(
    (set) => ({
      reminders: ALL_ON,
      quietHours: DEFAULT_QUIET_HOURS,
      autoLockAfterMs: MAX_AUTO_LOCK_MS,

      setReminder: (category, enabled) =>
        set((state) => ({ reminders: { ...state.reminders, [category]: enabled } })),

      setAllReminders: (enabled) =>
        set(() => ({
          reminders: {
            feeding: enabled,
            medicine: enabled,
            vaccinations: enabled,
            appointments: enabled,
            refills: enabled,
            community: enabled,
          },
        })),

      setQuietHours: (patch) => set((state) => ({ quietHours: { ...state.quietHours, ...patch } })),

      setAutoLockAfterMs: (ms) =>
        set({ autoLockAfterMs: Math.max(0, Math.min(MAX_AUTO_LOCK_MS, Math.round(ms))) }),
    }),
    {
      name: 'petal.appSettings.v1',
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
    },
  ),
);

export const getAppSettings = (): AppSettingsState => useAppSettings.getState();

/* ---------------------------------------------------------------- selectors */

/** "All on" · "4 of 6 on" · "Off" — the value a settings row shows at a glance. */
export function describeReminders(reminders: Record<ReminderCategory, boolean>): string {
  const total = REMINDER_CATEGORIES.length;
  const on = REMINDER_CATEGORIES.filter((category) => reminders[category.id]).length;
  if (on === 0) return 'Off';
  if (on === total) return 'All on';
  return `${on} of ${total} on`;
}

export function countActiveReminders(reminders: Record<ReminderCategory, boolean>): number {
  return REMINDER_CATEGORIES.filter((category) => reminders[category.id]).length;
}

/** "10pm – 7am", or "Off". */
export function describeQuietHours(quietHours: QuietHours): string {
  if (!quietHours.enabled) return 'Off';
  return `${formatTimeOfDay(quietHours.start)} – ${formatTimeOfDay(quietHours.end)}`;
}

export function describeAutoLock(ms: number): string {
  return AUTO_LOCK_OPTIONS.find((option) => option.ms === ms)?.label ?? 'After a minute';
}

/* ------------------------------------------------------------ auto-lock */

let lockSubscription: NativeEventSubscription | null = null;
let leftAt: number | null = null;

/**
 * Re-lock enforcement for delays shorter than the session store's own minute.
 * Idempotent: importing this module from six screens still arms one listener.
 */
export function armAutoLock(): void {
  if (lockSubscription) return;

  lockSubscription = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'background') {
      leftAt = Date.now();
      return;
    }
    if (state !== 'active') return;

    const away = leftAt === null ? 0 : Date.now() - leftAt;
    leftAt = null;

    const session = useSession.getState();
    if (session.status !== 'authenticated') return;
    if (!getPreferences().biometricLock) return;
    if (away < getAppSettings().autoLockAfterMs) return;

    session.lock();
  });
}

armAutoLock();

export default useAppSettings;
