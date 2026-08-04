/**
 * Petal — EmptyComments.
 *
 * One bubble that has been said, and one dashed bubble waiting to be. The tails
 * point at each other so the pair reads as a conversation with a turn missing,
 * which is exactly what "be the first to reply" means.
 */

import React from 'react';
import { Circle, Path } from 'react-native-svg';

import { Ground, IllustrationFrame, Sparkle, useIllustrationPalette, type IllustrationProps } from './base';

export function EmptyComments(props: IllustrationProps) {
  const p = useIllustrationPalette();

  return (
    <IllustrationFrame {...props}>
      <Ground p={p} rx={46} />

      {/* Said. */}
      <Path
        d="M32 16h68a16 16 0 0116 16v26a16 16 0 01-16 16H62l-18 15V74h-12A16 16 0 0116 58V32a16 16 0 0116-16z"
        fill={p.shape}
        stroke={p.line}
        strokeWidth={2.5}
        strokeLinejoin="round"
      />
      <Circle cx={44} cy={45} r={5} fill={p.shapeStrong} />
      <Circle cx={62} cy={45} r={5} fill={p.shapeStrong} />
      <Circle cx={80} cy={45} r={5} fill={p.shapeStrong} />

      {/* Unsaid. */}
      <Path
        d="M100 62h34a12 12 0 0112 12v20a12 12 0 01-12 12h-8l-13 11V106h-13a12 12 0 01-12-12V74a12 12 0 0112-12z"
        fill={p.brandSoft}
        stroke={p.brand}
        strokeWidth={2.5}
        strokeDasharray="5 6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path d="M117 74v20M107 84h20" stroke={p.brand} strokeWidth={3} strokeLinecap="round" />

      <Sparkle x={128} y={30} size={10} color={p.accent} opacity={0.75} />
      <Sparkle x={26} y={92} size={8} color={p.accent} opacity={0.5} />
    </IllustrationFrame>
  );
}

export default EmptyComments;
