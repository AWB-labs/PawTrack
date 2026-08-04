/**
 * Petal — PermissionLocked.
 *
 * A padlock whose keyhole is a paw. Locked, but unmistakably *this* app's kind
 * of locked — a caregiver hitting a permission wall should feel redirected, not
 * accused, so the lock is soft-bodied and the key is drawn as a possibility
 * rather than something they've lost.
 */

import React from 'react';
import { Circle, Path, Rect } from 'react-native-svg';

import { PawGlyph } from '../PawPrint';
import { Ground, IllustrationFrame, Sparkle, useIllustrationPalette, type IllustrationProps } from './base';

export function PermissionLocked(props: IllustrationProps) {
  const p = useIllustrationPalette();

  return (
    <IllustrationFrame {...props}>
      <Ground p={p} rx={44} />

      <Path
        d="M60 60V44a20 20 0 0140 0v16"
        fill="none"
        stroke={p.shapeStrong}
        strokeWidth={9}
        strokeLinecap="round"
      />

      <Rect x={44} y={56} width={72} height={54} rx={16} fill={p.shape} stroke={p.line} strokeWidth={2.5} />
      <Rect x={52} y={64} width={56} height={38} rx={11} fill={p.brandSoft} />
      <PawGlyph x={66} y={68} size={28} color={p.brand} />

      {/* The key that would open it — dashed, because it's a request, not a loss. */}
      <Circle
        cx={130}
        cy={78}
        r={11}
        fill="none"
        stroke={p.accent}
        strokeWidth={2.5}
        strokeDasharray="4 5"
        strokeLinecap="round"
      />
      <Path
        d="M130 89v17M126 98h8M126 104h6"
        fill="none"
        stroke={p.accent}
        strokeWidth={2.5}
        strokeDasharray="4 5"
        strokeLinecap="round"
      />

      <Sparkle x={26} y={48} size={11} color={p.accent} opacity={0.65} />
      <Sparkle x={124} y={30} size={8} color={p.brand} opacity={0.55} />
    </IllustrationFrame>
  );
}

export default PermissionLocked;
