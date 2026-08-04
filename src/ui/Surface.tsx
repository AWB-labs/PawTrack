/**
 * Petal — Surface.
 *
 * A themed box. The interesting part is that depth means different things in
 * the two schemes, and this is where that difference is resolved:
 *
 *   · **Light** — depth is a warm shadow (`elevation.ts`) over a white card.
 *   · **Dark** — shadows are invisible on near-black, so depth is *surface
 *     lightness*. A level-2 surface is genuinely a lighter brown than a
 *     level-1 one, plus a hairline top highlight.
 *
 * Which is why `elevation` here changes the background colour in dark mode and
 * only the shadow in light. Screens set a level and stop thinking about it.
 *
 * `glass` is the one variant with real cost: `expo-blur` on top of the
 * `surfaceGlass` wash. Android is left on the non-blurring fallback on
 * purpose — the experimental blur there costs more frames than it earns, and
 * the translucent wash reads correctly on its own.
 */

import React, { type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { BlurView, type BlurTint } from 'expo-blur';

import { darkSurfaceFor, useTheme, type ElevationLevel, type Theme } from '@/theme';
import type { RadiusToken, SpacingToken } from './Stack';

/* -------------------------------------------------------------------- types */

export type SurfaceVariant = 'surface' | 'surfaceAlt' | 'sunken' | 'glass';

export type SurfaceProps = Omit<ViewProps, 'style'> & {
  children?: ReactNode;
  variant?: SurfaceVariant;
  /** 0–5. Drives shadow in light, surface lightness in dark. */
  elevation?: ElevationLevel;
  radius?: RadiusToken | number;
  padding?: SpacingToken | number;
  /** Overrides `padding` on one axis — handy for full-bleed media in a card. */
  paddingX?: SpacingToken | number;
  paddingY?: SpacingToken | number;
  border?: boolean;
  /** Blur strength for `glass`. */
  intensity?: number;
  /** Blur tint for `glass`. Defaults to the active scheme. */
  tint?: BlurTint;
  style?: StyleProp<ViewStyle>;
};

/* ------------------------------------------------------------------ helpers */

const px = (t: Theme, value: SpacingToken | number | undefined): number | undefined =>
  value === undefined ? undefined : typeof value === 'number' ? value : t.spacing[value];

const radiusPx = (t: Theme, value: RadiusToken | number | undefined): number | undefined =>
  value === undefined ? undefined : typeof value === 'number' ? value : t.radius[value];

/**
 * In dark mode a raised card must actually get lighter, so we walk the
 * `darkSurfaceFor` ladder instead of reusing one flat `surface` token.
 * `surfaceAlt` starts a rung higher so nesting still reads as nesting.
 */
function backgroundFor(t: Theme, variant: SurfaceVariant, level: ElevationLevel): string {
  if (variant === 'glass') return 'transparent';
  const base =
    variant === 'sunken' ? t.color.bgSunken : variant === 'surfaceAlt' ? t.color.surfaceAlt : t.color.surface;
  if (t.scheme !== 'dark' || level === 0) return base;
  const lift = variant === 'surfaceAlt' ? 1 : 0;
  return darkSurfaceFor[Math.min(5, level + lift) as ElevationLevel];
}

/* ---------------------------------------------------------------- component */

export function Surface({
  children,
  variant = 'surface',
  elevation = 0,
  radius = 'lg',
  padding,
  paddingX,
  paddingY,
  border = false,
  intensity = 24,
  tint,
  style,
  ...rest
}: SurfaceProps) {
  const t = useTheme();

  const br = radiusPx(t, radius);
  const pad = px(t, padding);
  const boxStyle: ViewStyle = {
    borderRadius: br,
    padding: pad,
    paddingHorizontal: px(t, paddingX),
    paddingVertical: px(t, paddingY),
  };
  const borderStyle: ViewStyle | null = border
    ? { borderWidth: t.borderWidth.hairline, borderColor: t.color.border }
    : null;

  if (variant === 'glass') {
    return (
      // Two layers: the outer one casts the shadow (a clipped view can't), the
      // inner one clips the blur to the corner radius.
      <View style={[t.elevation(elevation), { borderRadius: br }, style]} {...rest}>
        <View style={[styles.clip, { borderRadius: br }, borderStyle, boxStyle]}>
          <BlurView
            intensity={intensity}
            tint={tint ?? (t.scheme === 'dark' ? 'dark' : 'light')}
            style={StyleSheet.absoluteFill}
          />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: t.color.surfaceGlass }]} />
          {children}
        </View>
      </View>
    );
  }

  return (
    // Elevation first: in dark mode it carries `backgroundColor: undefined`,
    // which would wipe our fill if it came last in the cascade.
    <View
      style={[
        t.elevation(elevation),
        { backgroundColor: backgroundFor(t, variant, elevation) },
        boxStyle,
        borderStyle,
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  // `basis: auto` lets the clip size to its content normally, while `grow`
  // makes it fill a Surface that was given an explicit width/height.
  clip: { overflow: 'hidden', flexGrow: 1, flexShrink: 1, flexBasis: 'auto' },
});

export default Surface;
