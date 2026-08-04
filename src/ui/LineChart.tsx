/**
 * Petal — LineChart.
 *
 * The weight-history chart, and the only genuinely interactive graphic in the
 * app. Design decisions worth knowing:
 *
 *   · **The target band is the hero, not the line.** A vet says "keep her
 *     between 4.2 and 4.8kg"; the chart's job is to answer "are we inside it?"
 *     at a glance, so the band is drawn as a filled region behind everything
 *     and the line's relationship to it is the whole story.
 *   · **Scrub, don't tooltip.** Drag across and a guide follows the nearest
 *     reading with a haptic tick each time it crosses one — the ticks are the
 *     feedback that makes a 100-point series feel like discrete entries rather
 *     than a smear. Vertical drags are handed straight back to the scroll view.
 *   · **Axis labels are real text, not SVG text.** They inherit the type ramp,
 *     dynamic type and colour tokens, and they render identically on both
 *     platforms — SVG text does none of those things reliably.
 *   · One, two or a hundred points all work: a single reading draws its own
 *     baseline, and dot markers switch off once they would collide.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { runOnJS } from 'react-native-worklets';
import Svg, {
  Circle,
  Defs,
  LinearGradient,
  Line,
  Path,
  Rect,
  Stop,
  type PathProps,
} from 'react-native-svg';

import haptics from '@/lib/haptics';
import { useTheme } from '@/theme';
import { polylineLength, sparklinePath, useSvgId, type SparklinePoint } from './Sparkline';
import { Surface } from './Surface';
import { resolveColor, Text, type ColorProp } from './Text';

/* -------------------------------------------------------------------- types */

export type LineChartPoint = {
  /** Any monotonic scalar — a timestamp in ms for a weight history. */
  x: number;
  y: number;
};

export type LineChartTarget = {
  min: number;
  max: number;
  /** Short caption pinned to the band, e.g. "Vet target". */
  label?: string;
};

export type LineChartProps = {
  /** Oldest first. */
  data: LineChartPoint[];
  height?: number;
  target?: LineChartTarget | null;
  color?: ColorProp;
  /** Y-axis ticks and the scrub bubble's headline. */
  formatValue?: (value: number) => string;
  /** X-axis ticks. */
  formatX?: (x: number) => string;
  /** Second line of the scrub bubble — usually the full date. */
  formatScrubMeta?: (point: LineChartPoint, index: number) => string;
  yTicks?: number;
  xTicks?: number;
  scrubbable?: boolean;
  onScrubChange?: (point: LineChartPoint | null, index: number) => void;
  animate?: boolean;
  /** Shown across the plot when `data` is empty. */
  emptyLabel?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

type Geometry = {
  points: SparklinePoint[];
  path: string;
  area: string;
  length: number;
  yTickValues: number[];
  yFor: (value: number) => number;
  xIndices: number[];
  plot: { left: number; right: number; top: number; bottom: number };
};

/* ---------------------------------------------------------------- constants */

const AnimatedPath = Animated.createAnimatedComponent(Path);

/** How long the guide lingers after the finger lifts, so a tap is readable. */
const LINGER_MS = 1100;
/** Above this many readings, per-point dots collide and become noise. */
const DOT_LIMIT = 24;
/** Padding above and below the data, as a fraction of its span. */
const DOMAIN_PAD = 0.12;

const DEFAULT_VALUE_FORMAT = (value: number) => `${Math.round(value * 10) / 10}`;

/* ------------------------------------------------------------------ helpers */

/** 1, 2, 2.5, 5 or 10 × a power of ten — the steps that produce readable ticks. */
function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * magnitude;
}

function pickIndices(count: number, wanted: number): number[] {
  if (count <= 0) return [];
  if (count <= wanted) return Array.from({ length: count }, (_, i) => i);
  const step = (count - 1) / (wanted - 1);
  return Array.from({ length: wanted }, (_, i) => Math.round(i * step));
}

/* ---------------------------------------------------------------- component */

