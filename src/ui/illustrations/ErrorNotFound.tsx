/**
 * Petal — ErrorNotFound.
 *
 * A trail of paw prints that fades out before it reaches the pin. The trail is
 * the whole idea: something was here, the scent went cold. It gives a 404 a bit
 * of warmth without pretending nothing went wrong.
 */

import React from 'react';
import { Circle, Path } from 'react-native-svg';

import { PawGlyph } from '../PawPrint';
import { Ground, IllustrationFrame, Sparkle, useIllustrationPalette, type IllustrationProps } from './base';

/** x, y, rotation, opacity — the trail climbs to the right and thins out. */
const TRAIL: readonly [number, number, number, number][] = [
  [10, 96, 24, 0.9],
  [30, 88, 30, 0.6],
  [50, 82, 36, 0.34],
  [70, 78, 42, 0.14],
];

export function ErrorNotFound(props: IllustrationProps) {
  const p = useIllustrationPalette();

  return (
    <IllustrationFrame {...props}>
      <Ground p={p} cx={106} rx={34} />

      <Path
        d="M6 106c22-10 44-20 74-26"
        fill="none"
        stroke={p.shapeStrong}
        strokeWidth={2.5}
        strokeDasharray="3 8"
        strokeLinecap="round"
        opacity={0.7}
      />
      {TRAIL.map(([x, y, rotation, opacity]) => (
        <PawGlyph key={x} x={x} y={y} size={17} rotation={rotation} color={p.shapeStrong} opacity={opacity} />
      ))}

      {/* Where the trail was heading. */}
      <Path
        d="M106 14a26 26 0 00-26 26c0 19 26 46 26 46s26-27 26-46a26 26 0 00-26-26z"
        fill={p.accentSoft}
        stroke={p.accent}
        strokeWidth={2.5}
        strokeLinejoin="round"
      />
      <Circle cx={106} cy={40} r={10} fill={p.paper} />
      <Path
        d="M102.5 36.5a3.6 3.6 0 015.9 2.8c0 2.4-3 2.9-3 4.7"
        fill="none"
        stroke={p.accent}
        strokeWidth={2.4}
        strokeLinecap="round"
      />
      <Circle cx={105.4} cy={48} r={1.7} fill={p.accent} />

      <Sparkle x={140} y={62} size={10} color={p.brand} opacity={0.6} />
    </IllustrationFrame>
  );
}

export default ErrorNotFound;
