/**
 * Petal — EmptyFeed.
 *
 * A short stack of post cards, the top one holding a paw where the photo would
 * be. The cards fan rather than align: a perfectly stacked deck reads as a
 * loading placeholder, a fanned one reads as a scrapbook waiting for a page.
 */

import React from 'react';
import { Circle, G, Path, Rect } from 'react-native-svg';

import { PawGlyph } from '../PawPrint';
import { Ground, IllustrationFrame, Sparkle, useIllustrationPalette, type IllustrationProps } from './base';

export function EmptyFeed(props: IllustrationProps) {
  const p = useIllustrationPalette();

  return (
    <IllustrationFrame {...props}>
      <Ground p={p} rx={48} />

      {/* Fanned, and the back cards are the larger ones — a deck of identical
          cards hides its own fan behind the top card. */}
      <G transform="rotate(-10, 80, 62)">
        <Rect x={38} y={24} width={84} height={78} rx={14} fill={p.shapeMid} />
      </G>
      <G transform="rotate(7, 80, 62)">
        <Rect x={40} y={23} width={84} height={78} rx={14} fill={p.shapeStrong} />
      </G>

      <Rect x={44} y={26} width={74} height={72} rx={13} fill={p.paper} stroke={p.line} strokeWidth={2.5} />
      <Rect x={51} y={33} width={60} height={36} rx={9} fill={p.brand} opacity={0.16} />
      <PawGlyph x={68} y={38} size={26} color={p.brand} opacity={0.75} />

      <Circle cx={59} cy={84} r={7} fill={p.accent} opacity={0.75} />
      <Rect x={71} y={78} width={38} height={6} rx={3} fill={p.shapeStrong} />
      <Rect x={71} y={88} width={24} height={5} rx={2.5} fill={p.shapeMid} />

      <Sparkle x={132} y={40} size={11} color={p.accent} opacity={0.75} />
      <Sparkle x={24} y={62} size={9} color={p.brand} opacity={0.55} />
      <Path d="M126 96h10M131 91v10" stroke={p.brand} strokeWidth={2.5} strokeLinecap="round" opacity={0.5} />
    </IllustrationFrame>
  );
}

export default EmptyFeed;
