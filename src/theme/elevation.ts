/**
 * Petal — elevation.
 *
 * Two things most RN apps get wrong and we don't:
 *
 *  1. **Shadows are warm-tinted, never pure black.** A #000 shadow over a warm
 *     cream ground goes grey and muddy. Ours are cast in a deep brown so cards
 *     look like paper on a table rather than stickers on glass.
 *  2. **Dark mode doesn't use shadows at all.** A shadow on a near-black ground
 *     is invisible; depth there comes from surface *lightness* plus a 1px
 *     top highlight. So `elevation(n)` returns different *kinds* of style per
 *     scheme, not the same style with different numbers.
 */

import { Platform, type ViewStyle } from 'react-native';
import type { ColorScheme } from './palette';

export type ElevationLevel = 0 | 1 | 2 | 3 | 4 | 5;

/** Warm brown shadow cast — hue-matched to the neutral ramp. */
const SHADOW_COLOR = '#3A2E1F';

const LIGHT: Record<ElevationLevel, ViewStyle> = {
  0: {},
  1: {
    shadowColor: SHADOW_COLOR,
    shadowOpacity: 0.05,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  2: {
    shadowColor: SHADOW_COLOR,
    shadowOpacity: 0.07,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  3: {
    shadowColor: SHADOW_COLOR,
    shadowOpacity: 0.09,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  4: {
    shadowColor: SHADOW_COLOR,
    shadowOpacity: 0.12,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 10 },
    elevation: 10,
  },
  5: {
    shadowColor: SHADOW_COLOR,
    shadowOpacity: 0.16,
    shadowRadius: 40,
    shadowOffset: { width: 0, height: 18 },
    elevation: 18,
  },
};

/**
 * Dark mode: depth via surface tint + hairline top highlight. Android still
 * gets a small `elevation` so the native ripple/z-ordering behaves, but no
 * visible shadow colour.
 */
const DARK: Record<ElevationLevel, ViewStyle> = {
  0: {},
  1: { backgroundColor: undefined, elevation: 1 },
  2: { elevation: 2 },
  3: { elevation: 4 },
  4: { elevation: 8 },
  5: { elevation: 12 },
};

/** Surface lightness ladder for dark mode — the real depth cue. */
export const darkSurfaceFor: Record<ElevationLevel, string> = {
  0: '#14120F',
  1: '#1D1A16',
  2: '#262218',
  3: '#2A251D',
  4: '#332E26',
  5: '#3A342A',
};

/** Hairline highlight along the top edge of raised dark surfaces. */
export const darkTopHighlight: ViewStyle = {
  borderTopWidth: 1,
  borderTopColor: 'rgba(255,255,255,0.06)',
};

export function elevation(level: ElevationLevel, scheme: ColorScheme): ViewStyle {
  if (scheme === 'dark') {
    return level >= 3 ? { ...DARK[level], ...darkTopHighlight } : DARK[level];
  }
  // Android renders shadowRadius poorly; `elevation` alone is closer to spec.
  if (Platform.OS === 'android') {
    const { shadowColor, shadowOpacity, shadowRadius, shadowOffset, ...rest } = LIGHT[level];
    return rest;
  }
  return LIGHT[level];
}

/**
 * Coloured glow for the primary CTA. Used sparingly — the single most
 * important button on a screen, never on a list of buttons.
 */
export function glow(color: string, scheme: ColorScheme): ViewStyle {
  if (Platform.OS === 'android') return { elevation: 6 };
  return {
    shadowColor: color,
    shadowOpacity: scheme === 'dark' ? 0.34 : 0.3,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
  };
}
