/**
 * Petal — EmptyPets.
 *
 * A made-up pet bed with nobody in it. The dashed halo above the cushion is the
 * space waiting to be filled — it reads as anticipation rather than absence,
 * which is the difference between "add a pet" and "you have no pets".
 */

import React from 'react';
import { Circle, Ellipse, Path } from 'react-native-svg';

import { PawGlyph } from '../PawPrint';
import { Ground, IllustrationFrame, Sparkle, useIllustrationPalette, type IllustrationProps } from './base';

export function EmptyPets(props: IllustrationProps) {
  const p = useIllustrationPalette();

  return (
    <IllustrationFrame {...props}>
      <Ground p={p} rx={50} />

      {/* The waiting space. */}
      <Circle
        cx={80}
        cy={38}
        r={23}
        fill="none"
        stroke={p.brand}
        strokeWidth={2}
        strokeDasharray="5 7"
        strokeLinecap="round"
        opacity={0.55}
      />
      <PawGlyph x={66} y={24} size={28} color={p.brand} />

      {/* Bed, seen from above and in front. The cushion sits high inside the
          rim so the near wall reads thick and the far wall thin — that
          perspective is the whole difference between a bed and a plate. */}
      <Path d="M26 78v11c0 14 24 25 54 25s54-11 54-25V78z" fill={p.shapeMid} />
      <Ellipse cx={80} cy={78} rx={54} ry={22} fill={p.shapeStrong} />
      <Ellipse cx={80} cy={74} rx={40} ry={14} fill={p.shapeMid} />
      <Ellipse cx={80} cy={77} rx={36} ry={11} fill={p.shape} />
      <Path
        d="M60 78q20 7 40 0"
        stroke={p.line}
        strokeWidth={2}
        strokeLinecap="round"
        fill="none"
        opacity={0.4}
      />

      <Sparkle x={38} y={26} size={11} color={p.accent} />
      <Sparkle x={126} y={42} size={8} color={p.accent} opacity={0.7} />
    </IllustrationFrame>
  );
}

export default EmptyPets;
