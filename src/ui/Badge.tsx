/**
 * Petal — Badge.
 *
 * Status in one glance: a soft wash pill with matching ink (the palette's
 * `*Soft` / `on*Soft` pairing, so contrast holds in both schemes), or a solid
 * fill for badges that sit over photography.
 *
 * Counts pop when they change. That tiny spring is the difference between a
 * number that *updated* and a number that was always there — it's the only
 * signal that a caregiver just logged a dose while you were looking at the
 * screen.
 */

import React, { useEffect, useRef } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  type WithSpringConfig,
} from 'react-native-reanimated';

import { spring, useTheme, type Theme, type TypeVariant } from '@/theme';
import type { SpacingToken } from './Stack';
import { Text } from './Text';

/* -------------------------------------------------------------------- types */

export type BadgeTone = 'neutral' | 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'info';
export type BadgeSize = 'sm' | 'md';

export type BadgeProps = {
  label?: string;
  /** Clamped to `99+`. Takes precedence over `label`. */
  count?: number;
  /** Leading status dot. On its own (no label/count) renders a bare dot. */
  dot?: boolean;
  tone?: BadgeTone;
  size?: BadgeSize;
  /** Solid fill instead of the soft wash — for badges over imagery. */
  solid?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

const COUNT_CEILING = 99;

/** See Touchable: the theme's `springWith` helper doesn't type-check yet. */
const POP_IN: WithSpringConfig = { ...spring.snappy, reduceMotion: ReduceMotion.System };
const POP_OUT: WithSpringConfig = { ...spring.gentle, reduceMotion: ReduceMotion.System };

const SIZES: Record<BadgeSize, { type: TypeVariant; padX: SpacingToken; padY: SpacingToken }> = {
  sm: { type: 'caption', padX: 'xs', padY: 'hair' },
  md: { type: 'captionStrong', padX: 'sm', padY: 'xxs' },
};

/* ------------------------------------------------------------------ helpers */

function toneSkin(t: Theme, tone: BadgeTone, solid: boolean) {
  const map: Record<BadgeTone, { fill: string; onFill: string; soft: string; onSoft: string; mark: string }> = {
    neutral: {
      fill: t.color.textSecondary,
      onFill: t.color.textInverse,
      soft: t.color.surfaceAlt,
      onSoft: t.color.textSecondary,
      mark: t.color.textTertiary,
    },
    primary: {
      fill: t.color.primary,
      onFill: t.color.onPrimary,
      soft: t.color.primarySoft,
      onSoft: t.color.onPrimarySoft,
      mark: t.color.primary,
    },
    accent: {
      fill: t.color.accent,
      onFill: t.color.onAccent,
      soft: t.color.accentSoft,
      onSoft: t.color.onAccentSoft,
      mark: t.color.accent,
    },
    success: {
      fill: t.color.success,
      onFill: t.color.onSuccess,
      soft: t.color.successSoft,
      onSoft: t.color.onSuccessSoft,
      mark: t.color.success,
    },
    warning: {
      fill: t.color.warning,
      onFill: t.color.onWarning,
      soft: t.color.warningSoft,
      onSoft: t.color.onWarningSoft,
      mark: t.color.warning,
    },
    danger: {
      fill: t.color.danger,
      onFill: t.color.onDanger,
      soft: t.color.dangerSoft,
      onSoft: t.color.onDangerSoft,
      mark: t.color.danger,
    },
    info: {
      fill: t.color.info,
      onFill: t.color.onInfo,
      soft: t.color.infoSoft,
      onSoft: t.color.onInfoSoft,
      mark: t.color.info,
    },
  };
  const c = map[tone];
  return {
    background: solid ? c.fill : c.soft,
    ink: solid ? c.onFill : c.onSoft,
    // A dot on a soft wash needs the saturated colour to register at 8pt.
    mark: solid ? c.onFill : c.mark,
  };
}

/* ---------------------------------------------------------------- component */

export function Badge({
  label,
  count,
  dot = false,
  tone = 'neutral',
  size = 'sm',
  solid = false,
  accessibilityLabel,
  style,
  testID,
}: BadgeProps) {
  const t = useTheme();
  const spec = SIZES[size];
  const skin = toneSkin(t, tone, solid);

  const pop = useSharedValue(1);
  const seen = useRef(count);
  useEffect(() => {
    if (count === undefined || seen.current === count) {
      seen.current = count;
      return;
    }
    seen.current = count;
    pop.value = withSequence(withSpring(1.22, POP_IN), withSpring(1, POP_OUT));
  }, [count, pop]);

  const popStyle = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }));

  const text = count === undefined ? label : count > COUNT_CEILING ? `${COUNT_CEILING}+` : String(count);
  const dotSize = t.spacing.sm;

  if (text === undefined) {
    return (
      <Animated.View
        // A bare dot with nothing to say is decorative; announcing "image"
        // with no label is worse than silence.
        accessibilityRole={accessibilityLabel ? 'image' : 'none'}
        accessibilityLabel={accessibilityLabel}
        importantForAccessibility={accessibilityLabel ? 'yes' : 'no-hide-descendants'}
        testID={testID}
        style={[
          { width: dotSize, height: dotSize, borderRadius: dotSize / 2, backgroundColor: skin.mark },
          popStyle,
          style,
        ]}
      />
    );
  }

  const padY = t.spacing[spec.padY];
  const height = t.type[spec.type].lineHeight;

  return (
    <Animated.View
      accessibilityRole="text"
      accessibilityLabel={accessibilityLabel ?? text}
      testID={testID}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          alignSelf: 'flex-start',
          gap: t.spacing.xxs,
          paddingHorizontal: t.spacing[spec.padX],
          paddingVertical: padY,
          borderRadius: t.radius.pill,
          backgroundColor: skin.background,
          // Keeps a single-digit count round instead of oval.
          minWidth: (height ?? 0) + padY * 2,
          justifyContent: 'center',
        },
        popStyle,
        style,
      ]}
    >
      {dot ? (
        <View
          style={{
            width: t.spacing.xs,
            height: t.spacing.xs,
            borderRadius: t.spacing.xs / 2,
            backgroundColor: skin.mark,
          }}
        />
      ) : null}
      <Text variant={spec.type} color={skin.ink} tabular={count !== undefined} numberOfLines={1}>
        {text}
      </Text>
    </Animated.View>
  );
}

export default Badge;
