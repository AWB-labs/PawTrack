/**
 * Petal — IconButton.
 *
 * Icon-only controls are where accessibility usually breaks, so
 * `accessibilityLabel` is a required prop here rather than an optional one —
 * there is no visible text to fall back on.
 *
 * `md` is exactly `minTarget`; `sm` is deliberately smaller for dense toolbars
 * and leans on Touchable's hit-slop expansion to stay at 44pt of tap area.
 */

import React, { useEffect, type ReactElement } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { useTheme, type Theme } from '@/theme';
import { ActivityDots } from './Button';
import { Icon, type IconName, type IconSize } from './Icon';
import { Surface } from './Surface';
import { Touchable, type PressScaleToken, type TouchableHaptic } from './Touchable';

/* -------------------------------------------------------------------- types */

export type IconButtonVariant = 'solid' | 'tonal' | 'ghost' | 'glass';
export type IconButtonTone = 'primary' | 'accent' | 'danger' | 'neutral';
export type IconButtonSize = 'sm' | 'md' | 'lg';

export type IconButtonProps = {
  icon: IconName;
  /** Required — there is no visible label to announce. */
  accessibilityLabel: string;
  onPress?: () => void;
  onLongPress?: () => void;
  variant?: IconButtonVariant;
  tone?: IconButtonTone;
  size?: IconButtonSize;
  /** `circle` for floating controls, `rounded` for controls in a toolbar row. */
  shape?: 'circle' | 'rounded';
  loading?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  /** Marks a toggle as on — drives `accessibilityState.selected`. */
  selected?: boolean;
  haptic?: TouchableHaptic;
  pressScale?: PressScaleToken | number;
  accessibilityHint?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  /** Pinned to the top-right corner — a `<Badge dot/>` or unread count. */
  overlay?: ReactElement;
};

type Skin = { background: string; ink: string; border: string | null; elevation: 0 | 1 };

/* ---------------------------------------------------------------- constants */

/**
 * Diameters are one `spacing.sm` step either side of the 44pt floor, so the
 * ladder can never drift away from the minimum target.
 */
const SIZE_STEP: Record<IconButtonSize, { step: -1 | 0 | 1; icon: IconSize }> = {
  sm: { step: -1, icon: 'sm' },
  md: { step: 0, icon: 'md' },
  lg: { step: 1, icon: 'lg' },
};

/* ------------------------------------------------------------------ helpers */

function toneColors(t: Theme, tone: IconButtonTone) {
  switch (tone) {
    case 'accent':
      return { fill: t.color.accent, onFill: t.color.onAccent, soft: t.color.accentSoft, onSoft: t.color.onAccentSoft, text: t.color.accentText };
    case 'danger':
      return { fill: t.color.danger, onFill: t.color.onDanger, soft: t.color.dangerSoft, onSoft: t.color.onDangerSoft, text: t.color.danger };
    case 'neutral':
      return { fill: t.color.surfaceAlt, onFill: t.color.text, soft: t.color.surfaceAlt, onSoft: t.color.text, text: t.color.textSecondary };
    case 'primary':
    default:
      return { fill: t.color.primary, onFill: t.color.onPrimary, soft: t.color.primarySoft, onSoft: t.color.onPrimarySoft, text: t.color.primaryText };
  }
}

function skinFor(t: Theme, variant: IconButtonVariant, tone: IconButtonTone): Skin {
  const c = toneColors(t, tone);
  switch (variant) {
    case 'solid':
      return { background: c.fill, ink: c.onFill, border: null, elevation: 1 };
    case 'tonal':
      return { background: c.soft, ink: c.onSoft, border: null, elevation: 0 };
    case 'glass':
      return { background: 'transparent', ink: c.text, border: t.color.chromeBorder, elevation: 0 };
    case 'ghost':
    default:
      return { background: 'transparent', ink: c.text, border: null, elevation: 0 };
  }
}

/* ---------------------------------------------------------------- component */

export function IconButton({
  icon,
  accessibilityLabel,
  onPress,
  onLongPress,
  variant = 'ghost',
  tone = 'primary',
  size = 'md',
  shape = 'circle',
  loading = false,
  disabled = false,
  disabledReason,
  selected,
  haptic = 'tap',
  pressScale = 'small',
  accessibilityHint,
  testID,
  style,
  overlay,
}: IconButtonProps) {
  const t = useTheme();
  const step = SIZE_STEP[size];
  const skin = skinFor(t, variant, tone);
  const diameter = t.minTarget + step.step * t.spacing.sm;
  const radius = shape === 'circle' ? t.radius.pill : t.radius.md;

  const busy = useSharedValue(loading ? 1 : 0);
  useEffect(() => {
    busy.value = withTiming(loading ? 1 : 0, t.motion.timing(t.motion.duration.fast, 'smooth'));
  }, [busy, loading, t.motion]);

  const iconStyle = useAnimatedStyle(() => ({ opacity: 1 - busy.value }));
  const dotsStyle = useAnimatedStyle(() => ({ opacity: busy.value }));

  const box: ViewStyle = { width: diameter, height: diameter, alignItems: 'center', justifyContent: 'center' };

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled, selected, busy: loading }}
      disabled={disabled}
      disabledReason={disabledReason}
      haptic={haptic}
      onPress={loading ? undefined : onPress}
      onLongPress={loading ? undefined : onLongPress}
      pressScale={pressScale}
      testID={testID}
      style={style}
    >
      <Surface
        variant={variant === 'glass' ? 'glass' : 'surface'}
        elevation={skin.elevation}
        radius={radius}
        padding="none"
        style={[
          box,
          // Glass draws its own fill; everything else paints over the Surface.
          variant === 'glass' ? null : { backgroundColor: skin.background },
          skin.border ? { borderWidth: t.borderWidth.hairline, borderColor: skin.border } : null,
        ]}
      >
        <Animated.View style={[StyleSheet.absoluteFill, styles.center, iconStyle]}>
          <Icon name={icon} size={step.icon} color={skin.ink} />
        </Animated.View>
        <Animated.View style={[StyleSheet.absoluteFill, styles.center, dotsStyle]} pointerEvents="none">
          <ActivityDots color={skin.ink} active={loading} />
        </Animated.View>
        {overlay ? (
          <View style={styles.overlay} pointerEvents="none">
            {overlay}
          </View>
        ) : null}
      </Surface>
    </Touchable>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  overlay: { position: 'absolute', top: 0, right: 0 },
});

export default IconButton;