export function LineChart({
  data,
  height,
  target = null,
  color = 'primary',
  formatValue = DEFAULT_VALUE_FORMAT,
  formatX,
  formatScrubMeta,
  yTicks = 4,
  xTicks = 4,
  scrubbable = true,
  onScrubChange,
  animate = true,
  emptyLabel,
  accessibilityLabel,
  style,
  testID,
}: LineChartProps) {
  const t = useTheme();
  const gradientId = useSvgId('lc');

  const h = height ?? t.spacing.colossal * 2.4;
  const line = resolveColor(t.color, color, t.color.primary);
  const stroke = t.borderWidth.thick + 1;
  /** Caption leading — axis labels centre on their tick, not hang from it. */
  const captionLead = t.type.caption.lineHeight ?? t.spacing.base;

  const [width, setWidth] = useState(0);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);

  /* ---- geometry -------------------------------------------------------- */

  const axisWidth = t.spacing.xxxl;
  const geometry = useMemo<Geometry | null>(() => {
    if (width <= 0) return null;

    const plot = {
      left: axisWidth,
      right: width - t.spacing.sm,
      top: t.spacing.md,
      bottom: h - t.spacing.xl,
    };
    const innerW = Math.max(1, plot.right - plot.left);
    const innerH = Math.max(1, plot.bottom - plot.top);

    const values = data.map((p) => p.y);
    const bounds = [...values, ...(target ? [target.min, target.max] : [])];
    const rawLo = bounds.length ? Math.min(...bounds) : 0;
    const rawHi = bounds.length ? Math.max(...bounds) : 1;
    // A flat series still needs a domain, or every reading lands on one line.
    const spread = rawHi - rawLo || Math.max(1, Math.abs(rawHi) * 0.1);
    const step = niceStep((spread * (1 + DOMAIN_PAD * 2)) / Math.max(1, yTicks));
    const lo = Math.floor((rawLo - spread * DOMAIN_PAD) / step) * step;
    const hi = Math.ceil((rawHi + spread * DOMAIN_PAD) / step) * step;
    const span = hi - lo || 1;

    const yFor = (value: number) => plot.top + innerH - ((value - lo) / span) * innerH;

    const xLo = data[0]?.x ?? 0;
    const xHi = data[data.length - 1]?.x ?? 1;
    const xSpan = xHi - xLo;
    const xFor = (x: number) =>
      data.length <= 1 ? plot.left + innerW / 2 : plot.left + ((x - xLo) / (xSpan || 1)) * innerW;

    const points = data.map((p) => ({ x: xFor(p.x), y: yFor(p.y) }));
    const path = sparklinePath(points, true);
    const area =
      points.length > 1
        ? `${path} L${points[points.length - 1]!.x} ${plot.bottom} L${points[0]!.x} ${plot.bottom} Z`
        : '';

    const tickCount = Math.max(1, Math.round(span / step));
    const yTickValues = Array.from({ length: tickCount + 1 }, (_, i) => lo + i * step).filter(
      (value) => value <= hi + step / 2,
    );

    return {
      points,
      path,
      area,
      length: Math.max(1, polylineLength(points) * 1.08),
      yTickValues,
      yFor,
      xIndices: pickIndices(data.length, xTicks),
      plot,
    };
  }, [axisWidth, data, h, t.spacing, target, width, xTicks, yTicks]);

  /* ---- draw-on --------------------------------------------------------- */

  const progress = useSharedValue(0);
  const drawn = geometry?.length ?? 1;

  // Keyed on the *shape* of the data, not the geometry object. Scrubbing sets
  // React state every time the guide crosses a reading; if the parent rebuilds
  // its `data` array on those renders, keying on geometry would restart the
  // draw-on under the user's finger.
  useEffect(() => {
    if (width <= 0) return;
    if (!animate || t.reduceMotion) {
      progress.value = 1;
      return;
    }
    progress.value = 0;
    progress.value = withTiming(1, t.motion.timing(t.motion.duration.slower, 'decelerate'));
  }, [animate, data.length, progress, t.motion, t.reduceMotion, width]);

  const lineProps = useAnimatedProps<PathProps>(() => ({
    strokeDashoffset: drawn * (1 - progress.value),
  }));
  const areaOpacity = useDerivedValue(() => Math.max(0, progress.value * 1.5 - 0.5));
  const areaProps = useAnimatedProps<PathProps>(() => ({ opacity: areaOpacity.value }));

  /* ---- scrub ----------------------------------------------------------- */

  const xs = useSharedValue<number[]>([]);
  const ys = useSharedValue<number[]>([]);
  const guideX = useSharedValue(0);
  const guideY = useSharedValue(0);
  const activeIndex = useSharedValue(-1);
  const active = useSharedValue(0);
  const bubbleWidth = useSharedValue(0);

  useEffect(() => {
    xs.value = geometry?.points.map((p) => p.x) ?? [];
    ys.value = geometry?.points.map((p) => p.y) ?? [];
  }, [geometry, xs, ys]);

  const scrubRef = useRef(onScrubChange);
  scrubRef.current = onScrubChange;

  const reportIndex = useCallback(
    (index: number) => {
      haptics.soft();
      setScrubIndex(index);
      scrubRef.current?.(data[index] ?? null, index);
    },
    [data],
  );

  const clearScrub = useCallback(() => {
    setScrubIndex(null);
    scrubRef.current?.(null, -1);
  }, []);

  // Fires exactly when the guide finishes fading, so the bubble's text and its
  // opacity can never disagree.
  useAnimatedReaction(
    () => active.value < 0.02,
    (gone, previous) => {
      if (gone && previous === false) {
        activeIndex.value = -1;
        runOnJS(clearScrub)();
      }
    },
  );

  const enterTiming = useMemo(() => t.motion.timing(t.motion.duration.fast, 'standard'), [t.motion]);
  const exitTiming = useMemo(() => t.motion.timing(t.motion.duration.base, 'accelerate'), [t.motion]);

  const gesture = useMemo(() => {
    const apply = (px: number) => {
      'worklet';
      const list = xs.value;
      if (list.length === 0) return;
      let best = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let i = 0; i < list.length; i += 1) {
        const distance = Math.abs(list[i]! - px);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = i;
        }
      }
      guideX.value = list[best]!;
      guideY.value = ys.value[best] ?? 0;
      if (best !== activeIndex.value) {
        activeIndex.value = best;
        runOnJS(reportIndex)(best);
      }
    };

    const release = () => {
      'worklet';
      active.value = withDelay(LINGER_MS, withTiming(0, exitTiming));
    };

    const pan = Gesture.Pan()
      .enabled(scrubbable)
      // Sideways is a scrub, downwards belongs to the scroll view. Handing the
      // touch back is what keeps the chart from trapping the page.
      .activeOffsetX([-8, 8])
      .failOffsetY([-14, 14])
      .onStart((event) => {
        active.value = withTiming(1, enterTiming);
        apply(event.x);
      })
      .onUpdate((event) => {
        apply(event.x);
      })
      .onFinalize(release);

    const tap = Gesture.Tap()
      .enabled(scrubbable)
      .maxDuration(600)
      .onStart((event) => {
        active.value = withTiming(1, enterTiming);
        apply(event.x);
      })
      .onFinalize(release);

    return Gesture.Exclusive(pan, tap);
  }, [active, activeIndex, enterTiming, exitTiming, guideX, guideY, reportIndex, scrubbable, xs, ys]);

  /* ---- animated chrome ------------------------------------------------- */

  const plotTop = geometry?.plot.top ?? 0;
  const plotBottom = geometry?.plot.bottom ?? 0;
  const plotLeft = geometry?.plot.left ?? 0;
  const plotRight = geometry?.plot.right ?? 0;
  const hairline = t.borderWidth.hairline;
  const markerSize = t.spacing.md;

  const guideStyle = useAnimatedStyle(() => ({
    opacity: active.value,
    transform: [{ translateX: guideX.value - hairline / 2 }],
  }));

  const markerStyle = useAnimatedStyle(() => ({
    opacity: active.value,
    transform: [
      { translateX: guideX.value - markerSize / 2 },
      { translateY: guideY.value - markerSize / 2 },
      { scale: 0.6 + active.value * 0.4 },
    ],
  }));

  const bubbleStyle = useAnimatedStyle(() => {
    const bw = bubbleWidth.value;
    const min = plotLeft - t.spacing.xl;
    const max = Math.max(min, plotRight - bw);
    const wanted = guideX.value - bw / 2;
    return {
      opacity: active.value,
      transform: [{ translateX: Math.min(max, Math.max(min, wanted)) }],
    };
  });

  const handleBubbleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      bubbleWidth.value = event.nativeEvent.layout.width;
    },
    [bubbleWidth],
  );

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    setWidth((prev) => (Math.abs(prev - next) < 1 ? prev : next));
  }, []);

  /* ---- summary --------------------------------------------------------- */

  const summary = useMemo(() => {
    if (accessibilityLabel) return accessibilityLabel;
    if (data.length === 0) return emptyLabel ?? 'No readings yet';
    const values = data.map((p) => p.y);
    const first = formatValue(values[0]!);
    const last = formatValue(values[values.length - 1]!);
    const lo = formatValue(Math.min(...values));
    const hi = formatValue(Math.max(...values));
    return `Chart of ${data.length} readings, from ${first} to ${last}. Lowest ${lo}, highest ${hi}.`;
  }, [accessibilityLabel, data, emptyLabel, formatValue]);

  const scrubPoint = scrubIndex === null ? null : (data[scrubIndex] ?? null);

  return (
    <View
      onLayout={handleLayout}
      style={[{ height: h, width: '100%' }, style]}
      testID={testID}
      accessible
      accessibilityRole="image"
      accessibilityLabel={summary}
    >
      {geometry ? (
        <>
          <Svg width="100%" height="100%" viewBox={`0 0 ${width} ${h}`} pointerEvents="none">
            <Defs>
              <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={line} stopOpacity={0.3} />
                <Stop offset="1" stopColor={line} stopOpacity={0} />
              </LinearGradient>
            </Defs>

            {target ? (
              <>
                <Rect
                  x={geometry.plot.left}
                  y={geometry.yFor(target.max)}
                  width={geometry.plot.right - geometry.plot.left}
                  height={Math.max(1, geometry.yFor(target.min) - geometry.yFor(target.max))}
                  fill={t.color.success}
                  opacity={t.scheme === 'dark' ? 0.14 : 0.11}
                  rx={t.radius.xs}
                />
                {[target.max, target.min].map((edge) => (
                  <Line
                    key={edge}
                    x1={geometry.plot.left}
                    x2={geometry.plot.right}
                    y1={geometry.yFor(edge)}
                    y2={geometry.yFor(edge)}
                    stroke={t.color.success}
                    strokeWidth={hairline}
                    strokeDasharray="4 5"
                    opacity={0.7}
                  />
                ))}
              </>
            ) : null}

            {geometry.yTickValues.map((value) => (
              <Line
                key={value}
                x1={geometry.plot.left}
                x2={geometry.plot.right}
                y1={geometry.yFor(value)}
                y2={geometry.yFor(value)}
                stroke={t.color.divider}
                strokeWidth={hairline}
              />
            ))}

            {geometry.area ? (
              <AnimatedPath d={geometry.area} fill={`url(#${gradientId})`} animatedProps={areaProps} />
            ) : null}

            {geometry.points.length > 1 ? (
              <AnimatedPath
                d={geometry.path}
                fill="none"
                stroke={line}
                strokeWidth={stroke}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={drawn}
                animatedProps={lineProps}
              />
            ) : null}

            {/* One reading still deserves a chart, so it draws its own level. */}
            {geometry.points.length === 1 ? (
              <Line
                x1={geometry.plot.left}
                x2={geometry.plot.right}
                y1={geometry.points[0]!.y}
                y2={geometry.points[0]!.y}
                stroke={line}
                strokeWidth={stroke}
                strokeDasharray="2 7"
                strokeLinecap="round"
                opacity={0.6}
              />
            ) : null}

            {geometry.points.length <= DOT_LIMIT
              ? geometry.points.map((p, index) => (
                  <Circle
                    key={`${p.x}-${index}`}
                    cx={p.x}
                    cy={p.y}
                    r={stroke * 1.1}
                    fill={t.color.surface}
                    stroke={line}
                    strokeWidth={hairline * 2}
                  />
                ))
              : null}
          </Svg>

          {/* ---- axes, as real text ---------------------------------------- */}
          {geometry.yTickValues.map((value) => (
            <View
              key={value}
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: 0,
                width: axisWidth - t.spacing.xs,
                top: geometry.yFor(value) - captionLead / 2,
              }}
            >
              <Text variant="caption" color="textTertiary" align="right" tabular numberOfLines={1}>
                {formatValue(value)}
              </Text>
            </View>
          ))}

          {formatX
            ? geometry.xIndices.map((index) => {
                const point = geometry.points[index];
                const datum = data[index];
                if (!point || !datum) return null;
                const labelWidth = t.spacing.giant;
                const left = Math.min(
                  width - labelWidth,
                  Math.max(0, point.x - labelWidth / 2),
                );
                return (
                  <View
                    key={index}
                    pointerEvents="none"
                    style={{ position: 'absolute', left, width: labelWidth, top: geometry.plot.bottom + t.spacing.xs }}
                  >
                    <Text variant="caption" color="textTertiary" align="center" numberOfLines={1}>
                      {formatX(datum.x)}
                    </Text>
                  </View>
                );
              })
            : null}

          {target?.label ? (
            <View
              pointerEvents="none"
              style={{
                position: 'absolute',
                right: t.spacing.sm,
                top: geometry.yFor(target.max) - captionLead - t.spacing.hair,
              }}
            >
              <Text variant="caption" color="onSuccessSoft">
                {target.label}
              </Text>
            </View>
          ) : null}

          {data.length === 0 && emptyLabel ? (
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
              <Text variant="footnote" color="textTertiary" align="center">
                {emptyLabel}
              </Text>
            </View>
          ) : null}

          {/* ---- scrub chrome ---------------------------------------------- */}
          <Animated.View
            pointerEvents="none"
            style={[
              styles.guide,
              {
                top: plotTop,
                height: plotBottom - plotTop,
                width: hairline,
                backgroundColor: line,
              },
              guideStyle,
            ]}
          />
          <Animated.View
            pointerEvents="none"
            style={[
              styles.marker,
              {
                width: markerSize,
                height: markerSize,
                borderRadius: markerSize / 2,
                backgroundColor: line,
                borderWidth: t.borderWidth.thick,
                borderColor: t.color.surface,
              },
              markerStyle,
            ]}
          />

          {scrubPoint ? (
            <Animated.View pointerEvents="none" style={[styles.bubble, bubbleStyle]}>
              <Surface
                elevation={2}
                radius="md"
                paddingX="md"
                paddingY="xs"
                onLayout={handleBubbleLayout}
                style={{ alignItems: 'center' }}
              >
                <Text variant="subheadStrong" tabular numberOfLines={1}>
                  {formatValue(scrubPoint.y)}
                </Text>
                {formatScrubMeta ? (
                  <Text variant="caption" color="textTertiary" numberOfLines={1}>
                    {formatScrubMeta(scrubPoint, scrubIndex ?? 0)}
                  </Text>
                ) : null}
              </Surface>
            </Animated.View>
          ) : null}

          {scrubbable && data.length > 0 ? (
            <GestureDetector gesture={gesture}>
              <View style={StyleSheet.absoluteFill} />
            </GestureDetector>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  guide: { position: 'absolute', left: 0 },
  marker: { position: 'absolute', left: 0, top: 0 },
  bubble: { position: 'absolute', left: 0, top: 0, alignSelf: 'flex-start' },
});

export default LineChart;
