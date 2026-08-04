/**
 * Petal — Button.
 *
 * Six variants, three sizes, and two behaviours worth calling out:
 *
 *   · **Loading never moves the layout.** The label stays mounted and fades
 *     out under an absolutely-positioned indicator, so a button that says
 *     "Log Buddy's dinner" doesn't collapse to a spinner's width mid-tap.
 *   · **`disabledReason` beats `disabled`** for anything RBAC-gated. The
 *     button looks off but still answers when tapped, which is how a caregiver
 *     learns what to ask the owner for. `disabled` is for states the user can
 *     fix themselves — an empty form, an unsaved draft.
 *
 * `hero` is the single most important call to action on a screen. It adds a
 * coloured glow; two on one screen and neither reads as primary any more.
 */

import React, { useEffect, type ReactElement } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { useTheme, type Theme, type TypeVariant } from '@/theme';
import { Icon, type IconName, type IconSize } from './Icon';
import type { RadiusToken, SpacingToken } from './Stack';
import { Text } from './Text';
import { Touchable, type TouchableHaptic } from './Touchable';

/* -------------------------------------------------------------------- types */

export type ButtonVariant = 'primary' | 'secondary' | 'tonal' | 'ghost' | 'danger' | 'accent';
export type ButtonSize = 'sm' | 'md' | 'lg';

export type ButtonProps = {
  label: string;
  onPress?: () => void;
  onLongPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** An Ionicons name, or your own element when an emoji or avatar fits better. */
  leftIcon?: IconName | ReactElement;
  rightIcon?: IconName | ReactElement;
  loading?: boolean;
  disabled?: boolean;
  /** Looks disabled, still tappable — `onPress` should explain why. */
  disabledReason?: string;
  fullWidth?: boolean;
  /** The one CTA on this screen. Adds a coloured glow to the solid variants. */
  hero?: boolean;
  haptic?: TouchableHaptic;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

type SizeSpec = {
  padY: SpacingToken;
  padX: SpacingToken;
  gap: SpacingToken;
  type: TypeVariant;
  radius: RadiusToken;
  icon: IconSize;
};

type VariantSpec = {
  background: string;
  ink: string;
  border: string | null;
  /** Solid variants carry a little lift and are the only ones `hero` glows. */
  solid: boolean;
};

/* ---------------------------------------------------------------- constants */

/**
 * Heights are never written down — they fall out of padding plus the variant's
 * line height, so a button grows correctly with dynamic type instead of
 * clipping. `sm` lands at ~34pt and relies on Touchable's hit-slop for the
 * remaining 44pt of tap area.
 */
const SIZES: Record<ButtonSize, SizeSpec> = {
  sm: { padY: 'sm', padX: 'base', gap: 'xs', type: 'buttonSmall', radius: 'md', icon: 'sm' },
  md: { padY: 'md', padX: 'lg', gap: 'sm', type: 'button', radius: 'lg', icon: 'md' },
  lg: { padY: 'base', padX: 'xl', gap: 'sm', type: 'button', radius: 'xl', icon: 'md' },
};

/** Phase offset per dot — small enough to read as one wave, not three blinks. */
const DOT_OFFSET = 0.18;

/* ------------------------------------------------------------------ helpers */

function variantSpec(t: Theme, variant: ButtonVariant): VariantSpec {
  switch (variant) {
    case 'primary':
      return { background: t.color.primary, ink: t.color.onPrimary, border: null, solid: true };
    case 'accent':
      return { background: t.color.accent, ink: t.color.onAccent, border: null, solid: true };
    case 'danger':
      return { background: t.color.danger, ink: t.color.onDanger, border: null, solid: true };
    case 'tonal':
      return {
        background: t.color.primarySoft,
        ink: t.color.onPrimarySoft,
        border: t.color.primarySoftBorder,
        solid: false,
      };
    case 'secondary':
      return { background: t.color.surface, ink: t.color.text, border: t.color.borderStrong, solid: false };
    case 'ghost':
    default:
      return { background: 'transparent', ink: t.color.primaryText, border: null, solid: false };
  }
}

/* --------------------------------------------------------------- components */

export function Button({
  label,
  onPress,
  onLongPress,
  variant = 'primary',
  size = 'md',
  leftIcon,
  rightIcon,
  loading = false,
  disabled = false,
  disabledReason,
  fullWidth = false,
  hero = false,
  haptic = 'tap',
  accessibilityLabel,
  accessibilityHint,
  testID,
  style,
}: ButtonProps) {
  const t = useTheme();
  const spec = SIZES[size];
  const skin = variantSpec(t, variant);

  const busy = useSharedValue(loading ? 1 : 0);
  useEffect(() => {
    busy.value = withTiming(loading ? 1 : 0, t.motion.timing(t.motion.duration.fast, 'smooth'));
  }, [busy, loading, t.motion]);

  const lift = t.spacing.xs;
  const labelStyle = useAnimatedStyle(() => ({
    opacity: 1 - busy.value,
    transform: [{ translateY: -busy.value * lift }],
  }));

  const indicatorStyle = useAnimatedStyle(() => ({
    opacity: busy.value,
    transform: [{ scale: 0.86 + busy.value * 0.14 }],
  }));

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled, busy: loading }}
      disabled={disabled}
      disabledReason={disabledReason}
      haptic={haptic}
      // A loading button keeps its press animation (it feels responsive) but
      // swallows the tap, so an impatient double-press can't double-submit.
      onPress={loading ? undefined : onPress}
      onLongPress={loading ? undefined : onLongPress}
      pressScale="medium"
      testID={testID}
      style={[
        // Elevation first — in dark mode it sets `backgroundColor: undefined`.
        t.elevation(skin.solid ? 1 : 0),
        hero && skin.solid ? t.glow(skin.background) : null,
        styles.root,
        {
          backgroundColor: skin.background,
          borderRadius: t.radius[spec.radius],
          paddingVertical: t.spacing[spec.padY],
          paddingHorizontal: t.spacing[spec.padX],
          borderWidth: skin.border ? t.borderWidth.hairline : 0,
          borderColor: skin.border ?? undefined,
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
        },
        style,
      ]}
    >
      <Animated.View style={[styles.content, { gap: t.spacing[spec.gap] }, labelStyle]}>
        {renderIcon(leftIcon, spec.icon, skin.ink)}
        <Text variant={spec.type} color={skin.ink} numberOfLines={1}>
          {label}
        </Text>
        {renderIcon(rightIcon, spec.icon, skin.ink)}
      </Animated.View>

      <Animated.View
        style={[StyleSheet.absoluteFill, styles.content, indicatorStyle]}
        pointerEvents="none"
        // The label already announces the action; `busy` announces the state.
        importantForAccessibility="no-hide-descendants"
      >
        <ActivityDots color={skin.ink} active={loading} />
      </Animated.View>
    </Touchable>
  );
}

