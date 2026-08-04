/**
 * Petal — BarChart.
 *
 * Seven days of adherence or meals, in a card. Small enough that it is built
 * from views rather than SVG: bars that are real views can be individually
 * pressable, keep a 44pt target, and animate their height on the UI thread
 * without re-rendering React.
 *
 * Two choices that carry the design:
 *
 *   · **Every bar has a track.** An empty Tuesday still shows the shape of the
 *     day it should have filled, so "missed" and "not scheduled" don't look the
 *     same. A bare bar chart hides its own zeroes.
 *   · **The grow-in staggers left to right and then stops.** Eight steps of
 *     40ms reads as a wave; twenty reads as a slow app, so the stagger caps.
 */

import React, { useEffect, useMemo } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
  type WithSpringConfig,
} from 'react-native-reanimated';

import { spring, useTheme, type Theme } from '@/theme';
import { Text } from './Text';
import { Touchable } from './Touchable';

/* -------------------------------------------------------------------- types */

export type BarChartTone = 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'neutral';

export type BarChartDatum = {
  key: string;
  /** Axis label under the bar — "Mon", "W1". Keep it to three characters. */
  label: string;
  value: number;
  /** What a full bar means for this bucket. Falls back to the chart's `max`. */
  target?: number;
  tone?: BarChartTone;
  /** Announced instead of the raw numbers — "Monday, 3 of 3 doses given". */
  accessibilityLabel?: string;
};

