/**
 * Haptics, centralised.
 *
 * Two reasons this isn't just `expo-haptics` at call sites:
 *  1. Users can turn haptics off (some find them genuinely unpleasant, and they
 *     drain battery). One preference check, here, rather than 60 call sites.
 *  2. Semantic naming. `tap()` / `commit()` / `celebrate()` documents *intent*,
 *     so we can retune the physical mapping app-wide without hunting for
 *     `ImpactFeedbackStyle.Medium` everywhere.
 *
 * Every call is fire-and-forget and swallows errors — a device without a haptic
 * engine (most Android tablets, the simulator) must never break a flow.
 */

import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';
import { getPreferences } from '../stores/preferences';

const supported = Platform.OS === 'ios' || Platform.OS === 'android';

function enabled(): boolean {
  return supported && getPreferences().haptics;
}

function fire(run: () => Promise<void>): void {
  if (!enabled()) return;
  void run().catch(() => {
    /* no haptic engine — silently ignore */
  });
}

/** Light tick. Buttons, chips, tab switches — the most common feedback. */
export const tap = () => fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));

/** Selection change: segmented control, picker scroll, stepper. */
export const select = () => fire(() => Haptics.selectionAsync());

/** Medium thud for a real state change — toggle on, item added. */
export const commit = () => fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));

/** Heavy — destructive confirm, drag pickup. */
export const heavy = () => fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy));

/** Rigid tick — crossing a threshold mid-gesture (swipe action armed). */
export const threshold = () =>
  fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid));

/** Soft — subtle, for continuous or repeated events (scrubbing a chart). */
export const soft = () => fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft));

/** Task done: medicine given, meal logged. */
export const success = () =>
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));

/** Something needs attention but isn't an error — overdue, permission denied. */
export const warn = () =>
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));

/** Failure — save rejected, network error, invalid form. */
export const error = () =>
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));

/**
 * Celebration burst for real milestones (first pet added, week streak).
 * Deliberately rare — three pulses is a lot of vibration.
 */
export function celebrate(): void {
  if (!enabled()) return;
  void (async () => {
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await new Promise((r) => setTimeout(r, 70));
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await new Promise((r) => setTimeout(r, 60));
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      /* ignore */
    }
  })();
}

export const haptics = {
  tap,
  select,
  commit,
  heavy,
  threshold,
  soft,
  success,
  warn,
  error,
  celebrate,
};

export default haptics;
