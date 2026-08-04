/**
 * Petal — PawPrint.
 *
 * One paw, authored once. It is the app's signature mark: it sits inside the
 * empty-state illustrations, it is the shape the refresh control breathes, and
 * it is what the celebration confetti throws.
 *
 * Two entry points on purpose:
 *
 *   · `<PawGlyph/>` renders *inside* an existing `<Svg>`. Illustrations and
 *     confetti need that — nesting a second `Svg` per paw would cost a native
 *     view each and break the parent's coordinate space.
 *   · `<PawPrint/>` is the standalone component with its own canvas.
 *
 * The geometry is drawn on a 24×24 grid: four tilted toe pods around a pad
 * whose underside is scalloped rather than round. That scallop is the whole
 * difference between "paw" and "flower".
 */

import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Ellipse, G, Path } from 'react-native-svg';

import { useTheme } from '@/theme';
import { resolveColor, type ColorProp } from './Text';

/* -------------------------------------------------------------------- types */

export type PawGlyphProps = {
  /** Top-left of the glyph box, in the parent SVG's user units. */
  x?: number;
  y?: number;
  /** Edge length of the glyph box, in the parent SVG's user units. */
  size?: number;
  /** A resolved colour — `PawGlyph` has no theme opinion of its own. */
  color: string;
  opacity?: number;
  /** Degrees clockwise, about the glyph's own centre. */
  rotation?: number;
};

export type PawPrintProps = {
  /** Edge length in points. */
  size?: number;
  color?: ColorProp;
  opacity?: number;
  rotation?: number;
  /** Only set when the paw is the sole carrier of meaning. */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/** The design grid every path below is authored against. */
export const PAW_VIEWBOX = 24;

/**
 * The pad. Two shallow scallops along the bottom edge read as the metacarpal
 * pad's lobes; a plain ellipse there makes the mark look like a hot-air balloon.
 */
export const PAW_PAD_PATH =
  'M12 10.4c4.1 0 7.4 2.9 7.4 6.3 0 2.6-2.1 4.5-4.4 4.5-1.1 0-1.9-.4-3-.4s-1.9.4-3 .4c-2.3 0-4.4-1.9-4.4-4.5 0-3.4 3.3-6.3 7.4-6.3z';

/** cx, cy, rx, ry, tilt — mirrored either side of the centre line. */
const TOES: readonly [number, number, number, number, number][] = [
  [4.9, 9.4, 2.5, 3.2, -26],
  [9.5, 5.5, 2.6, 3.5, -9],
  [14.5, 5.5, 2.6, 3.5, 9],
  [19.1, 9.4, 2.5, 3.2, 26],
];

/* --------------------------------------------------------------- components */

export function PawGlyph({ x = 0, y = 0, size = PAW_VIEWBOX, color, opacity = 1, rotation = 0 }: PawGlyphProps) {
  const scale = size / PAW_VIEWBOX;
  const mid = PAW_VIEWBOX / 2;

  return (
    <G
      opacity={opacity}
      transform={`translate(${x}, ${y}) scale(${scale}) rotate(${rotation}, ${mid}, ${mid})`}
    >
      <Path d={PAW_PAD_PATH} fill={color} />
      {TOES.map(([cx, cy, rx, ry, tilt]) => (
        <Ellipse
          key={`${cx}-${cy}`}
          cx={cx}
          cy={cy}
          rx={rx}
          ry={ry}
          fill={color}
          transform={`rotate(${tilt}, ${cx}, ${cy})`}
        />
      ))}
    </G>
  );
}

export function PawPrint({
  size,
  color = 'primary',
  opacity = 1,
  rotation = 0,
  accessibilityLabel,
  style,
  testID,
}: PawPrintProps) {
  const t = useTheme();
  // Defaults to the icon ramp's `lg` step so a paw drops in beside body text.
  const px = size ?? t.spacing.xl;

  return (
    <View
      accessibilityRole={accessibilityLabel === undefined ? 'none' : 'image'}
      accessibilityLabel={accessibilityLabel}
      importantForAccessibility={accessibilityLabel === undefined ? 'no-hide-descendants' : 'yes'}
      style={[{ width: px, height: px }, style]}
      testID={testID}
    >
      <Svg width="100%" height="100%" viewBox={`0 0 ${PAW_VIEWBOX} ${PAW_VIEWBOX}`}>
        <PawGlyph
          color={resolveColor(t.color, color, t.color.primary)}
          opacity={opacity}
          rotation={rotation}
        />
      </Svg>
    </View>
  );
}

export default PawPrint;
