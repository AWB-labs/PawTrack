/**
 * Petal — Chip.
 *
 * Filter and selection chips. Selection is animated on three axes at once —
 * the fill and border cross-fade, and a checkmark grows in from zero width so
 * the chip visibly *takes on* the mark rather than blinking into a new state.
 *
 * The label is rendered twice (once per ink colour) and cross-faded. Reanimated
 * can't tween a `color` on a plain RN Text without an animated text node, and
 * two stacked labels are cheaper and more predictable than one — the duplicate
 * is hidden from screen readers.
 */

import React, { useEffect } from 'react';
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

import { spring, useTheme, type Theme, type TypeVariant } from '@/theme';
import { Icon, ICON_SIZE, type IconName, type IconSize } from './Icon';
import type { SpacingToken } from './Stack';
import { Text } from './Text';
import { Touchable } from './Touchable';

/* -------------------------------------------------------------------- types */

export type ChipSize = 'sm' | 'md';
export type ChipTone = 'primary' | 'accent';

export type ChipProps = {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  /** Adds a trailing dismiss control — for chips that represent applied filters. */
  onRemove?: () => void;
  icon?: IconName;
  /** Leading emoji. Takes precedence over `icon` — species chips read better with one. */
  emoji?: string;
  size?: ChipSize;
  tone?: ChipTone;
  /** Hide the checkmark on chips whose fill alone carries the state. */
  showCheck?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

/* ---------------------------------------------------------------- constants */

/** See Touchable: the theme's `springWith` helper doesn't type-check yet. */
const SELECT_SPRING: WithSpringConfig = { ...spring.snappy, reduceMotion: ReduceMotion.System };

const SIZES: Record<ChipSize, { type: TypeVariant; padX: SpacingToken; padY: SpacingToken; icon: IconSize }> = {
  sm: { type: 'caption', padX: 'sm', padY: 'xxs', icon: 'xs' },
  md: { type: 'subheadStrong', padX: 'md', padY: 'sm', icon: 'sm' },
};

/* ------------------------------------------------------------------ helpers */

function toneSkin(t: Theme, tone: ChipTone) {
  return tone === 'accent'
    ? { fill: t.color.accentSoft, border: t.color.accentSoft, ink: t.color.onAccentSoft }
    : { fill: t.color.primarySoft, border: t.color.primarySoftBorder, ink: t.color.onPrimarySoft };
}

/* ---------------------------------------------------------------- component */

export function Chip({
  label,
  selected = false,
  onPress,
  onRemove,
  icon,
  emoji,
  size = 'md',
  tone = 'primary',
  showCheck = true,
  disabled = false,
  disabledReason,
  accessibilityLabel,
  accessibilityHint,
  testID,
  style,
}: ChipProps) {
  const t = useTheme();
  const spec = SIZES[size];
  const on = toneSkin(t, tone);

  const restBackground = t.color.surfaceAlt;
  const restBorder = t.color.border;
  const restInk = t.color.textSecondary;

  const progress = useSharedValue(selected ? 1 : 0);
  useEffect(() => {
    progress.value = withSpring(selected ? 1 : 0, SELECT_SPRING);
  }, [progress, selected]);

  const skinStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [restBackground, on.fill]),
    borderColor: interpolateColor(progress.value, [0, 1], [restBorder, on.border]),
  }));

  const gap = t.spacing.xs;
  const checkWidth = ICON_SIZE[spec.icon] + gap;
  const checkStyle = useAnimatedStyle(() => ({
    width: interpolate(progress.value, [0, 1], [0, checkWidth]),
    opacity: progress.value,
    transform: [{ translateX: interpolate(progress.value, [0, 1], [-gap, 0]) }],
  }));

  const restLabelStyle = useAnimatedStyle(() => ({ opacity: 1 - progress.value }));
  const selectedLabelStyle = useAnimatedStyle(() => ({ opacity: progress.value }));

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      disabledReason={disabledReason}
      haptic="select"
      onPress={onPress}
      pressScale="small"
      testID={testID}
      style={style}
    >
      <Animated.View
        style={[
          styles.chip,
          {
            paddingHorizontal: t.spacing[spec.padX],
            paddingVertical: t.spacing[spec.padY],
            borderRadius: t.radius.pill,
            borderWidth: t.borderWidth.hairline,
          },
          skinStyle,
        ]}
      >
        {showCheck ? (
          <Animated.View style={[styles.check, checkStyle]}>
            <Icon name="checkmark" size={spec.icon} color={on.ink} />
          </Animated.View>
        ) : null}

        {emoji ? (
          <Text variant={spec.type} style={{ marginRight: gap }}>
            {emoji}
          </Text>
        ) : icon ? (
          <View style={{ marginRight: gap }}>
            <Icon name={icon} size={spec.icon} color={selected ? on.ink : restInk} />
          </View>
        ) : null}

        <View style={styles.labels}>
          <Animated.View style={restLabelStyle}>
            <Text variant={spec.type} color={restInk} numberOfLines={1}>
              {label}
            </Text>
          </Animated.View>
          <Animated.View
            style={[StyleSheet.absoluteFill, selectedLabelStyle]}
            pointerEvents="none"
            importantForAccessibility="no-hide-descendants"
          >
            <Text variant={spec.type} color={on.ink} numberOfLines={1}>
              {label}
            </Text>
          </Animated.View>
        </View>

        {onRemove ? (
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={`Remove ${label}`}
            haptic="tap"
            onPress={onRemove}
            pressScale="small"
            style={{ marginLeft: gap }}
          >
            <Icon name="close" size={spec.icon} color={selected ? on.ink : restInk} />
          </Touchable>
        ) : null}
      </Animated.View>
    </Touchable>
  );
}

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' },
  // Clipping is what turns the width tween into a slide rather than a squash.
  check: { overflow: 'hidden', flexDirection: 'row', alignItems: 'center' },
  labels: { flexShrink: 1 },
});

export default Chip;
