/**
 * Petal — motion system.
 *
 * One vocabulary for the whole app so nothing animates "off-key". The rules:
 *
 *  1. **Nothing linear.** Physical objects accelerate and settle.
 *  2. **Enter slow, exit fast.** Arrivals get `base`/`slow` + decelerate;
 *     dismissals get `fast` + accelerate. Users wait for arrivals, not exits.
 *  3. **Springs for anything a finger touched**, timings for anything the system
 *     initiated. A press that eases feels dead; a toast that springs feels twitchy.
 *  4. **Reduced motion is a first-class branch**, not a disable switch: we swap
 *     translation/scale for opacity rather than removing feedback entirely.
 */

import { Easing, ReduceMotion, type WithSpringConfig, type WithTimingConfig } from 'react-native-reanimated';

/* --------------------------------------------------------------- durations */

export const duration = {
  /** State flips that must feel instantaneous (checkbox ink, ripple start). */
  instant: 90,
  /** Press feedback, hover, small colour changes. */
  fast: 150,
  /** The workhorse: card reveals, accordions, tab indicator. */
  base: 240,
  /** Sheets, larger reveals, list staggers. */
  slow: 340,
  /** Celebration beats, hero transitions, onboarding steps. */
  slower: 480,
  /** Full-screen route transitions. */
  page: 380,
  /** Skeleton shimmer sweep. */
  shimmer: 1250,
  /** Ambient loops (breathing paw, gradient drift). */
  ambient: 4200,
} as const;

/** Stagger step for list entrances. Kept small — 40ms×8 items ≈ 320ms total. */
export const stagger = { tight: 28, base: 40, loose: 60 } as const;

/* ----------------------------------------------------------------- easings */

export const easing = {
  /** Emphasised decelerate — the default for arrivals. */
  standard: Easing.bezier(0.2, 0, 0, 1),
  /** Softer settle for large surfaces. */
  decelerate: Easing.bezier(0.05, 0.7, 0.1, 1),
  /** Quick exits. */
  accelerate: Easing.bezier(0.3, 0, 0.8, 0.15),
  /** Symmetric — colour and opacity cross-fades. */
  smooth: Easing.bezier(0.4, 0, 0.2, 1),
  /** Slight overshoot for playful confirmations. */
  overshoot: Easing.bezier(0.34, 1.56, 0.64, 1),
  linear: Easing.linear,
} as const;

/* ----------------------------------------------------------------- springs */

/**
 * Named springs. `press` is critically damped (no wobble) because a button that
 * bounces under your thumb feels broken; `bouncy` is reserved for rewards.
 */
export const spring = {
  /** Thumb-down / thumb-up scale. Fast, zero overshoot. */
  press: { damping: 26, stiffness: 420, mass: 0.6 } satisfies WithSpringConfig,
  /** Default for gesture-driven movement — sheets, swipe rows, drags. */
  snappy: { damping: 20, stiffness: 300, mass: 0.85 } satisfies WithSpringConfig,
  /** Calm settle for layout shifts and reveals. */
  gentle: { damping: 18, stiffness: 140, mass: 1 } satisfies WithSpringConfig,
  /** Rewards only: task completed, streak hit, pet added. */
  bouncy: { damping: 11, stiffness: 220, mass: 0.9 } satisfies WithSpringConfig,
  /** Heavy, deliberate — full-screen sheets. */
  heavy: { damping: 24, stiffness: 180, mass: 1.4 } satisfies WithSpringConfig,
} as const;

export type SpringName = keyof typeof spring;

/* --------------------------------------------------------- reduced motion */

/**
 * Reanimated honours the OS "Reduce Motion" setting when a config carries
 * `reduceMotion: ReduceMotion.System`. We set it on every preset so the whole
 * app respects it without each call site remembering.
 *
 * `WithSpringConfig` is a union of a physics form (stiffness/damping/mass) and a
 * duration form (duration/dampingRatio); spreading `Partial<WithSpringConfig>`
 * would straddle both branches and stop being assignable to either. Petal's
 * springs are always physics-based, so we pin the shape here.
 */
export type PetalSpringConfig = {
  damping: number;
  stiffness: number;
  mass: number;
  reduceMotion: ReduceMotion;
  overshootClamping?: boolean;
  velocity?: number;
  energyThreshold?: number;
};

export const springWith = (
  name: SpringName,
  overrides?: Partial<PetalSpringConfig>,
): PetalSpringConfig => ({
  ...spring[name],
  reduceMotion: ReduceMotion.System,
  ...overrides,
});

export const timing = (
  ms: number = duration.base,
  ease: keyof typeof easing = 'standard',
  overrides?: Partial<WithTimingConfig>,
) =>
  ({
    duration: ms,
    easing: easing[ease],
    reduceMotion: ReduceMotion.System,
    ...overrides,
  }) satisfies WithTimingConfig;

/* --------------------------------------------------------- press feedback */

/**
 * Canonical press scales. Bigger surfaces move less — a full-width card
 * shrinking 4% looks broken, a 44pt icon button shrinking 4% feels right.
 */
export const pressScale = {
  /** Icon buttons, chips, small controls. */
  small: 0.92,
  /** Standard buttons. */
  medium: 0.96,
  /** Cards, list rows, tiles. */
  large: 0.98,
  /** Full-bleed hero surfaces. */
  subtle: 0.99,
} as const;

/* ------------------------------------------------------- route transitions */

/** Shared config for expo-router `Stack` screens so pushes feel consistent. */
export const routeTransition = {
  /** Standard push — iOS-style horizontal slide, tuned faster than default. */
  push: {
    animation: 'slide_from_right' as const,
    animationDuration: duration.page,
    gestureEnabled: true,
  },
  /** Modal / creation flows. */
  modal: {
    presentation: 'modal' as const,
    animation: 'slide_from_bottom' as const,
    animationDuration: duration.slow,
    gestureEnabled: true,
  },
  /** Form sheets that shouldn't cover the whole screen on iOS. */
  formSheet: {
    presentation: 'formSheet' as const,
    animation: 'slide_from_bottom' as const,
    animationDuration: duration.slow,
    gestureEnabled: true,
  },
  /** Auth ↔ app handoff. Cross-fade, never a slide — it isn't navigation. */
  fade: {
    animation: 'fade' as const,
    animationDuration: duration.slow,
    gestureEnabled: false,
  },
} as const;
