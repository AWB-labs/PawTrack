/**
 * Petal — Stepper.
 *
 * Built for portions and doses: "120 g", "1.5 tablets", "3 scoops". Two things
 * make it feel like a real control rather than two buttons and a number.
 *
 *   · **Press-and-hold accelerates.** Holding starts at one step per `slow`
 *     beat and ramps down toward `instant`, so nudging from 120 g to 400 g is
 *     one gesture instead of twenty-eight taps. Each tick gets a selection
 *     haptic, and hitting a bound gets a warning one — you feel the wall.
 *   · **The number rolls.** It slides out in the direction you pushed it and
 *     the new value slides in behind, so an increment is visibly an increment
 *     even when you aren't reading the digits.
 *
 * The whole control is `accessibilityRole="adjustable"`, which gives VoiceOver
 * and TalkBack the swipe-up/down gesture rather than making a screen-reader user
 * hunt two 44pt targets.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  FadeInDown,
  FadeInUp,
  FadeOutDown,
  FadeOutUp,
  LinearTransition,
} from 'react-native-reanimated';

import haptics from '@/lib/haptics';
import { useTheme } from '@/theme';
import { Icon } from './Icon';
import { Row } from './Stack';
import { Text } from './Text';
import { Touchable } from './Touchable';

/* -------------------------------------------------------------------- types */

export type StepperSize = 'sm' | 'md';

export type StepperProps = {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Decimal places. Defaults to whatever `step` implies (0.5 → 1, 1 → 0). */
  precision?: number;
  /** Rendered after the number in a quieter weight — "g", "ml", "tablets". */
  unit?: string;
  size?: StepperSize;
  disabled?: boolean;
  disabledReason?: string;
  /** Announced for the control as a whole — "Portion size". */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/** Each held repeat is this fraction of the last delay — a smooth ramp, not a jump. */
const ACCELERATION = 0.74;

/* ------------------------------------------------------------------ helpers */

function decimalsOf(step: number): number {
  if (Number.isInteger(step)) return 0;
  const text = String(step);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** Snap to the step grid and kill floating-point dust (0.1+0.2 lives here). */
function quantise(value: number, min: number, step: number, decimals: number): number {
  const steps = Math.round((value - min) / step);
  return Number((min + steps * step).toFixed(decimals + 2));
}

/* ---------------------------------------------------------------- component */

export function Stepper({
  value,
  onChange,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  precision,
  unit,
  size = 'md',
  disabled = false,
  disabledReason,
  accessibilityLabel,
  accessibilityHint,
  style,
  testID,
}: StepperProps) {
  const t = useTheme();
  const decimals = precision ?? decimalsOf(step);

  const [direction, setDirection] = useState<1 | -1>(1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef(value);
  live.current = value;

  const inert = disabled || disabledReason !== undefined;
  const atMin = value <= min;
  const atMax = value >= max;

  const stop = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => stop, [stop]);

  const apply = useCallback(
    (dir: 1 | -1) => {
      const next = quantise(live.current + dir * step, min, step, decimals);
      const clamped = Math.min(max, Math.max(min, next));
      if (clamped === live.current) {
        // The wall is information: say so once rather than silently no-oping.
        haptics.warn();
        stop();
        return false;
      }
      setDirection(dir);
      haptics.select();
      live.current = clamped;
      onChange(clamped);
      return true;
    },
    [decimals, max, min, onChange, step, stop],
  );

  const start = useCallback(
    (dir: 1 | -1) => {
      if (inert) return;
      if (!apply(dir)) return;

      let delay: number = t.motion.duration.slow;
      const floor = t.motion.duration.instant;
      const tick = () => {
        timer.current = setTimeout(() => {
          if (!apply(dir)) return;
          delay = Math.max(floor, delay * ACCELERATION);
          tick();
        }, delay);
      };
      tick();
    },
    [apply, inert, t.motion.duration.instant, t.motion.duration.slow],
  );

  const onAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (inert) return;
      if (event.nativeEvent.actionName === 'increment') apply(1);
      if (event.nativeEvent.actionName === 'decrement') apply(-1);
    },
    [apply, inert],
  );

  const display = useMemo(() => value.toFixed(decimals), [decimals, value]);
  const spoken = unit ? `${display} ${unit}` : display;

  // An unbounded max announced as 9,007,199,254,740,991 helps nobody.
  const a11yValue = useMemo(
    () =>
      max === Number.MAX_SAFE_INTEGER
        ? { min, now: value, text: spoken }
        : { min, max, now: value, text: spoken },
    [max, min, spoken, value],
  );

  const rowHeight = (t.type.metricSmall.lineHeight ?? t.spacing.xl) + t.spacing.xxs;
  const buttonSize = size === 'md' ? t.minTarget : t.minTarget - t.spacing.sm;

  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={disabledReason ?? accessibilityHint}
      accessibilityValue={a11yValue}
      accessibilityState={{ disabled }}
      accessibilityActions={ACTIONS}
      onAccessibilityAction={onAccessibilityAction}
      testID={testID}
      style={[
        styles.root,
        {
          padding: t.spacing.xxs,
          borderRadius: t.radius.pill,
          backgroundColor: t.color.surfaceAlt,
          borderWidth: t.borderWidth.hairline,
          borderColor: t.color.border,
          opacity: inert ? t.opacity.disabled : 1,
        },
        style,
      ]}
    >
      <StepButton
        icon="remove"
        label="Decrease"
        diameter={buttonSize}
        disabled={inert || atMin}
        onStart={() => start(-1)}
        onStop={stop}
      />

      <Animated.View
        layout={LinearTransition.duration(t.motion.duration.fast)}
        style={[styles.readout, { height: rowHeight, minWidth: t.spacing.xxxl, marginHorizontal: t.spacing.sm }]}
      >
        {/* The rolling number is absolutely positioned so the outgoing and
            incoming digits can overlap — which leaves nothing to size the box.
            This invisible twin is what gives it a width, and `layout` keeps the
            buttons from snapping when that width changes. */}
        <View style={styles.sizer} pointerEvents="none" importantForAccessibility="no-hide-descendants">
          <Row gap="xxs" align="baseline">
            <Text variant="metricSmall" tabular>
              {display}
            </Text>
            {unit ? <Text variant="subhead">{unit}</Text> : null}
          </Row>
        </View>

        <Animated.View
          key={display}
          entering={direction > 0 ? FadeInDown.duration(t.motion.duration.fast) : FadeInUp.duration(t.motion.duration.fast)}
          exiting={direction > 0 ? FadeOutUp.duration(t.motion.duration.fast) : FadeOutDown.duration(t.motion.duration.fast)}
          style={[StyleSheet.absoluteFill, styles.center]}
        >
          <Row gap="xxs" align="baseline">
            <Text variant="metricSmall" tabular color={inert ? 'textFaint' : 'text'}>
              {display}
            </Text>
            {unit ? (
              <Text variant="subhead" color={inert ? 'textFaint' : 'textTertiary'}>
                {unit}
              </Text>
            ) : null}
          </Row>
        </Animated.View>
      </Animated.View>

      <StepButton
        icon="add"
        label="Increase"
        diameter={buttonSize}
        disabled={inert || atMax}
        onStart={() => start(1)}
        onStop={stop}
      />
    </View>
  );
}

