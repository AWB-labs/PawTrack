/**
 * Petal — WelcomePets.
 *
 * The hero of the set: a dog and a cat sitting together with a heart between
 * them. It is the only scene with faces, and that is deliberate — it appears
 * once, at onboarding, where the job is to make someone smile rather than to
 * explain a gap in their data.
 */

import React from 'react';
import { Circle, Ellipse, G, Path } from 'react-native-svg';

import { Ground, IllustrationFrame, Sparkle, useIllustrationPalette, type IllustrationProps } from './base';

export function WelcomePets(props: IllustrationProps) {
  const p = useIllustrationPalette();

  return (
    <IllustrationFrame {...props}>
      <Ground p={p} cx={80} rx={62} ry={8} />

      {/* ---- cat, behind and to the right ---------------------------------- */}
      <Path
        d="M130 96c11 1 14-11 8-16"
        fill="none"
        stroke={p.shape}
        strokeWidth={8}
        strokeLinecap="round"
      />
      <Path d="M99 66l3-17 13 10zM131 66l-3-17-13 10z" fill={p.shapeStrong} strokeLinejoin="round" />
      <Path d="M100 112c-6 0-10-12-10-24a25 22 0 0150 0c0 12-4 24-10 24z" fill={p.shape} />
      <Ellipse cx={115} cy={78} rx={22} ry={19} fill={p.shape} />
      <Ellipse cx={106} cy={76} rx={3} ry={4} fill={p.ink} />
      <Ellipse cx={124} cy={76} rx={3} ry={4} fill={p.ink} />
      <Path d="M112 84h6l-3 4z" fill={p.accent} />
      <Path
        d="M115 88q-4 4-8 1M115 88q4 4 8 1"
        fill="none"
        stroke={p.line}
        strokeWidth={2}
        strokeLinecap="round"
      />
      <Path
        d="M92 76l-10-3M92 82l-10 3M138 76l10-3M138 82l10 3"
        stroke={p.line}
        strokeWidth={1.8}
        strokeLinecap="round"
        opacity={0.6}
      />

      {/* ---- dog, in front and to the left --------------------------------- */}
      <Path d="M42 112c-8 0-13-13-13-26a27 24 0 0154 0c0 13-5 26-13 26z" fill={p.shapeMid} />
      <G transform="rotate(-8, 56, 70)">
        <Ellipse cx={30} cy={72} rx={9} ry={17} fill={p.shapeStrong} />
        <Ellipse cx={82} cy={72} rx={9} ry={17} fill={p.shapeStrong} />
        <Ellipse cx={56} cy={68} rx={26} ry={24} fill={p.shapeMid} />
        <Ellipse cx={56} cy={82} rx={15} ry={11} fill={p.paper} />
        <Ellipse cx={56} cy={78} rx={5.5} ry={4.2} fill={p.ink} />
        <Path
          d="M56 82v4M50 88q6 5 12 0"
          fill="none"
          stroke={p.ink}
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Circle cx={45} cy={63} r={3.6} fill={p.ink} />
        <Circle cx={67} cy={63} r={3.6} fill={p.ink} />
        <Circle cx={46.4} cy={61.6} r={1.2} fill={p.paper} />
        <Circle cx={68.4} cy={61.6} r={1.2} fill={p.paper} />
      </G>
      {/* Collar and tag — the detail that makes him someone's dog. */}
      <Path d="M36 96q20 11 40 0" fill="none" stroke={p.brand} strokeWidth={6} strokeLinecap="round" />
      <Circle cx={56} cy={104} r={6} fill={p.accent} />

      {/* ---- the point of the picture -------------------------------------- */}
      {/* Nestled into the gap between the two heads — floating above them it
          reads as a logo rather than as something they share. */}
      <G transform="translate(4, 12) scale(0.92) translate(7, 4)">
        <Path
          d="M86 44c-11-8-17-13-17-20a9 9 0 0117-5 9 9 0 0117 5c0 7-6 12-17 20z"
          fill={p.accent}
        />
      </G>

      <Sparkle x={26} y={30} size={12} color={p.brand} opacity={0.8} />
      <Sparkle x={142} y={40} size={10} color={p.accent} opacity={0.7} />
      <Sparkle x={112} y={16} size={7} color={p.brand} opacity={0.5} />
    </IllustrationFrame>
  );
}

export default WelcomePets;
