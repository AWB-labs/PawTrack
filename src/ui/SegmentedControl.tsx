/**
 * Petal — SegmentedControl.
 *
 * The pill doesn't jump between segments; it springs, and the labels recolour
 * *as it passes over them*. That's the difference between a control that
 * switches and one that feels like a physical slider — and it costs one shared
 * value, because every label's colour is derived from the pill's live position
 * rather than from React state.
 *
 * Equal-width segments are a deliberate constraint: content-width segments make
 * the pill's travel unpredictable and the control jitter when a label changes
 * length (which it does, under dynamic type). Two to five segments; past that
 * the labels stop fitting and the right control is a `Select`.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  interpolateColor,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
  type WithSpringConfig,
} from 'react-native-reanimated';

import haptics from '@/lib/haptics';
import { spring, useTheme } from '@/theme';
import { AnimatedText } from './FormField';
import { Icon, ICON_SIZE, type IconName, type IconSize } from './Icon';
import { Touchable } from './Touchable';

/* -------------------------------------------------------------------- types */

export type SegmentValue = string | number;

export type Segment<T extends SegmentValue> = {
  value: T;
  label: string;
  icon?: IconName;
  disabled?: boolean;
  /** Overrides the announced name when the visible label is an abbreviation. */
  accessibilityLabel?: string;
};

export type SegmentedControlSize = 'sm' | 'md';

export type SegmentedControlProps<T extends SegmentValue> = {
  segments: Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: SegmentedControlSize;
  disabled?: boolean;
  /** Announced for the group as a whole — "Weight unit", "Date range". */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/** See `Touchable` — the theme's `springWith` helper doesn't type-check yet. */
const SLIDE_SPRING: WithSpringConfig = { ...spring.snappy, reduceMotion: ReduceMotion.System };

const SIZES: Record<SegmentedControlSize, { padY: 'xs' | 'sm'; icon: IconSize; type: 'buttonSmall' | 'button' }> = {
  sm: { padY: 'xs', icon: 'xs', type: 'buttonSmall' },
  md: { padY: 'sm', icon: 'sm', type: 'button' },
};

/* ------------------------------------------------------------------ pieces */

/**
 * Proximity to the pill, 1 at dead centre and 0 a full segment away. Both the
 * label colour and the icon cross-fade read from this, so they move together.
 */
function useProximity(position: SharedValue<number>, index: number) {
  return useAnimatedStyle(() => {
    const distance = Math.min(1, Math.abs(position.value - index));
    return { opacity: 1 - distance };
  });
}

function SegmentIcon({
  name,
  size,
  position,
  index,
  restColor,
  activeColor,
}: {
  name: IconName;
  size: IconSize;
  position: SharedValue<number>;
  index: number;
  restColor: string;
  activeColor: string;
}) {
  const box = ICON_SIZE[size];
  const activeStyle = useProximity(position, index);
  const restStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, Math.abs(position.value - index)),
  }));

  return (
    <View style={{ width: box, height: box }}>
      <Animated.View style={[StyleSheet.absoluteFill, restStyle]}>
        <Icon name={name} size={size} color={restColor} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, activeStyle]} importantForAccessibility="no-hide-descendants">
        <Icon name={name} size={size} color={activeColor} />
      </Animated.View>
    </View>
  );
}

/* ---------------------------------------------------------------- component */

export function SegmentedControl<T extends SegmentValue>({
  segments,
  value,
  onChange,
  size = 'md',
  disabled = false,
  accessibilityLabel,
  style,
  testID,
}: SegmentedControlProps<T>) {
  const t = useTheme();
  const spec = SIZES[size];
  const [trackWidth, setTrackWidth] = useState(0);

  const count = Math.max(1, segments.length);
  const index = useMemo(() => {
    const found = segments.findIndex((segment) => segment.value === value);
    return found >= 0 ? found : 0;
  }, [segments, value]);

  const position = useSharedValue(index);
  useEffect(() => {
    position.value = withSpring(index, SLIDE_SPRING);
  }, [index, position]);

  const inset = t.spacing.xxs;
  const segmentWidth = trackWidth > 0 ? trackWidth / count : 0;

  const onTrackLayout = useCallback((event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    setTrackWidth((prev) => (Math.abs(prev - width) < 1 ? prev : width));
  }, []);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: position.value * segmentWidth }],
  }));

  const handlePress = useCallback(
    (segment: Segment<T>) => {
      if (segment.value === value) return;
      haptics.select();
      onChange(segment.value);
    },
    [onChange, value],
  );

  const restInk = t.color.textSecondary;
  const activeInk = t.color.text;

  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      style={[
        styles.track,
        {
          padding: inset,
          borderRadius: t.radius.lg,
          backgroundColor: t.color.surfaceAlt,
          opacity: disabled ? t.opacity.disabled : 1,
        },
        style,
      ]}
    >
      <View style={styles.inner} onLayout={onTrackLayout}>
        {segmentWidth > 0 ? (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.indicator,
              t.elevation(1),
              {
                width: segmentWidth,
                borderRadius: t.radius.md,
                backgroundColor: t.scheme === 'dark' ? t.color.surfaceRaised : t.color.surface,
              },
              indicatorStyle,
            ]}
          />
        ) : null}

        {segments.map((segment, i) => (
          <SegmentButton
            key={String(segment.value)}
            segment={segment}
            index={i}
            position={position}
            disabled={disabled}
            spec={spec}
            restInk={restInk}
            activeInk={activeInk}
            selected={i === index}
            onPress={handlePress}
          />
        ))}
      </View>
    </View>
  );
}

function SegmentButton<T extends SegmentValue>({
  segment,
  index,
  position,
  disabled,
  spec,
  restInk,
  activeInk,
  selected,
  onPress,
}: {
  segment: Segment<T>;
  index: number;
  position: SharedValue<number>;
  disabled: boolean;
  spec: (typeof SIZES)[SegmentedControlSize];
  restInk: string;
  activeInk: string;
  selected: boolean;
  onPress: (segment: Segment<T>) => void;
}) {
  const t = useTheme();

  const inkStyle = useAnimatedStyle(() => {
    const nearness = 1 - Math.min(1, Math.abs(position.value - index));
    return { color: interpolateColor(nearness, [0, 1], [restInk, activeInk]) };
  });

  const off = disabled || segment.disabled;

  return (
    <Touchable
      accessibilityRole="tab"
      accessibilityLabel={segment.accessibilityLabel ?? segment.label}
      accessibilityState={{ selected, disabled: off }}
      disabled={off}
      haptic="none"
      onPress={() => onPress(segment)}
      // The pill carries the motion; scaling the label too would fight it.
      pressScale={1}
      style={[styles.segment, { paddingVertical: t.spacing[spec.padY], gap: t.spacing.xs }]}
    >
      {segment.icon ? (
        <SegmentIcon
          name={segment.icon}
          size={spec.icon}
          position={position}
          index={index}
          restColor={restInk}
          activeColor={activeInk}
        />
      ) : null}
      <AnimatedText variant={spec.type} numberOfLines={1} style={inkStyle}>
        {segment.label}
      </AnimatedText>
    </Touchable>
  );
}

const styles = StyleSheet.create({
  track: { alignSelf: 'stretch' },
  inner: { flexDirection: 'row', alignItems: 'stretch' },
  indicator: { position: 'absolute', top: 0, bottom: 0, left: 0 },
  segment: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
});

export default SegmentedControl;
