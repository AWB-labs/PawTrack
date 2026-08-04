/**
 * Petal — ErrorGeneric.
 *
 * A knocked-over bowl with the kibble scattered. Deliberately domestic rather
 * than technical: a spilled bowl says "that went wrong, let's pick it up",
 * where a red triangle says "you broke something".
 */

import React from 'react';
import { Circle, G, Path } from 'react-native-svg';

import { Ground, IllustrationFrame, useIllustrationPalette, type IllustrationProps } from './base';

/** cx, cy, r, opacity — a spill reads as a spill only if it's uneven. */
const SPILL: readonly [number, number, number, number][] = [
  [104, 100, 6, 0.9],
  [118, 92, 4.5, 0.7],
  [124, 104, 5, 0.85],
  [138, 98, 3.5, 0.5],
  [110, 110, 3, 0.45],
];

export function ErrorGeneric(props: IllustrationProps) {
  const p = useIllustrationPalette();

  return (
    <IllustrationFrame {...props}>
      <Ground p={p} rx={54} />

      {/* Bowl, tipped onto its rim. */}
      <G transform="rotate(-58, 62, 76)">
        <Path d="M28 52h68l-8 30a11 11 0 01-10.6 8H46.6A11 11 0 0136 82z" fill={p.shapeMid} />
        <Path d="M32.2 66q29.8 8 59.6 0l-2.1 8q-27.7 7-55.4 0z" fill={p.danger} opacity={0.24} />
        <Path
          d="M62 42c18.8 0 34 4.5 34 10s-15.2 10-34 10-34-4.5-34-10 15.2-10 34-10z"
          fill={p.shapeStrong}
        />
        <Path d="M62 48c14.9 0 27 3.1 27 7s-12.1 7-27 7-27-3.1-27-7 12.1-7 27-7z" fill={p.shape} />
      </G>

      {SPILL.map(([cx, cy, r, opacity]) => (
        <Circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} fill={p.accent} opacity={opacity} />
      ))}

      {/* A small, calm alert. It is a badge, not a billboard. */}
      <Circle cx={112} cy={40} r={18} fill={p.dangerSoft} />
      <Path d="M112 30v13" stroke={p.danger} strokeWidth={4} strokeLinecap="round" />
      <Circle cx={112} cy={50} r={2.8} fill={p.danger} />
    </IllustrationFrame>
  );
}

export default ErrorGeneric;
