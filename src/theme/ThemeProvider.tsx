/**
 * Petal — theme runtime.
 *
 * Exposes one `useTheme()` hook carrying the resolved palette plus every scale,
 * so a screen imports exactly one thing to be on-system. Also the single place
 * that:
 *   - resolves `system | light | dark` against the OS scheme,
 *   - merges the OS "Reduce Motion" switch with our in-app override,
 *   - reports the OS font scale so components can relax fixed heights,
 *   - runs the contrast audit in development.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import { PixelRatio, useColorScheme, type ViewStyle } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { usePreferences } from '../stores/preferences';
import { auditPalettesOnce } from './contrast';
import { elevation as elevationFor, glow as glowFor, type ElevationLevel } from './elevation';
import { darkPalette, lightPalette, type ColorScheme, type Palette } from './palette';
import * as motion from './motion';
import { typeScale, type TypeVariant } from './typography';
import {
  MIN_TARGET,
  borderWidth,
  gutter,
  opacity,
  radius,
  spacing,
  zIndex,
  type SpeciesKey,
} from './tokens';

export type Theme = {
  scheme: ColorScheme;
  /** True when the user picked a scheme explicitly rather than following the OS. */
  isSchemeForced: boolean;
  color: Palette;
  spacing: typeof spacing;
  gutter: number;
  radius: typeof radius;
  borderWidth: typeof borderWidth;
  opacity: typeof opacity;
  zIndex: typeof zIndex;
  type: Record<TypeVariant, (typeof typeScale)[TypeVariant]>;
  motion: typeof motion;
  minTarget: number;

  /** OS text-scale factor (1 = default). Use to relax fixed heights. */
  fontScale: number;
  /** True when text is scaled up enough to need stacked instead of inline layout. */
  isLargeText: boolean;

  /** Combined OS + in-app motion reduction. Honour this for decorative motion. */
  reduceMotion: boolean;

  elevation: (level: ElevationLevel) => ViewStyle;
  glow: (color: string) => ViewStyle;
  /** Resolve a pet's identity colour for the current scheme. */
  speciesColor: (key: SpeciesKey) => { base: string; tint: string };
};

const ThemeContext = createContext<Theme | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const preference = usePreferences((s) => s.theme);
  const appReduceMotion = usePreferences((s) => s.reduceMotion);
  const osReduceMotion = useReducedMotion();

  const scheme: ColorScheme =
    preference === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : preference;

  const fontScale = PixelRatio.getFontScale();
  const reduceMotion = osReduceMotion || appReduceMotion;

  useEffect(() => {
    auditPalettesOnce([lightPalette, darkPalette]);
  }, []);

  const color = scheme === 'dark' ? darkPalette : lightPalette;

  const elevation = useCallback(
    (level: ElevationLevel) => elevationFor(level, scheme),
    [scheme],
  );
  const glow = useCallback((c: string) => glowFor(c, scheme), [scheme]);
  const speciesColor = useCallback((key: SpeciesKey) => color.species[key], [color]);

  const value = useMemo<Theme>(
    () => ({
      scheme,
      isSchemeForced: preference !== 'system',
      color,
      spacing,
      gutter,
      radius,
      borderWidth,
      opacity,
      zIndex,
      type: typeScale,
      motion,
      minTarget: MIN_TARGET,
      fontScale,
      isLargeText: fontScale >= 1.3,
      reduceMotion,
      elevation,
      glow,
      speciesColor,
    }),
    [scheme, preference, color, fontScale, reduceMotion, elevation, glow, speciesColor],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (!theme) {
    throw new Error('useTheme() must be used inside <ThemeProvider>.');
  }
  return theme;
}

/**
 * Style factory helper. Lets a component define styles once against the theme
 * and memoise per scheme, instead of rebuilding objects on every render:
 *
 *   const useStyles = makeStyles((t) => ({ card: { backgroundColor: t.color.surface } }));
 */
export function makeStyles<T extends Record<string, unknown>>(factory: (theme: Theme) => T) {
  return function useStyles(): T {
    const theme = useTheme();
    return useMemo(() => factory(theme), [theme]);
  };
}
