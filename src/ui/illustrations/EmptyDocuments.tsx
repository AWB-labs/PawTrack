/**
 * Petal — EmptyDocuments.
 *
 * An open folder with one sheet standing up inside it. The sheet's folded
 * corner and ruled lines make it read as a record rather than a blank card, and
 * the folder's front panel sits *over* it so the object has real depth.
 */

import React from 'react';
import { G, Path, Rect } from 'react-native-svg';

import { Ground, IllustrationFrame, Sparkle, useIllustrationPalette, type IllustrationProps } from './base';

export function EmptyDocuments(props: IllustrationProps) {
  const p = useIllustrationPalette();

  return (
    <IllustrationFrame {...props}>
      <Ground p={p} rx={50} />

      {/* Sheet, tipped so it looks placed rather than pasted. */}
      <G transform="rotate(-7, 84, 54)">
        <Path
          d="M62 18h30l16 16v42a8 8 0 01-8 8H62a8 8 0 01-8-8V26a8 8 0 018-8z"
          fill={p.paper}
          stroke={p.line}
          strokeWidth={2.5}
          strokeLinejoin="round"
        />
        <Path d="M92 18l16 16H96a4 4 0 01-4-4z" fill={p.shapeMid} />
        <Rect x={64} y={44} width={34} height={4.5} rx={2.25} fill={p.brand} opacity={0.5} />
        <Rect x={64} y={54} width={28} height={4.5} rx={2.25} fill={p.shapeStrong} />
        <Rect x={64} y={64} width={32} height={4.5} rx={2.25} fill={p.shapeStrong} opacity={0.6} />
      </G>

      {/* Folder: tabbed back wall, then a flat front pocket over the sheet. A
          tapered front turns the whole thing into a laundry basket. */}
      <Path
        d="M26 52h32l9 10h48a10 10 0 0110 10v22H16V62a10 10 0 0110-10z"
        fill={p.shapeStrong}
      />
      <Rect x={16} y={74} width={128} height={40} rx={11} fill={p.shapeMid} />
      <Path d="M24 84h112" stroke={p.shape} strokeWidth={2.5} strokeLinecap="round" opacity={0.55} />

      <Sparkle x={128} y={34} size={11} color={p.accent} opacity={0.7} />
      <Sparkle x={30} y={30} size={8} color={p.brand} opacity={0.55} />
    </IllustrationFrame>
  );
}

export default EmptyDocuments;
