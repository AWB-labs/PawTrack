/**
 * Petal — EmptyMedicine.
 *
 * A pill bottle with a blank label and a capsule tumbling beside it. The label
 * carries the brand cross rather than lorem lines, so the scene says "nothing
 * prescribed yet" instead of "we couldn't load the label".
 */

import React from 'react';
import { G, Path, Rect } from 'react-native-svg';

import { Ground, IllustrationFrame, Sparkle, useIllustrationPalette, type IllustrationProps } from './base';

export function EmptyMedicine(props: IllustrationProps) {
  const p = useIllustrationPalette();

  return (
    <IllustrationFrame {...props}>
      <Ground p={p} rx={44} />

      {/* Bottle. */}
      <Rect x={52} y={44} width={48} height={64} rx={12} fill={p.shape} stroke={p.line} strokeWidth={2.5} />
      <Rect x={58} y={30} width={36} height={16} rx={6} fill={p.shapeStrong} />
      <Rect x={62} y={26} width={28} height={6} rx={3} fill={p.shapeMid} />

      <Rect x={60} y={60} width={32} height={34} rx={7} fill={p.paper} />
      <Path d="M76 68v18M67 77h18" stroke={p.brand} strokeWidth={4} strokeLinecap="round" />

      {/* Capsule, two-tone and tumbling. */}
      <G transform="rotate(-28, 124, 66)">
        <Rect x={108} y={58} width={32} height={16} rx={8} fill={p.accentSoft} stroke={p.accent} strokeWidth={2} />
        <Path d="M116 58h8v16h-8a8 8 0 010-16z" fill={p.accent} />
      </G>

      {/* A single loose tablet, scored down the middle. */}
      <G transform="rotate(14, 34, 96)">
        <Rect x={22} y={86} width={22} height={20} rx={10} fill={p.shapeStrong} />
        <Path d="M33 89v14" stroke={p.shape} strokeWidth={2.5} strokeLinecap="round" />
      </G>

      <Sparkle x={128} y={100} size={9} color={p.brand} opacity={0.7} />
      <Sparkle x={36} y={38} size={10} color={p.accent} opacity={0.6} />
    </IllustrationFrame>
  );
}

export default EmptyMedicine;
