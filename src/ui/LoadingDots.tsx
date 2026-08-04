/**
 * Petal — LoadingDots.
 *
 * Three breathing dots, for the places a skeleton can't go: inside a button,
 * beside a label, at the end of a list that's fetching its next page. Anywhere
 * with room for the *shape* of the content, use `Skeleton` instead — this is
 * the small-format fallback, not the default.
 *
 * A cosine wave gives a seamless loop with one shared value and no restart
 * flicker. Under reduced motion the scale is dropped and only the opacity
 * breathes: the indicator still says "working" without anything moving.
 *
 * (`Button` carries its own private `ActivityDots` so it never depends on this
 * file; this is the one to reach for everywhere else.)
 */

import React, { useEffect } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { useTheme, type Theme } from '@/theme';
import { resolveColor, type ColorProp } from './Text';

/* -------------------------------------------------------------------- types */

export type LoadingDotsSize = 'sm' | 'md' | 'lg';

export type LoadingDotsProps = {
  /** Named step, or an explicit dot diameter. */
  size?: LoadingDotsSize | number;
  color?: ColorProp;
  /** Stops the loop and rests the dots — for a button that finished. */
  active?: boolean;
  /**
   * Announced while loading. Omit inside a control that already reports
   * `accessibilityState.busy` — two announcements is one too many.
   */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/** Phase offset per dot — small enough to read as one wave, not three blinks. */
const DOT_OFFSET = 0.18;

/** Resting opacity at the trough. Never fully off; a dark gap reads as broken. */
const TROUGH = 0.28;

/* ------------------------------------------------------------------ helpers */

function diameterFor(t: Theme, size: LoadingDotsSize | number): number {
  if (typeof size === 'number') return size;
  switch (size) {
    case 'sm':
      return t.spacing.xxs;
    case 'lg':
      return t.spacing.sm;
    case 'md':
    default:
      return t.spacing.xs;
  }
}

/* ---------------------------------------------------------------- component */

export function LoadingDots({
  size = 'md',
  color = 'textSecondary',
  active = true,
  accessibilityLabel,
  style,
  testID,
}: LoadingDotsProps) {
  const t = useTheme();
  const phase = useSharedValue(0);
  const dot = diameterFor(t, size);
  const ink = resolveColor(t.color, color, t.color.textSecondary);

  useEffect(() => {
    if (!active) {
      cancelAnimation(phase);
      phase.value = 0;
      return;
    }
    phase.value = 0;
    phase.value = withRepeat(
      withTiming(1, {
        duration: t.motion.duration.shimmer,
        easing: t.motion.easing.linear,
        // The loop *is* the affordance. ReduceMotion.System would collapse the
        // duration to nothing and spin; the style below drops the movement.
        reduceMotion: ReduceMotion.Never,
      }),
      -1,
      false,
    );
    return () => cancelAnimation(phase);
  }, [active, phase, t.motion]);

  return (
    <View
      accessible={accessibilityLabel !== undefined}
      accessibilityRole={accessibilityLabel === undefined ? 'none' : 'progressbar'}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ busy: active }}
      importantForAccessibility={accessibilityLabel === undefined ? 'no-hide-descendants' : 'yes'}
      testID={testID}
      style={[styles.row, { gap: Math.max(t.spacing.hair, Math.round(dot * 0.6)) }, style]}
    >
      <Dot phase={phase} index={0} color={ink} size={dot} reduceMotion={t.reduceMotion} />
      <Dot phase={phase} index={1} color={ink} size={dot} reduceMotion={t.reduceMotion} />
      <Dot phase={phase} index={2} color={ink} size={dot} reduceMotion={t.reduceMotion} />
    </View>
  );
}

function Dot({
  phase,
  index,
  color,
  size,
  reduceMotion,
}: {
  phase: SharedValue<number>;
  index: number;
  color: string;
  size: number;
  reduceMotion: boolean;
}) {
  const style = useAnimatedStyle(() => {
    const p = (phase.value + index * DOT_OFFSET) % 1;
    // Cosine keeps the loop seamless — no visible restart at the wrap point.
    const wave = 0.5 + 0.5 * Math.cos(2 * Math.PI * p);
    return {
      opacity: TROUGH + (1 - TROUGH) * wave,
      transform: [{ scale: reduceMotion ? 1 : 0.68 + 0.32 * wave }],
    };
  }, [reduceMotion, index]);

  return (
    <Animated.View
      style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }, style]}
    />
  );
}

/* ----------------------------------------------------------------- styles */

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
});

export default LoadingDots;
