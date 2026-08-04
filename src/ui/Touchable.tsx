/**
 * Petal — Touchable.
 *
 * Every tappable thing in the app is built on this (contract rule 3). It buys
 * four guarantees that are easy to forget one screen at a time:
 *
 *   1. **A press you can feel.** Spring in on `pressIn`, spring out on
 *      `pressOut`, both interruptible — a spring picks up from wherever the
 *      last one got to, so a fast double-tap never snaps.
 *   2. **A 44pt target, always.** The child is measured and `hitSlop` grows to
 *      cover the shortfall, so a 20pt close icon is still a 44pt tap.
 *   3. **Haptics by intent** — `tap` for navigation, `select` for a choice,
 *      `commit` for a real state change.
 *   4. **The RBAC affordance.** `disabledReason` renders the control disabled
 *      but keeps it pressable, which is how a caregiver finds out *why* they
 *      can't do something instead of staring at a grey button.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  type GestureResponderEvent,
  type Insets,
  type LayoutChangeEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type WithSpringConfig,
} from 'react-native-reanimated';

import haptics from '@/lib/haptics';
import { spring, useTheme, type Theme } from '@/theme';

/* -------------------------------------------------------------------- types */

export type TouchableHaptic = 'tap' | 'select' | 'commit' | 'none';
export type PressScaleToken = keyof Theme['motion']['pressScale'];

export type TouchableProps = Omit<PressableProps, 'style' | 'children' | 'hitSlop' | 'disabled'> & {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Named press scale (`small` for icons … `subtle` for hero surfaces) or a raw factor. */
  pressScale?: PressScaleToken | number;
  /** Feedback on press-in. Long-press always adds a heavier thud. */
  haptic?: TouchableHaptic;
  /** Fade slightly while held. For rows whose background doesn't change. */
  dim?: boolean;
  disabled?: boolean;
  /**
   * Looks disabled, still fires `onPress`. Wire `onPress` to `explain()` so the
   * tap teaches the caregiver what to ask the owner for.
   */
  disabledReason?: string;
  /** Overrides the automatic 44pt expansion when a design needs a tighter zone. */
  hitSlop?: Insets | number;
};

/* ---------------------------------------------------------------- constants */

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * `motion.springWith()` currently infers a union TypeScript won't hand to
 * `withSpring`, so the preset is spread here. Same physics, same system
 * reduce-motion opt-in — swap back once the theme helper is retyped.
 */
const PRESS_SPRING: WithSpringConfig = { ...spring.press, reduceMotion: ReduceMotion.System };

const HAPTIC: Record<Exclude<TouchableHaptic, 'none'>, () => void> = {
  tap: haptics.tap,
  select: haptics.select,
  commit: haptics.commit,
};

/* ---------------------------------------------------------------- component */

export function Touchable({
  children,
  style,
  pressScale = 'medium',
  haptic = 'tap',
  dim = false,
  disabled = false,
  disabledReason,
  hitSlop,
  onPressIn,
  onPressOut,
  onLongPress,
  onLayout,
  accessibilityRole,
  accessibilityState,
  accessibilityHint,
  ...rest
}: TouchableProps) {
  const t = useTheme();
  const pressed = useSharedValue(0);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  const target = typeof pressScale === 'number' ? pressScale : t.motion.pressScale[pressScale];
  /** Blocked either outright or by a permission we can explain. */
  const inert = disabled || disabledReason !== undefined;

  const inertness = useSharedValue(inert ? 1 : 0);
  useEffect(() => {
    // Permissions resolve a beat after mount; fading avoids a hard flicker.
    inertness.value = withTiming(inert ? 1 : 0, t.motion.timing(t.motion.duration.fast, 'smooth'));
  }, [inert, inertness, t.motion]);

  const dimmed = t.opacity.pressed;
  const off = t.opacity.disabled;
  const animatedStyle = useAnimatedStyle(() => {
    const held = dim ? 1 - pressed.value * (1 - dimmed) : 1;
    return {
      transform: [{ scale: 1 - pressed.value * (1 - target) }],
      opacity: held * (1 - inertness.value * (1 - off)),
    };
  });

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      setSize((prev) =>
        prev && Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1
          ? prev
          : { width, height },
      );
      onLayout?.(event);
    },
    [onLayout],
  );

  const expandedHitSlop = useMemo<Insets | number | undefined>(() => {
    if (hitSlop !== undefined) return hitSlop;
    if (!size) return undefined;
    const dx = Math.max(0, (t.minTarget - size.width) / 2);
    const dy = Math.max(0, (t.minTarget - size.height) / 2);
    if (dx === 0 && dy === 0) return undefined;
    return { top: dy, bottom: dy, left: dx, right: dx };
  }, [hitSlop, size, t.minTarget]);

  const handlePressIn = useCallback(
    (event: GestureResponderEvent) => {
      pressed.value = withSpring(1, PRESS_SPRING);
      if (haptic !== 'none' && !disabled) HAPTIC[haptic]();
      onPressIn?.(event);
    },
    [disabled, haptic, onPressIn, pressed],
  );

  const handlePressOut = useCallback(
    (event: GestureResponderEvent) => {
      pressed.value = withSpring(0, PRESS_SPRING);
      onPressOut?.(event);
    },
    [onPressOut, pressed],
  );

  const handleLongPress = useCallback(
    (event: GestureResponderEvent) => {
      if (haptic !== 'none') haptics.heavy();
      onLongPress?.(event);
    },
    [haptic, onLongPress],
  );

  // A reason must reach VoiceOver too, otherwise the control is simply mute.
  const hint =
    disabledReason === undefined
      ? accessibilityHint
      : accessibilityHint
        ? `${disabledReason} ${accessibilityHint}`
        : disabledReason;

  return (
    <AnimatedPressable
      accessible
      accessibilityRole={accessibilityRole ?? 'button'}
      // Explicitly *not* disabled when we only have a reason — a control
      // announced as disabled can't be activated, and then it can't explain.
      accessibilityState={{ disabled, ...accessibilityState }}
      accessibilityHint={hint}
      disabled={disabled}
      hitSlop={expandedHitSlop}
      onLayout={handleLayout}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onLongPress={onLongPress ? handleLongPress : undefined}
      style={[style, animatedStyle]}
      {...rest}
    >
      {children}
    </AnimatedPressable>
  );
}

export default Touchable;
