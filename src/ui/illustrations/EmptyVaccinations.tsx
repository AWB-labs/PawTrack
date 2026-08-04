/**
 * Petal — EmptyVaccinations.
 *
 * A shield with blank record lines, and a syringe laid across it. The shield is
 * the point: vaccinations are protection, not paperwork, so the medical object
 * is the smaller of the two.
 */

import React from 'react';
import { Circle, Path, Rect, G } from 'react-native-svg';

import { Ground, IllustrationFrame, Sparkle, useIllustrationPalette, type IllustrationProps } from './base';

export function EmptyVaccinations(props: IllustrationProps) {
  const p = useIllustrationPalette();

  return (
    <IllustrationFrame {...props}>
      <Ground p={p} rx={44} />

      <Path
        d="M80 16l32 11v27c0 22-13 37-32 45-19-8-32-23-32-45V27z"
        fill={p.shape}
        stroke={p.line}
        strokeWidth={2.5}
        strokeLinejoin="round"
      />
      {/* Blank record lines — the gap the empty state is about. */}
      <Rect x={62} y={44} width={36} height={5} rx={2.5} fill={p.shapeStrong} />
      <Rect x={62} y={56} width={26} height={5} rx={2.5} fill={p.shapeMid} />
      <Rect x={62} y={68} width={32} height={5} rx={2.5} fill={p.shapeMid} opacity={0.6} />

      {/* Syringe, angled across the lower half. */}
      <G transform="rotate(-32, 96, 84)">
        <Path d="M60 84h-14" stroke={p.shapeStrong} strokeWidth={3.5} strokeLinecap="round" />
        <Rect x={60} y={76} width={46} height={16} rx={5} fill={p.paper} stroke={p.line} strokeWidth={2.5} />
        <Rect x={63} y={79.5} width={22} height={9} rx={4.5} fill={p.brand} opacity={0.85} />
        <Rect x={106} y={79} width={12} height={10} rx={3} fill={p.shapeStrong} />
        <Rect x={118} y={72} width={5} height={24} rx={2.5} fill={p.shapeStrong} />
      </G>

      {/* Two doses' worth of droplets, so the needle reads as full. */}
      <Circle cx={44} cy={70} r={4} fill={p.accent} opacity={0.8} />
      <Circle cx={36} cy={82} r={2.5} fill={p.accent} opacity={0.5} />

      <Sparkle x={124} y={30} size={10} color={p.brand} opacity={0.8} />
    </IllustrationFrame>
  );
}

export default EmptyVaccinations;
