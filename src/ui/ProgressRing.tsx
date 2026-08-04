/**
 * Petal — ProgressRing.
 *
 * The circular readout behind "4 of 7 done today" and "92% adherence". Built
 * from `react-native-svg` + an animated `strokeDashoffset`, which is the only
 * way to get a genuinely smooth arc in Expo Go — a stack of rotated half-circle
 * views gives you a seam, and Skia isn't on the table.
 *
 *   · **The sweep is animated, not the value.** Setting `value` springs the arc
 *     from wherever it was, so ticking a task off *draws* the new progress.
 *   · **Gradient stroke is optional and brand-aware** — the default pair sweeps
 *     moss into blossom, which is what makes the day ring feel like a reward
 *     rather than a gauge.
 *   · **Indeterminate** is a rotating arc for the rare case where there's no
 *     denominator; under reduced motion it stops turning and breathes instead.
 *
 * The centre is a slot. Pass a number, a glyph, a pet's face — anything.
 */

import React, { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  ReduceMotion,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  withRepeat,
} from 'react-native-reanimated';
import { Circle, Defs, G, LinearGradient, Stop, Svg, type CircleProps } from 'react-native-svg';

import { useTheme, type Theme } from '@/theme';
import { Text } from './Text';

/* -------------------------------------------------------------------- types */

