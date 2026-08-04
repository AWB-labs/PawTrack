/**
 * Petal — Sparkline.
 *
 * A trend in the space of a word. It appears inside `<StatTile/>`, on medicine
 * adherence rows and beside a pet's weight, so it has to work at 32pt tall with
 * no axes, no labels and no interaction.
 *
 * The draw-on is a stroke-dash trick: the path is dashed with its own length,
 * then the offset is tweened to zero, so the line appears to be drawn rather
 * than to fade in. It runs entirely on the UI thread via `useAnimatedProps`, so
 * a list of twenty sparklines still scrolls at 60.
 *
 * The curve is Catmull-Rom with its control points clamped to each segment's own
 * y-range: smooth through the points, but physically unable to overshoot into a
 * value the data never reached. A weight chart that dips below a number the pet
 * never weighed is a lie, however pretty.
 */

import React, { useEffect, useId, useMemo, useState } from 'react';
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedProps,
  useDerivedValue,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import Svg, {
  Circle,
  Defs,
  LinearGradient,
  Path,
  Stop,
  type CircleProps,
  type PathProps,
} from 'react-native-svg';

import { useTheme } from '@/theme';
import { resolveColor, type ColorProp } from './Text';

/* -------------------------------------------------------------------- types */

export type SparklinePoint = { x: number; y: number };

export type SparklineProps = {
  /** Oldest first. Fewer than two points renders the resting state. */
  data: number[];
  /** Omit to fill the available width. */
  width?: number;
  height?: number;
  color?: ColorProp;
  strokeWidth?: number;
  /** Gradient wash under the line. */
  fill?: boolean;
  /** Dot on the most recent point. */
  lastPoint?: boolean;
  /** Fixed domain, so several sparklines can share one scale. */
  min?: number;
  max?: number;
  curve?: 'linear' | 'smooth';
  animate?: boolean;
  /** Delay the draw-on — used to stagger a column of tiles. */
  delay?: number;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);
/** Catmull-Rom control arms are a sixth of the neighbouring span. */
const TENSION = 6;
/** Smooth paths are longer than their polyline; over-declaring the dash is safe. */
const CURVE_SLACK = 1.08;

/* ------------------------------------------------------------------ helpers */

/**
 * SVG gradient ids are document-global, so two mounted charts would fight over
 * one `url(#…)`. React's `useId` is unique per instance; the strip is because
 * React 19 wraps its ids in characters a URL fragment can't carry.
 */
export function useSvgId(prefix: string): string {
  return `${prefix}${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
}

export function sparklinePath(points: readonly SparklinePoint[], smooth: boolean): string {
  const first = points[0];
  if (!first) return '';
  if (points.length === 1) return `M${first.x} ${first.y}`;

  if (!smooth) {
    return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
  }

  let d = `M${first.x} ${first.y}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const prev = points[i - 1] ?? points[i]!;
    const a = points[i]!;
    const b = points[i + 1]!;
    const next = points[i + 2] ?? b;

    const lo = Math.min(a.y, b.y);
    const hi = Math.max(a.y, b.y);
    const c1y = Math.min(hi, Math.max(lo, a.y + (b.y - prev.y) / TENSION));
    const c2y = Math.min(hi, Math.max(lo, b.y - (next.y - a.y) / TENSION));

    d += `C${a.x + (b.x - prev.x) / TENSION} ${c1y} ${b.x - (next.x - a.x) / TENSION} ${c2y} ${b.x} ${b.y}`;
  }
  return d;
}

export function polylineLength(points: readonly SparklinePoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  return total;
}

/* ---------------------------------------------------------------- component */

