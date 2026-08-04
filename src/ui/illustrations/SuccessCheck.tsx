/**
 * Petal — SuccessCheck.
 *
 * The reward mark. A solid disc, a confident tick, a ring of burst rays and a
 * little confetti — the one scene in the set allowed to be loud, because it is
 * only ever shown after the user has genuinely finished something.
 */

import React from 'react';
import { Circle, G, Path, Rect } from 'react-native-svg';

import { IllustrationFrame, Sparkle, useIllustrationPalette, type IllustrationProps } from './base';

/** Eight rays, alternating length so the burst has rhythm. */
const RAYS = [0, 45, 90, 135, 180, 225, 270, 315];

/** x, y, rotation, tone index — confetti reads as thrown, not placed. */
const CONFETTI: readonly [number, number, number, 0 | 1][] = [
  [20, 26, -24, 0],
  [138, 34, 18, 1],
  [30, 96, 34, 1],
  [132, 100, -12, 0],
];

export function SuccessCheck(props: IllustrationProps) {
  const p = useIllustrationPalette();
  const confettiFill = [p.accent, p.warning] as const;

  return (
    <IllustrationFrame {...props}>
      {RAYS.map((angle, index) => (
        <G key={angle} transform={`rotate(${angle}, 80, 64)`}>
          <Rect
            x={78.25}
            y={index % 2 === 0 ? 4 : 8}
            width={3.5}
            height={index % 2 === 0 ? 12 : 8}
            rx={1.75}
            fill={index % 2 === 0 ? p.success : p.accent}
            opacity={index % 2 === 0 ? 0.75 : 0.5}
          />
        </G>
      ))}

      <Circle cx={80} cy={64} r={44} fill={p.successSoft} />
      <Circle cx={80} cy={64} r={33} fill={p.success} />
      <Path
        d="M66 64.5l9.5 10L95 54"
        fill="none"
        stroke={p.onSuccess}
        strokeWidth={7}
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {CONFETTI.map(([x, y, rotation, tone]) => (
        <G key={`${x}-${y}`} transform={`rotate(${rotation}, ${x}, ${y})`}>
          <Rect x={x - 4} y={y - 7} width={8} height={14} rx={4} fill={confettiFill[tone]} opacity={0.85} />
        </G>
      ))}

      <Sparkle x={126} y={66} size={12} color={p.accent} opacity={0.8} />
      <Sparkle x={32} y={58} size={9} color={p.success} opacity={0.6} />
    </IllustrationFrame>
  );
}

export default SuccessCheck;