export type ProgressRingSize = 'sm' | 'md' | 'lg' | 'xl';
export type ProgressRingTone = 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export type ProgressRingProps = {
  /** 0–1. Clamped, so callers can hand over raw ratios without guarding. */
  value?: number;
  size?: ProgressRingSize | number;
  /** Stroke width. Defaults to a tenth of the diameter. */
  thickness?: number;
  tone?: ProgressRingTone;
  /** `true` uses the tone's brand pair; pass two colours for a bespoke sweep. */
  gradient?: boolean | readonly [string, string];
  color?: string;
  trackColor?: string;
  /** No denominator — rotates instead of filling. */
  indeterminate?: boolean;
  rounded?: boolean;
  /** Centre slot. Takes precedence over `showValue`. */
  children?: ReactNode;
  /** Renders the rounded percentage in the middle. */
  showValue?: boolean;
  /** Announced instead of the bare percentage — "Today's tasks, 4 of 7". */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/** Stroke as a fraction of the diameter — thin enough to read as a line. */
const THICKNESS_RATIO = 0.1;

/** Arc length of the indeterminate sweep. Long enough to read as motion. */
const INDETERMINATE_ARC = 0.28;

/** One full turn of the indeterminate ring. */
const SPIN_DIVISOR = 3;

/** SVG gradient ids can't come from React's `useId` — its colons break `url(#…)`. */
let ringSeq = 0;

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/* ------------------------------------------------------------------ helpers */

function diameterFor(t: Theme, size: ProgressRingSize | number): number {
  if (typeof size === 'number') return size;
  switch (size) {
    case 'sm':
      return t.minTarget;
    case 'lg':
      return t.spacing.colossal + t.spacing.base;
    case 'xl':
      return t.spacing.colossal + t.spacing.huge;
    case 'md':
    default:
      return t.spacing.giant;
  }
}

function toneColor(t: Theme, tone: ProgressRingTone): string {
  switch (tone) {
    case 'accent':
      return t.color.accent;
    case 'success':
      return t.color.success;
    case 'warning':
      return t.color.warning;
    case 'danger':
      return t.color.danger;
    case 'info':
      return t.color.info;
    case 'primary':
    default:
      return t.color.primary;
  }
}

/** The default sweep per tone. Primary runs moss → blossom: the brand gesture. */
function tonePair(t: Theme, tone: ProgressRingTone): readonly [string, string] {
  switch (tone) {
    case 'accent':
      return [t.color.accent, t.color.primary];
    case 'success':
      return [t.color.success, t.color.accent];
    case 'warning':
      return [t.color.warning, t.color.accent];
    case 'danger':
      return [t.color.danger, t.color.warning];
    case 'info':
      return [t.color.info, t.color.primary];
    case 'primary':
    default:
      return [t.color.primary, t.color.accent];
  }
}

/* ---------------------------------------------------------------- component */

export function ProgressRing({
  value = 0,
  size = 'md',
  thickness,
  tone = 'primary',
  gradient = false,
  color,
  trackColor,
  indeterminate = false,
  rounded = true,
  children,
  showValue = false,
  accessibilityLabel,
  style,
  testID,
}: ProgressRingProps) {
  const t = useTheme();
  const reduceMotion = t.reduceMotion;

  const diameter = diameterFor(t, size);
  const stroke = thickness ?? Math.max(t.borderWidth.focus, Math.round(diameter * THICKNESS_RATIO));
  const radius = (diameter - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const centre = diameter / 2;

  const clamped = Math.min(1, Math.max(0, value));
  const [gradientId] = useState(() => `petal-ring-${++ringSeq}`);
  const stops = gradient === true ? tonePair(t, tone) : gradient === false ? null : gradient;
  const line = color ?? toneColor(t, tone);

  const progress = useSharedValue(indeterminate ? INDETERMINATE_ARC : clamped);
  useEffect(() => {
    if (indeterminate) {
      progress.value = INDETERMINATE_ARC;
      return;
    }
    // Timing, not spring: the system drove this, not a finger. Reduced motion
    // is honoured by the preset, which lands the arc on its final value.
    progress.value = withTiming(clamped, t.motion.timing(t.motion.duration.slow, 'decelerate'));
  }, [clamped, indeterminate, progress, t.motion]);

  const spin = useSharedValue(0);
  useEffect(() => {
    if (!indeterminate) {
      cancelAnimation(spin);
      spin.value = 0;
      return;
    }
    spin.value = withRepeat(
      withTiming(1, {
        duration: t.motion.duration.ambient / SPIN_DIVISOR,
        easing: t.motion.easing.linear,
        // The loop is the affordance; the style below drops the rotation when
        // the user has asked for less motion.
        reduceMotion: ReduceMotion.Never,
      }),
      -1,
      false,
    );
    return () => cancelAnimation(spin);
  }, [indeterminate, spin, t.motion]);

  const spinStyle = useAnimatedStyle(() => {
    if (!indeterminate) return { opacity: 1, transform: [{ rotate: '0deg' }] };
    if (reduceMotion) {
      const wave = 0.5 + 0.5 * Math.cos(2 * Math.PI * spin.value);
      return { opacity: 0.45 + 0.55 * wave, transform: [{ rotate: '0deg' }] };
    }
    return { opacity: 1, transform: [{ rotate: `${spin.value * 360}deg` }] };
  }, [indeterminate, reduceMotion]);

  const arcProps = useAnimatedProps<CircleProps>(() => ({
    strokeDashoffset: circumference * (1 - progress.value),
  }));

  const percent = Math.round(clamped * 100);
  const centreSlot = children ?? (showValue ? <Percent value={percent} diameter={diameter} /> : null);

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={
        indeterminate ? undefined : { min: 0, max: 100, now: percent, text: `${percent}%` }
      }
      testID={testID}
      style={[{ width: diameter, height: diameter }, style]}
    >
      <Animated.View style={spinStyle}>
        <Svg width={diameter} height={diameter}>
          {stops ? (
            <Defs>
              <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
                <Stop offset="0" stopColor={stops[0]} />
                <Stop offset="1" stopColor={stops[1]} />
              </LinearGradient>
            </Defs>
          ) : null}

          {/* Twelve o'clock is where progress starts; SVG starts at three. */}
          <G rotation={-90} origin={`${centre}, ${centre}`}>
            <Circle
              cx={centre}
              cy={centre}
              r={radius}
              stroke={trackColor ?? t.color.surfaceAlt}
              strokeWidth={stroke}
              fill="none"
            />
            <AnimatedCircle
              cx={centre}
              cy={centre}
              r={radius}
              stroke={stops ? `url(#${gradientId})` : line}
              strokeWidth={stroke}
              strokeDasharray={circumference}
              strokeLinecap={rounded ? 'round' : 'butt'}
              fill="none"
              animatedProps={arcProps}
            />
          </G>
        </Svg>
      </Animated.View>

      {centreSlot ? (
        <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="box-none">
          {centreSlot}
        </View>
      ) : null}
    </View>
  );
}

/** Tabular so the digits don't dance as the ring fills. */
function Percent({ value, diameter }: { value: number; diameter: number }) {
  const t = useTheme();
  const big = diameter >= t.spacing.colossal;
  return (
    <Text variant={big ? 'metricSmall' : 'captionStrong'} tabular>
      {value}
      <Text variant={big ? 'subheadStrong' : 'caption'} color="textTertiary">
        %
      </Text>
    </Text>
  );
}

/* ----------------------------------------------------------------- styles */

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
});

export default ProgressRing;