export type BarChartProps = {
  data: BarChartDatum[];
  /** Plot height, excluding the labels underneath. */
  height?: number;
  /** Domain ceiling. Defaults to the largest value or target present. */
  max?: number;
  selectedKey?: string | null;
  onSelect?: (datum: BarChartDatum, index: number) => void;
  /** Value printed above each bar. Omit to hide the numbers. */
  formatValue?: (value: number, datum: BarChartDatum) => string;
  tone?: BarChartTone;
  animate?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/** Beyond this the cascade stops reading as choreography. */
const MAX_STAGGERED = 8;
/** A zero bar still shows a sliver, so the axis never looks broken. */
const MIN_FILL = 0.035;

/** See Touchable: the theme's `springWith` helper doesn't type-check yet. */
const GROW: WithSpringConfig = { ...spring.gentle, reduceMotion: ReduceMotion.System };

/* ------------------------------------------------------------------ helpers */

function toneColors(t: Theme, tone: BarChartTone) {
  switch (tone) {
    case 'accent':
      return { fill: t.color.accent, soft: t.color.accentSoft, ink: t.color.accentText };
    case 'success':
      return { fill: t.color.success, soft: t.color.successSoft, ink: t.color.onSuccessSoft };
    case 'warning':
      return { fill: t.color.warning, soft: t.color.warningSoft, ink: t.color.onWarningSoft };
    case 'danger':
      return { fill: t.color.danger, soft: t.color.dangerSoft, ink: t.color.onDangerSoft };
    case 'neutral':
      return { fill: t.color.textTertiary, soft: t.color.surfaceAlt, ink: t.color.textSecondary };
    case 'primary':
    default:
      return { fill: t.color.primary, soft: t.color.primarySoft, ink: t.color.primaryText };
  }
}

/* ---------------------------------------------------------------- component */

export function BarChart({
  data,
  height,
  max,
  selectedKey = null,
  onSelect,
  formatValue,
  tone = 'primary',
  animate = true,
  accessibilityLabel,
  style,
  testID,
}: BarChartProps) {
  const t = useTheme();
  const plotHeight = height ?? t.spacing.colossal * 1.5;

  const ceiling = useMemo(() => {
    const candidates = data.flatMap((d) => [d.value, d.target ?? 0]);
    return Math.max(max ?? 0, ...candidates, 1);
  }, [data, max]);

  return (
    <View
      style={[{ flexDirection: 'row', alignItems: 'flex-end', gap: t.spacing.xs }, style]}
      accessibilityRole={accessibilityLabel ? 'summary' : undefined}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      {data.map((datum, index) => (
        <Bar
          key={datum.key}
          datum={datum}
          index={index}
          ceiling={ceiling}
          plotHeight={plotHeight}
          tone={datum.tone ?? tone}
          selected={selectedKey === datum.key}
          anySelected={selectedKey !== null}
          onSelect={onSelect}
          formatValue={formatValue}
          animate={animate}
        />
      ))}
    </View>
  );
}

/* --------------------------------------------------------------------- bar */

type BarProps = {
  datum: BarChartDatum;
  index: number;
  ceiling: number;
  plotHeight: number;
  tone: BarChartTone;
  selected: boolean;
  anySelected: boolean;
  onSelect?: (datum: BarChartDatum, index: number) => void;
  formatValue?: (value: number, datum: BarChartDatum) => string;
  animate: boolean;
};

function Bar({
  datum,
  index,
  ceiling,
  plotHeight,
  tone,
  selected,
  anySelected,
  onSelect,
  formatValue,
  animate,
}: BarProps) {
  const t = useTheme();
  const skin = toneColors(t, tone);

  const ratio = Math.max(MIN_FILL, Math.min(1, datum.value / ceiling));
  const filled = ratio * plotHeight;

  const grow = useSharedValue(animate && !t.reduceMotion ? 0 : 1);
  const chosen = useSharedValue(selected ? 1 : 0);

  useEffect(() => {
    if (!animate || t.reduceMotion) {
      grow.value = 1;
      return;
    }
    grow.value = 0;
    grow.value = withDelay(Math.min(index, MAX_STAGGERED) * t.motion.stagger.base, withSpring(1, GROW));
  }, [animate, grow, index, t.motion, t.reduceMotion]);

  useEffect(() => {
    chosen.value = withTiming(selected ? 1 : 0, t.motion.timing(t.motion.duration.fast, 'smooth'));
  }, [chosen, selected, t.motion]);

  const fillStyle = useAnimatedStyle(() => ({ height: filled * grow.value }));

  // The unselected bars recede rather than the selected one shouting — the
  // chart stays the same brightness whichever day you tap.
  const dimStyle = useAnimatedStyle(() => ({
    opacity: anySelected ? 0.45 + chosen.value * 0.55 : 1,
  }));

  const trackStyle: ViewStyle = {
    height: plotHeight,
    borderRadius: t.radius.sm,
    backgroundColor: skin.soft,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  };

  const label = formatValue ? formatValue(datum.value, datum) : null;
  const description =
    datum.accessibilityLabel ?? `${datum.label}: ${label ?? String(datum.value)}`;

  const body = (
    <Animated.View style={[{ flex: 1, gap: t.spacing.xxs, alignItems: 'stretch' }, dimStyle]}>
      {formatValue ? (
        <Text variant="caption" color={selected ? skin.ink : 'textTertiary'} align="center" tabular numberOfLines={1}>
          {label}
        </Text>
      ) : null}
      <View style={trackStyle}>
        <Animated.View style={[{ borderRadius: t.radius.sm, backgroundColor: skin.fill }, fillStyle]} />
      </View>
      <Text
        variant={selected ? 'captionStrong' : 'caption'}
        color={selected ? skin.ink : 'textTertiary'}
        align="center"
        numberOfLines={1}
      >
        {datum.label}
      </Text>
    </Animated.View>
  );

  if (!onSelect) {
    return (
      <View style={{ flex: 1 }} accessible accessibilityRole="text" accessibilityLabel={description}>
        {body}
      </View>
    );
  }

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={description}
      accessibilityState={{ selected }}
      haptic="select"
      onPress={() => onSelect(datum, index)}
      pressScale="large"
      style={{ flex: 1 }}
    >
      {body}
    </Touchable>
  );
}

export default BarChart;
