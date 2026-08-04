/**
 * Petal — Switch.
 *
 * Hand-built rather than RN's `Switch`, for reasons that matter here: the
 * platform control can't take our palette (Android's `trackColor` ignores the
 * off state's border, iOS ignores everything but the on-tint), it can't carry
 * the app's spring vocabulary, and it can't stretch under a thumb.
 *
 * The stretch is the detail worth keeping. While held, the thumb elongates by
 * one grid step *away from the edge it's parked against*, so the control feels
 * like a physical object being leaned on rather than a picture of a switch.
 *
 * `label`/`description` are optional but recommended — a settings row where the
 * whole line is tappable has a target several times larger than the toggle, and
 * that's the difference between "fiddly" and "effortless" one-handed.
 */

import React, { useCallback, useEffect } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  interpolate,
  interpolateColor,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type WithSpringConfig,
} from 'react-native-reanimated';

import haptics from '@/lib/haptics';
import { spring, useTheme, type Theme } from '@/theme';
import { Column, Row } from './Stack';
import { Text } from './Text';
import { Touchable } from './Touchable';

/* -------------------------------------------------------------------- types */

export type SwitchSize = 'sm' | 'md';
export type SwitchTone = 'primary' | 'success' | 'accent';

export type SwitchProps = {
  value: boolean;
  onValueChange: (value: boolean) => void;
  /** Renders an inline row and makes the whole line tappable. */
  label?: string;
  description?: string;
  size?: SwitchSize;
  tone?: SwitchTone;
  disabled?: boolean;
  /** Looks disabled, still tappable — `onValueChange` is skipped, the reason is announced. */
  disabledReason?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/** See `Touchable` — the theme's `springWith` helper doesn't type-check yet. */
const THUMB_SPRING: WithSpringConfig = { ...spring.snappy, reduceMotion: ReduceMotion.System };
const PRESS_SPRING: WithSpringConfig = { ...spring.press, reduceMotion: ReduceMotion.System };

/* ------------------------------------------------------------------ helpers */

function toneFill(t: Theme, tone: SwitchTone): string {
  switch (tone) {
    case 'accent':
      return t.color.accent;
    case 'success':
      return t.color.success;
    case 'primary':
    default:
      return t.color.primary;
  }
}

/** Track geometry, entirely from the spacing grid so it retunes with the app. */
function geometry(t: Theme, size: SwitchSize) {
  const height = size === 'md' ? t.spacing.xl + t.spacing.xxs : t.spacing.lg + t.spacing.xxs;
  const width = size === 'md' ? t.spacing.huge : t.spacing.xxxl;
  const pad = t.spacing.hair;
  const thumb = height - pad * 2;
  return { height, width, pad, thumb, travel: width - thumb - pad * 2, stretch: t.spacing.xxs };
}

/* ---------------------------------------------------------------- component */

export function Switch({
  value,
  onValueChange,
  label,
  description,
  size = 'md',
  tone = 'primary',
  disabled = false,
  disabledReason,
  accessibilityLabel,
  accessibilityHint,
  style,
  testID,
}: SwitchProps) {
  const t = useTheme();
  const g = geometry(t, size);

  const on = useSharedValue(value ? 1 : 0);
  const held = useSharedValue(0);

  useEffect(() => {
    on.value = withSpring(value ? 1 : 0, THUMB_SPRING);
  }, [on, value]);

  const fill = toneFill(t, tone);
  const offTrack = t.color.borderStrong;
  // A thumb must read as light in both schemes; `surface` is white in light and
  // near-black in dark, so this is one of the rare places scheme is read directly.
  const thumbColor = t.scheme === 'dark' ? t.color.text : t.color.surface;

  const trackStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(on.value, [0, 1], [offTrack, fill]),
  }));

  const thumbStyle = useAnimatedStyle(() => {
    const grow = held.value * g.stretch;
    return {
      width: g.thumb + grow,
      // Stretching away from the edge it's parked against keeps the gap even.
      transform: [{ translateX: interpolate(on.value, [0, 1], [0, g.travel]) - on.value * grow }],
    };
  });

  const inert = disabled || disabledReason !== undefined;

  const handlePress = useCallback(() => {
    if (inert) return;
    haptics.commit();
    onValueChange(!value);
  }, [inert, onValueChange, value]);

  const control = (
    <Animated.View
      style={[
        styles.track,
        { width: g.width, height: g.height, borderRadius: t.radius.pill, padding: g.pad },
        trackStyle,
      ]}
    >
      <Animated.View
        style={[
          t.elevation(2),
          {
            height: g.thumb,
            borderRadius: t.radius.pill,
            backgroundColor: thumbColor,
          },
          thumbStyle,
        ]}
      />
    </Animated.View>
  );

  const body = label ? (
    <Row gap="base" align="center" style={styles.row}>
      <Column flex gap="hair">
        <Text variant="body" color={inert ? 'textFaint' : 'text'}>
          {label}
        </Text>
        {description ? (
          <Text variant="footnote" color={inert ? 'textFaint' : 'textTertiary'}>
            {description}
          </Text>
        ) : null}
      </Column>
      {control}
    </Row>
  ) : (
    control
  );

  return (
    <Touchable
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      disabledReason={disabledReason}
      // The commit haptic fires on the state change, not on touch-down — a
      // toggle that buzzes before it moves feels like it fired twice.
      haptic="none"
      onPress={handlePress}
      onPressIn={() => {
        held.value = withSpring(1, PRESS_SPRING);
      }}
      onPressOut={() => {
        held.value = withSpring(0, PRESS_SPRING);
      }}
      pressScale={1}
      style={[
        label ? { alignSelf: 'stretch', minHeight: t.minTarget, justifyContent: 'center' } : styles.self,
        style,
      ]}
      testID={testID}
    >
      {body}
    </Touchable>
  );
}

const styles = StyleSheet.create({
  track: { justifyContent: 'center' },
  row: { flex: 1 },
  self: { alignSelf: 'flex-start' },
});

export default Switch;
