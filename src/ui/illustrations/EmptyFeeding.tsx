/**
 * Petal — EmptyFeeding.
 *
 * A clean, empty bowl with a couple of stray kibble pieces beside it. The stray
 * pieces matter: a perfectly empty bowl reads as "never used", a bowl with
 * crumbs beside it reads as "waiting for the next meal".
 */

import React from 'react';
import { Ellipse, Path, Rect } from 'react-native-svg';

import { Ground, IllustrationFrame, Sparkle, useIllustrationPalette, type IllustrationProps } from './base';

export function EmptyFeeding(props: IllustrationProps) {
  const p = useIllustrationPalette();

  return (
    <IllustrationFrame {...props}>
      <Ground p={p} rx={46} />

      {/* Bowl body: a truncated cone with a rolled foot. */}
      <Path d="M42 62h76l-9 34a12 12 0 01-11.6 9H62.6A12 12 0 0151 96z" fill={p.shapeMid} />
      <Path
        d="M46.5 78q33.5 9 67 0l-2.4 9q-31.1 8-62.2 0z"
        fill={p.brand}
        opacity={0.28}
      />
      <Ellipse cx={80} cy={62} rx={38} ry={10} fill={p.shapeStrong} />
      <Ellipse cx={80} cy={63} rx={30} ry={7} fill={p.shape} />
      <Rect x={62} y={104} width={36} height={5} rx={2.5} fill={p.shapeStrong} />

      {/* Kibble. Rounded quads, never circles — circles read as bubbles. */}
      <Path d="M128 96a6 6 0 016 5 6 6 0 01-6 6 6 6 0 01-6-6 6 6 0 016-5z" fill={p.accent} opacity={0.85} />
      <Path d="M116 104a4.5 4.5 0 014.5 4 4.5 4.5 0 01-4.5 4.5 4.5 4.5 0 01-4.5-4.5 4.5 4.5 0 014.5-4z" fill={p.accent} opacity={0.5} />
      <Path d="M28 100a5 5 0 015 4.5 5 5 0 01-5 5 5 5 0 01-5-5 5 5 0 015-4.5z" fill={p.shapeStrong} />

      <Sparkle x={40} y={40} size={11} color={p.brand} opacity={0.75} />
      <Sparkle x={124} y={34} size={8} color={p.accent} opacity={0.6} />
    </IllustrationFrame>
  );
}

export default EmptyFeeding;
