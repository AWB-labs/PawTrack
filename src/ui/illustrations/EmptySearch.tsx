/**
 * Petal — EmptySearch.
 *
 * A magnifier over a dashed ring with a faint paw inside it. The paw is the
 * subject that *wasn't* found, so the scene answers "nothing matched" rather
 * than the generic "search" iconography every app already has.
 */

import React from 'react';
import { Circle, Path } from 'react-native-svg';

import { PawGlyph } from '../PawPrint';
import { Ground, IllustrationFrame, Sparkle, useIllustrationPalette, type IllustrationProps } from './base';

export function EmptySearch(props: IllustrationProps) {
  const p = useIllustrationPalette();

  return (
    <IllustrationFrame {...props}>
      <Ground p={p} rx={44} />

      <Circle
        cx={70}
        cy={56}
        r={38}
        fill="none"
        stroke={p.shapeStrong}
        strokeWidth={2.5}
        strokeDasharray="6 8"
        strokeLinecap="round"
      />
      <PawGlyph x={54} y={40} size={32} color={p.shapeStrong} opacity={0.85} />

      {/* Lens over the subject — the glass tints what's underneath. */}
      <Circle cx={76} cy={62} r={30} fill={p.brandSoft} />
      <Circle cx={76} cy={62} r={30} fill="none" stroke={p.brand} strokeWidth={5} />
      <Path
        d="M60 52a20 20 0 016-8"
        stroke={p.paper}
        strokeWidth={4}
        strokeLinecap="round"
        fill="none"
        opacity={0.8}
      />
      <Path d="M98 84l18 18" stroke={p.brand} strokeWidth={8} strokeLinecap="round" />
      <Path d="M115 100l6 6" stroke={p.shapeStrong} strokeWidth={8} strokeLinecap="round" />

      <Sparkle x={124} y={34} size={11} color={p.accent} opacity={0.75} />
      <Sparkle x={30} y={98} size={8} color={p.accent} opacity={0.5} />
    </IllustrationFrame>
  );
}

export default EmptySearch;
