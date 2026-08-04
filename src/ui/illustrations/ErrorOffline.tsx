/**
 * Petal — ErrorOffline.
 *
 * A cloud with the signal arcs cut. The slash is drawn twice — a soft wide halo
 * first, then the sharp cut over it — which is what makes it read as passing
 * *through* the cloud rather than lying across it. The halo uses `dangerSoft`
 * rather than the page colour so the scene survives being placed on a card.
 */

import React from 'react';
import { Circle, Path } from 'react-native-svg';

import { Ground, IllustrationFrame, useIllustrationPalette, type IllustrationProps } from './base';

/** Radius, opacity — the outermost arc is the one that's lost. */
const ARCS: readonly [number, number][] = [
  [14, 0.9],
  [26, 0.55],
];

export function ErrorOffline(props: IllustrationProps) {
  const p = useIllustrationPalette();

  return (
    <IllustrationFrame {...props}>
      <Ground p={p} rx={44} />

      <Path
        d="M54 86a21 21 0 01-1-42 27 27 0 0151-7 19 19 0 015 49z"
        fill={p.shape}
        stroke={p.line}
        strokeWidth={2.5}
        strokeLinejoin="round"
      />

      {ARCS.map(([r, opacity]) => (
        <Path
          key={r}
          d={`M${80 - r} ${104 - r * 0.42}a${r} ${r} 0 01${r * 2} 0`}
          fill="none"
          stroke={p.info}
          strokeWidth={4}
          strokeLinecap="round"
          opacity={opacity}
        />
      ))}
      <Circle cx={80} cy={106} r={4.5} fill={p.info} />

      {/* Halo, then cut. */}
      <Path d="M40 26l82 82" stroke={p.dangerSoft} strokeWidth={12} strokeLinecap="round" />
      <Path d="M40 26l82 82" stroke={p.danger} strokeWidth={5} strokeLinecap="round" />
    </IllustrationFrame>
  );
}

export default ErrorOffline;