function renderIcon(icon: IconName | ReactElement | undefined, size: IconSize, color: string) {
  if (icon === undefined) return null;
  return typeof icon === 'string' ? <Icon name={icon} size={size} color={color} /> : icon;
}

/**
 * Three breathing dots rather than a system spinner: it matches the app's
 * hand-made feel, costs one shared value, and degrades gracefully — under
 * reduce motion the loop simply never starts and the dots hold a staggered
 * resting state that still reads as "working".
 */
export function ActivityDots({ color, active = true }: { color: string; active?: boolean }) {
  const t = useTheme();
  const phase = useSharedValue(0);

  useEffect(() => {
    if (active) {
      phase.value = withRepeat(withTiming(1, t.motion.timing(t.motion.duration.shimmer, 'linear')), -1, false);
    } else {
      cancelAnimation(phase);
      phase.value = 0;
    }
    return () => cancelAnimation(phase);
  }, [active, phase, t.motion]);

  const dot = t.spacing.xs;
  return (
    <View style={[styles.content, { gap: t.spacing.xxs }]}>
      <Dot phase={phase} index={0} color={color} size={dot} />
      <Dot phase={phase} index={1} color={color} size={dot} />
      <Dot phase={phase} index={2} color={color} size={dot} />
    </View>
  );
}

function Dot({
  phase,
  index,
  color,
  size,
}: {
  phase: SharedValue<number>;
  index: number;
  color: string;
  size: number;
}) {
  const style = useAnimatedStyle(() => {
    const p = (phase.value + index * DOT_OFFSET) % 1;
    // Cosine keeps the loop seamless — no visible restart at the wrap point.
    const wave = 0.5 + 0.5 * Math.cos(2 * Math.PI * p);
    return { opacity: 0.28 + 0.72 * wave, transform: [{ scale: 0.68 + 0.32 * wave }] };
  });

  return (
    <Animated.View
      style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }, style]}
    />
  );
}

const styles = StyleSheet.create({
  root: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  content: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
});

export default Button;