export function Sparkline({
  data,
  width,
  height,
  color = 'primary',
  strokeWidth,
  fill = true,
  lastPoint = true,
  min,
  max,
  curve = 'smooth',
  animate = true,
  delay = 0,
  accessibilityLabel,
  style,
  testID,
}: SparklineProps) {
  const t = useTheme();
  const gradientId = useSvgId('spark');

  const h = height ?? t.spacing.xxxl;
  const stroke = strokeWidth ?? t.borderWidth.thick;
  const line = resolveColor(t.color, color, t.color.primary);

  const [measured, setMeasured] = useState(0);
  const w = width ?? measured;

  const geometry = useMemo(() => {
    if (w <= 0 || data.length === 0) return null;
    // Inset by half the stroke so the cap never clips against the viewBox.
    const pad = stroke / 2 + (lastPoint ? stroke : 0);
    const innerW = Math.max(1, w - pad * 2);
    const innerH = Math.max(1, h - pad * 2);

    const lo = min ?? Math.min(...data);
    const hi = max ?? Math.max(...data);
    const span = hi - lo;

    const points: SparklinePoint[] = data.map((value, i) => ({
      x: pad + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW),
      // A flat series sits on the centre line rather than collapsing to the top.
      y: pad + (span === 0 ? innerH / 2 : innerH - ((value - lo) / span) * innerH),
    }));

    const d = sparklinePath(points, curve === 'smooth');
    const area =
      points.length > 1 ? `${d} L${points[points.length - 1]!.x} ${h} L${points[0]!.x} ${h} Z` : '';

    return {
      d,
      area,
      points,
      last: points[points.length - 1]!,
      length: Math.max(1, polylineLength(points) * (curve === 'smooth' ? CURVE_SLACK : 1)),
    };
  }, [curve, data, h, lastPoint, max, min, stroke, w]);

  const progress = useSharedValue(animate && !t.reduceMotion ? 0 : 1);
  const drawn = geometry?.length ?? 1;

  // Keyed on the *shape* of the data rather than the geometry object: a parent
  // that rebuilds its `data` array every render must not restart the draw-on.
  useEffect(() => {
    if (w <= 0 || data.length === 0) return;
    if (!animate || t.reduceMotion) {
      progress.value = 1;
      return;
    }
    progress.value = 0;
    progress.value = withDelay(
      delay,
      withTiming(1, t.motion.timing(t.motion.duration.slower, 'decelerate')),
    );
  }, [animate, data.length, delay, progress, t.motion, t.reduceMotion, w]);

  const lineProps = useAnimatedProps<PathProps>(() => ({
    strokeDashoffset: drawn * (1 - progress.value),
  }));
  // The wash follows the line in rather than arriving with it — the line reads
  // as the subject, the fill as its shadow.
  const areaOpacity = useDerivedValue(() => Math.max(0, progress.value * 1.4 - 0.4));
  const areaProps = useAnimatedProps<PathProps>(() => ({ opacity: areaOpacity.value }));
  const dotProps = useAnimatedProps<CircleProps>(() => ({
    opacity: Math.max(0, progress.value * 4 - 3),
  }));

  const handleLayout = (event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    setMeasured((prev) => (Math.abs(prev - next) < 1 ? prev : next));
  };

  return (
    <View
      onLayout={width === undefined ? handleLayout : undefined}
      accessible={accessibilityLabel !== undefined}
      accessibilityRole={accessibilityLabel === undefined ? 'none' : 'image'}
      accessibilityLabel={accessibilityLabel}
      importantForAccessibility={accessibilityLabel === undefined ? 'no-hide-descendants' : 'yes'}
      style={[{ height: h, width: width ?? '100%' }, style]}
      testID={testID}
    >
      {geometry ? (
        <Svg width="100%" height="100%" viewBox={`0 0 ${w} ${h}`}>
          <Defs>
            <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={line} stopOpacity={0.28} />
              <Stop offset="1" stopColor={line} stopOpacity={0} />
            </LinearGradient>
          </Defs>

          {fill && geometry.area ? (
            <AnimatedPath d={geometry.area} fill={`url(#${gradientId})`} animatedProps={areaProps} />
          ) : null}

          {geometry.points.length > 1 ? (
            <AnimatedPath
              d={geometry.d}
              fill="none"
              stroke={line}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={drawn}
              animatedProps={lineProps}
            />
          ) : null}

          {lastPoint ? (
            <AnimatedCircle
              cx={geometry.last.x}
              cy={geometry.last.y}
              r={stroke * 1.6}
              fill={line}
              animatedProps={dotProps}
            />
          ) : null}
        </Svg>
      ) : null}
    </View>
  );
}

export default Sparkline;
