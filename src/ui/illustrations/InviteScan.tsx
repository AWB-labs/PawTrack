/**
 * Petal — InviteScan.
 *
 * A code card inside scanner brackets, with a scan line crossing it. The paw at
 * the centre of the code is the tell that this is a pet invite and not a
 * payment — it's the one place a QR illustration can carry personality.
 */

import React from 'react';
import { Path, Rect } from 'react-native-svg';

import { PawGlyph } from '../PawPrint';
import { Ground, IllustrationFrame, Sparkle, useIllustrationPalette, type IllustrationProps } from './base';

/** x, y of the three finder squares. */
const FINDERS: readonly [number, number][] = [
  [50, 40],
  [92, 40],
  [50, 82],
];

/** x, y, size of the scattered data cells. */
const CELLS: readonly [number, number, number][] = [
  [94, 84, 7],
  [104, 84, 6],
  [94, 95, 6],
  [106, 94, 8],
  [50, 72, 6],
  [60, 72, 5],
  [84, 50, 5],
  [84, 62, 6],
];

export function InviteScan(props: IllustrationProps) {
  const p = useIllustrationPalette();

  return (
    <IllustrationFrame {...props}>
      <Ground p={p} rx={46} />

      <Rect x={38} y={28} width={84} height={84} rx={16} fill={p.paper} stroke={p.line} strokeWidth={2.5} />

      {FINDERS.map(([x, y]) => (
        <React.Fragment key={`${x}-${y}`}>
          <Rect
            x={x}
            y={y}
            width={20}
            height={20}
            rx={6}
            fill="none"
            stroke={p.shapeStrong}
            strokeWidth={4}
          />
          <Rect x={x + 7} y={y + 7} width={6} height={6} rx={2} fill={p.shapeStrong} />
        </React.Fragment>
      ))}
      {CELLS.map(([x, y, size]) => (
        <Rect key={`${x}-${y}`} x={x} y={y} width={size} height={size} rx={2} fill={p.shapeStrong} opacity={0.75} />
      ))}

      <Rect x={68} y={62} width={24} height={24} rx={8} fill={p.paper} />
      <PawGlyph x={70} y={64} size={20} color={p.brand} />

      {/* Scanner brackets, sitting proud of the card. */}
      <Path
        d="M28 44V32a10 10 0 0110-10h12M132 44V32a10 10 0 00-10-10h-12M28 96v12a10 10 0 0010 10h12M132 96v12a10 10 0 01-10 10h-12"
        fill="none"
        stroke={p.brand}
        strokeWidth={4}
        strokeLinecap="round"
      />

      {/* The beam: a wide soft wash under a bright hairline. */}
      <Rect x={34} y={62} width={92} height={16} rx={8} fill={p.accent} opacity={0.16} />
      <Rect x={34} y={69} width={92} height={3} rx={1.5} fill={p.accent} />

      <Sparkle x={20} y={70} size={9} color={p.accent} opacity={0.6} />
      <Sparkle x={142} y={62} size={9} color={p.accent} opacity={0.6} />
    </IllustrationFrame>
  );
}

export default InviteScan;