/**
 * A stepper button can't be an `IconButton`: it needs press-*in* and press-*out*
 * to drive the hold repeat, and `IconButton` only surfaces `onPress`.
 */
function StepButton({
  icon,
  label,
  diameter,
  disabled,
  onStart,
  onStop,
}: {
  icon: 'add' | 'remove';
  label: string;
  diameter: number;
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const t = useTheme();

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      // The repeat starts on press-in, so the tap haptic would double up with
      // the first selection tick.
      haptic="none"
      onPressIn={onStart}
      onPressOut={onStop}
      pressScale="small"
      // Announced by the `adjustable` parent; a screen reader shouldn't have to
      // walk into two buttons to change one number.
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.center,
        {
          width: diameter,
          height: diameter,
          borderRadius: t.radius.pill,
          backgroundColor: disabled ? 'transparent' : t.color.surface,
          opacity: disabled ? t.opacity.disabled : 1,
        },
      ]}
    >
      <Icon name={icon} size="md" color={disabled ? 'textFaint' : 'primaryText'} />
    </Touchable>
  );
}

const ACTIONS = [{ name: 'increment' as const }, { name: 'decrement' as const }];

const styles = StyleSheet.create({
  root: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' },
  readout: { alignItems: 'center', justifyContent: 'center' },
  sizer: { opacity: 0 },
  center: { alignItems: 'center', justifyContent: 'center' },
});

export default Stepper;
