/**
 * Petal — EmptyAppointments.
 *
 * A wall calendar with an unmarked month and a clock badge tucked into the
 * corner. One date dot carries the accent so the grid has somewhere for the eye
 * to land — an entirely uniform grid reads as a loading skeleton.
 */

import React from 'react';
import { Circle, Path, Rect } from 'react-native-svg';

import { Ground, IllustrationFrame, Sparkle, useIllustrationPalette, type IllustrationProps } from './base';

/** Grid origin and step for the date dots. */
const COLS = [0, 1, 2, 3];
const ROWS = [0, 1, 2];

export function EmptyAppointments(props: IllustrationProps) {
  const p = useIllustrationPalette();

  return (
    <IllustrationFrame {...props}>
      <Ground p={p} rx={46} />

      {/* Hanging rings, drawn behind the body so they tuck under the header. */}
      <Rect x={56} y={20} width={6} height={20} rx={3} fill={p.shapeStrong} />
      <Rect x={98} y={20} width={6} height={20} rx={3} fill={p.shapeStrong} />

      <Rect x={34} y={30} width={92} height={78} rx={14} fill={p.shape} stroke={p.line} strokeWidth={2.5} />
      <Path d="M34 50v-6a14 14 0 0114-14h64a14 14 0 0114 14v6z" fill={p.brand} opacity={0.22} />
      <Path d="M34 50h92" stroke={p.line} strokeWidth={2} opacity={0.5} />

      {ROWS.map((row) =>
        COLS.map((col) => {
          const cx = 50 + col * 20;
          const cy = 64 + row * 16;
          const marked = row === 1 && col === 2;
          return (
            <Circle
              key={`${row}-${col}`}
              cx={cx}
              cy={cy}
              r={marked ? 6 : 4}
              fill={marked ? p.accent : p.shapeStrong}
              opacity={marked ? 1 : 0.7 - row * 0.15}
            />
          );
        }),
      )}

      {/* Clock badge — it overlaps the calendar edge so the two objects read as
          one composition rather than two stickers. */}
      <Circle cx={116} cy={90} r={21} fill={p.paper} stroke={p.line} strokeWidth={2.5} />
      <Path
        d="M116 78v12l8 5"
        stroke={p.brand}
        strokeWidth={3.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />

      <Sparkle x={24} y={44} size={10} color={p.accent} opacity={0.7} />
    </IllustrationFrame>
  );
}

export default EmptyAppointments;
