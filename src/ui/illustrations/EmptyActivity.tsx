/**
 * Petal — EmptyActivity.
 *
 * The activity rail itself, with the last stop still open. It mirrors the real
 * `<Timeline/>` on purpose: the empty state and the filled state are visibly the
 * same object, so the first logged event lands somewhere the eye already knows.
 */

import React from 'react';
import { Circle, Path, Rect } from 'react-native-svg';

import { Ground, IllustrationFrame, Sparkle, useIllustrationPalette, type IllustrationProps } from './base';

/** y position, bar width, opacity — oldest at the top, fading back in time. */
const STOPS: readonly [number, number, number][] = [
  [40, 62, 0.9],
  [66, 46, 0.65],
];

export function EmptyActivity(props: IllustrationProps) {
  const p = useIllustrationPalette();

  return (
    <IllustrationFrame {...props}>
      <Ground p={p} rx={48} ry={6} />

      <Path d="M44 32v66" stroke={p.shapeMid} strokeWidth={4} strokeLinecap="round" />

      {STOPS.map(([y, width, opacity]) => (
        <React.Fragment key={y}>
          <Circle cx={44} cy={y} r={8} fill={p.shapeStrong} opacity={opacity} />
          <Rect x={64} y={y - 8} width={width} height={7} rx={3.5} fill={p.shapeStrong} opacity={opacity} />
          <Rect x={64} y={y + 3} width={width * 0.6} height={6} rx={3} fill={p.shapeMid} opacity={opacity} />
        </React.Fragment>
      ))}

      {/* The open stop — where the next event will appear. */}
      <Circle cx={44} cy={94} r={9} fill="none" stroke={p.brand} strokeWidth={2.5} strokeDasharray="4 5" />
      <Rect x={64} y={86} width={52} height={7} rx={3.5} fill={p.brand} opacity={0.35} />
      <Rect x={64} y={97} width={30} height={6} rx={3} fill={p.brand} opacity={0.2} />

      <Circle cx={120} cy={38} r={17} fill={p.paper} stroke={p.line} strokeWidth={2.5} />
      <Path
        d="M120 28v10l7 4"
        stroke={p.accent}
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />

      <Sparkle x={140} y={72} size={9} color={p.brand} opacity={0.6} />
    </IllustrationFrame>
  );
}

export default EmptyActivity;
