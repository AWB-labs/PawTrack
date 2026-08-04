/**
 * Petal — ProgressBar.
 *
 * The linear counterpart to `ProgressRing`. Two shapes in one component:
 *
 *   · **Continuous** — one track, one fill. Refill levels, upload progress,
 *     "3.2 of 4 kg to target".
 *   · **Segmented** — one cell per unit, each filling independently. This is
 *     the sitting-window bar (a cell per day, today's cell part-filled) and the
 *     week strip on the medicine screen. Segments beat a continuous bar
 *     wherever the denominator is small and countable: five cells say "five
 *     days" at a glance, where 60% says nothing.
 *
 * The fill animates from its measured track width rather than scaling, so the
 * rounded caps stay round instead of squashing as the bar grows.
 */

import React, { useCallback, useEffect } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { useTheme, type Theme } from '@/theme';
import { Row } from './Stack';
import { Text } from './Text';

/* -------------------------------------------------------------------- types */

export type ProgressBarTone = 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'info';
export type ProgressBarSize = 'sm' | 'md' | 'lg';

export type ProgressSegment = {
  /** 0–1 within this cell. Use `1` and `0` for a simple done/not-done strip. */
  value: number;
  color?: string;
  /** Announced as part of the whole — "Tuesday, complete". */
  label?: string;
};

export type ProgressBarProps = {
  /** 0–1. Ignored when `segments` is given. */
  value?: number;
  segments?: readonly ProgressSegment[];
  tone?: ProgressBarTone;
  size?: ProgressBarSize;
  /** `true` sweeps the tone's brand pair; pass two colours for a bespoke fill. */
  gradient?: boolean | readonly [string, string];
  color?: string;
  trackColor?: string;
  /** 0–1 — draws a "you are here" notch. Today's position in a sitting window. */
  marker?: number;
  markerLabel?: string;
  /** Caption above the bar, left and right. */
  label?: string;
  trailingLabel?: string;
  animated?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ------------------------------------------------------------------ helpers */

function heightFor(t: Theme, size: ProgressBarSize): number {
  switch (size) {
    case 'sm':
      return t.spacing.xxs;
    case 'lg':
      return t.spacing.md;
    case 'md':
    default:
      return t.spacing.sm;
  }
}

function toneColor(t: Theme, tone: ProgressBarTone): string {
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

function tonePair(t: Theme, tone: ProgressBarTone): readonly [string, string] {
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

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/* --------------------------------------------------------------------- bar */

type BarProps = {
  value: number;
  height: number;
  radius: number;
  trackColor: string;
  fill: string;
  gradient: readonly [string, string] | null;
  animated: boolean;
  duration: number;
  style?: StyleProp<ViewStyle>;
};

/** One track. Measured rather than scaled — see the file header. */
function Bar({ value, height, radius, trackColor, fill, gradient, animated, duration, style }: BarProps) {
  const t = useTheme();
  const width = useSharedValue(0);
  const progress = useSharedValue(animated ? 0 : value);

  useEffect(() => {
    // The system drove this, not a finger — timing, decelerating into place.
    progress.value = animated ? withTiming(value, t.motion.timing(duration, 'decelerate')) : value;
  }, [animated, duration, progress, t.motion, value]);

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      width.value = event.nativeEvent.layout.width;
    },
    [width],
  );

  const fillStyle = useAnimatedStyle(() => ({ width: width.value * progress.value }));

  return (
    <View
      onLayout={onLayout}
      style={[{ height, borderRadius: radius, backgroundColor: trackColor, overflow: 'hidden' }, style]}
    >
      <Animated.View style={[styles.fill, { borderRadius: radius }, fillStyle]}>
        {gradient ? (
          <LinearGradient
            colors={[gradient[0], gradient[1]]}
            start={GRADIENT_START}
            end={GRADIENT_END}
            style={StyleSheet.absoluteFill}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: fill }]} />
        )}
      </Animated.View>
    </View>
  );
}

/* ---------------------------------------------------------------- component */

export function ProgressBar({
  value = 0,
  segments,
  tone = 'primary',
  size = 'md',
  gradient = false,
  color,
  trackColor,
  marker,
  markerLabel,
  label,
  trailingLabel,
  animated = true,
  accessibilityLabel,
  style,
  testID,
}: ProgressBarProps) {
  const t = useTheme();

  const height = heightFor(t, size);
  const radius = t.radius.pill;
  const track = trackColor ?? t.color.surfaceAlt;
  const fill = color ?? toneColor(t, tone);
  const pair = gradient === true ? tonePair(t, tone) : gradient === false ? null : gradient;
  const move = animated && !t.reduceMotion;

  const total = segments
    ? segments.reduce((sum, segment) => sum + clamp01(segment.value), 0) / Math.max(1, segments.length)
    : clamp01(value);
  const percent = Math.round(total * 100);

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: percent, text: `${percent}%` }}
      testID={testID}
      style={[{ gap: t.spacing.xs }, style]}
    >
      {label || trailingLabel ? (
        <Row justify="between" align="baseline" gap="sm">
          {label ? (
            <Text variant="caption" color="textSecondary" numberOfLines={1} style={styles.grow}>
              {label}
            </Text>
          ) : null}
          {trailingLabel ? (
            <Text variant="captionStrong" color="textTertiary" tabular numberOfLines={1}>
              {trailingLabel}
            </Text>
          ) : null}
        </Row>
      ) : null}

      <View>
        {segments ? (
          <View style={[styles.row, { gap: t.spacing.hair }]}>
            {segments.map((segment, index) => (
              <Bar
                key={index}
                value={clamp01(segment.value)}
                height={height}
                radius={radius}
                trackColor={track}
                fill={segment.color ?? fill}
                gradient={segment.color ? null : pair}
                animated={move}
                duration={t.motion.duration.slow}
                style={styles.grow}
              />
            ))}
          </View>
        ) : (
          <Bar
            value={clamp01(value)}
            height={height}
            radius={radius}
            trackColor={track}
            fill={fill}
            gradient={pair}
            animated={move}
            duration={t.motion.duration.slow}
          />
        )}

        {marker === undefined ? null : (
          <View
            pointerEvents="none"
            accessibilityLabel={markerLabel}
            accessibilityRole={markerLabel ? 'image' : 'none'}
            style={{
              position: 'absolute',
              top: -t.spacing.xxs,
              bottom: -t.spacing.xxs,
              left: `${clamp01(marker) * 100}%`,
              width: t.borderWidth.thick,
              marginLeft: -t.borderWidth.thick / 2,
              borderRadius: t.radius.pill,
              backgroundColor: t.color.text,
            }}
          />
        )}
      </View>

      {markerLabel && marker !== undefined ? (
        <Text variant="caption" color="textTertiary" style={{ marginTop: -t.spacing.hair }}>
          {markerLabel}
        </Text>
      ) : null}
    </View>
  );
}

/* ----------------------------------------------------------------- statics */

const GRADIENT_START = { x: 0, y: 0 } as const;
const GRADIENT_END = { x: 1, y: 0 } as const;

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  grow: { flex: 1 },
  fill: { height: '100%', overflow: 'hidden' },
});

export default ProgressBar;
