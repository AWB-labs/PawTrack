/**
 * Petal — illustration foundations.
 *
 * Every scene in this folder is hand-authored SVG on one 160×128 grid, drawn in
 * a single flat/rounded style: soft neutral masses, one or two brand-coloured
 * accents, generous corner radii, and a soft ground ellipse so nothing floats.
 *
 * The rule that makes them survive dark mode is that **no illustration names a
 * colour**. They all read the palette below, which is built from semantic tokens
 * and therefore re-tints itself. The neutral masses walk *away* from the page
 * ground in both schemes (`shape` → `shapeMid` → `shapeStrong` gets darker in
 * light and lighter in dark), so the depth ordering never inverts.
 *
 * `size` sets the width; height follows the grid's 5:4 ratio. Scenes are drawn
 * with `width="100%"` inside a fixed box, so they scale crisply to any size
 * without per-scene maths.
 */

import React, { type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Ellipse, Path } from 'react-native-svg';

import { useTheme } from '@/theme';

/* -------------------------------------------------------------------- types */

export type IllustrationProps = {
  /** Width in points. Height follows the 5:4 grid. */
  size?: number;
  /**
   * Illustrations are decorative — the headline beside them carries the
   * meaning. Set this only when the scene stands alone.
   */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export type IllustrationPalette = {
  /** Softest neutral mass — the bulk of most scenes. */
  shape: string;
  /** One step further from the page ground. */
  shapeMid: string;
  /** Furthest from the ground — silhouettes, caps, hardware. */
  shapeStrong: string;
  /** Card / label / "paper" areas that must read as lit. */
  paper: string;
  /** Outline strokes. */
  line: string;
  /** Detail marks — eyes, noses, text lines. */
  ink: string;

  brand: string;
  brandSoft: string;
  /** Ink that is legible *on* `brand`. */
  onBrand: string;
  accent: string;
  accentSoft: string;
  onAccent: string;
  success: string;
  successSoft: string;
  onSuccess: string;
  warning: string;
  warningSoft: string;
  danger: string;
  dangerSoft: string;
  info: string;
  infoSoft: string;

  /** The contact shadow under an object. */
  shadow: string;
};

/* ---------------------------------------------------------------- constants */

export const ILLUSTRATION_WIDTH = 160;
export const ILLUSTRATION_HEIGHT = 128;
/** Comfortable size inside an empty state on a phone. */
export const DEFAULT_ILLUSTRATION_SIZE = 184;

/** Where every scene's ground ellipse sits, so objects share one floor. */
export const GROUND_Y = 112;

/* ------------------------------------------------------------------ helpers */

export function useIllustrationPalette(): IllustrationPalette {
  const t = useTheme();
  return {
    shape: t.color.surfaceAlt,
    shapeMid: t.color.border,
    shapeStrong: t.color.borderStrong,
    paper: t.color.surface,
    line: t.color.textTertiary,
    ink: t.color.textSecondary,

    brand: t.color.primary,
    brandSoft: t.color.primarySoft,
    onBrand: t.color.onPrimary,
    accent: t.color.accent,
    accentSoft: t.color.accentSoft,
    onAccent: t.color.onAccent,
    success: t.color.success,
    successSoft: t.color.successSoft,
    onSuccess: t.color.onSuccess,
    warning: t.color.warning,
    warningSoft: t.color.warningSoft,
    danger: t.color.danger,
    dangerSoft: t.color.dangerSoft,
    info: t.color.info,
    infoSoft: t.color.infoSoft,

    shadow: t.color.divider,
  };
}

/* --------------------------------------------------------------- components */

export function IllustrationFrame({
  size = DEFAULT_ILLUSTRATION_SIZE,
  accessibilityLabel,
  style,
  testID,
  children,
}: IllustrationProps & { children: ReactNode }) {
  const height = (size * ILLUSTRATION_HEIGHT) / ILLUSTRATION_WIDTH;

  return (
    <View
      accessibilityRole={accessibilityLabel === undefined ? 'none' : 'image'}
      accessibilityLabel={accessibilityLabel}
      importantForAccessibility={accessibilityLabel === undefined ? 'no-hide-descendants' : 'yes'}
      style={[{ width: size, height }, style]}
      testID={testID}
    >
      <Svg width="100%" height="100%" viewBox={`0 0 ${ILLUSTRATION_WIDTH} ${ILLUSTRATION_HEIGHT}`}>
        {children}
      </Svg>
    </View>
  );
}

/** The soft contact shadow every object stands on. */
export function Ground({ p, cx = 80, rx = 52, ry = 7 }: { p: IllustrationPalette; cx?: number; rx?: number; ry?: number }) {
  return <Ellipse cx={cx} cy={GROUND_Y} rx={rx} ry={ry} fill={p.shadow} />;
}

/**
 * Four-point star. Used sparingly — one or two per scene, never a shower of
 * them, or the whole set starts to look like clip art.
 */
export function Sparkle({
  x,
  y,
  size = 10,
  color,
  opacity = 1,
}: {
  x: number;
  y: number;
  size?: number;
  color: string;
  opacity?: number;
}) {
  const r = size / 2;
  // Pulling the control points close to the centre is what makes the four
  // limbs concave — a star, rather than a diamond with soft corners.
  const k = r * 0.2;
  const d = [
    `M${x} ${y - r}`,
    `C${x} ${y - k} ${x + k} ${y} ${x + r} ${y}`,
    `C${x + k} ${y} ${x} ${y + k} ${x} ${y + r}`,
    `C${x} ${y + k} ${x - k} ${y} ${x - r} ${y}`,
    `C${x - k} ${y} ${x} ${y - k} ${x} ${y - r}`,
    'Z',
  ].join('');

  return <Path d={d} fill={color} opacity={opacity} />;
}
