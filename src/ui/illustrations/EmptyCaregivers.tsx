/**
 * Petal — EmptyCaregivers.
 *
 * One person present, one outlined in dashes with a plus badge. The dashed
 * figure is a *slot*, not a ghost — it tells the owner exactly what tapping the
 * button will produce, which is why it stands at the same scale as the solid
 * one instead of being a faded copy.
 */

import React from 'react';
import { Circle, Path } from 'react-native-svg';

import { Ground, IllustrationFrame, Sparkle, useIllustrationPalette, type IllustrationProps } from './base';

export function EmptyCaregivers(props: IllustrationProps) {
  const p = useIllustrationPalette();

  return (
    <IllustrationFrame {...props}>
      <Ground p={p} rx={52} />

      {/* Present caregiver. */}
      <Circle cx={58} cy={46} r={17} fill={p.shapeStrong} />
      <Path d="M30 106c0-16 12.5-29 28-29s28 13 28 29z" fill={p.shapeMid} />
      <Path d="M52 84h12" stroke={p.brand} strokeWidth={4} strokeLinecap="round" opacity={0.7} />

      {/* The open slot. */}
      <Circle
        cx={110}
        cy={52}
        r={15}
        fill="none"
        stroke={p.brand}
        strokeWidth={2.5}
        strokeDasharray="5 6"
        strokeLinecap="round"
      />
      <Path
        d="M85 106c0-14 11.2-26 25-26s25 12 25 26z"
        fill="none"
        stroke={p.brand}
        strokeWidth={2.5}
        strokeDasharray="5 6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      <Circle cx={132} cy={88} r={14} fill={p.brand} />
      <Path d="M132 81v14M125 88h14" stroke={p.onBrand} strokeWidth={3.5} strokeLinecap="round" />

      <Sparkle x={86} y={30} size={11} color={p.accent} opacity={0.8} />
      <Sparkle x={26} y={62} size={8} color={p.accent} opacity={0.5} />
    </IllustrationFrame>
  );
}

export default EmptyCaregivers;
