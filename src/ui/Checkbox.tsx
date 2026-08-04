/**
 * Petal — Checkbox and RadioButton.
 *
 * The tick is *drawn*, not faded in: an SVG path whose dash offset animates
 * from "fully hidden" to "fully shown", so the stroke sweeps from the bottom-left
 * up to the top-right the way a pen would. It reads as an act rather than a
 * state flip, which is exactly what ticking a dose off should feel like.
 *
 * Around it: the box dips and springs back (a press you can see even when your
 * thumb is covering the box), the fill and border cross-fade together, and the
 * whole row is the target when a label is supplied.
 *
 * `indeterminate` is here because the caregiver permission editor needs a
 * group header that's honestly "some of these" — a half-ticked box is the only
 * control that says that without a sentence.
 */

import React, { useCallback, useEffect } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  interpolate,
  interpolateColor,
  ReduceMotion,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
  type WithSpringConfig,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

import haptics from '@/lib/haptics';
import { spring, useTheme, type Theme } from '@/theme';
import { Column, Row } from './Stack';
import { Text } from './Text';
import { Touchable } from './Touchable';

/* -------------------------------------------------------------------- types */

export type CheckboxSize = 'sm' | 'md';
export type CheckboxTone = 'primary' | 'accent';

export type CheckboxProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Renders half-ticked. `checked` is ignored while this is on. */
  indeterminate?: boolean;
  label?: string;
  description?: string;
  size?: CheckboxSize;
  tone?: CheckboxTone;
  /** Paints the box in the danger colour — for "you must accept this" rows. */
  invalid?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export type RadioButtonProps = Omit<CheckboxProps, 'checked' | 'onChange' | 'indeterminate'> & {
  selected: boolean;
  onSelect: () => void;
};

/* ---------------------------------------------------------------- constants */

const AnimatedPath = Animated.createAnimatedComponent(Path);

/** See `Touchable` — the theme's `springWith` helper doesn't type-check yet. */
const BOX_SPRING: WithSpringConfig = { ...spring.snappy, reduceMotion: ReduceMotion.System };

/**
 * The tick, drawn in a 24×24 box. `TICK_LENGTH` is the path's arc length rounded
 * up — the dash array only has to be *at least* as long as the stroke for the
 * draw-on to start fully hidden.
 */
const TICK_PATH = 'M6.5 12.4 L10.4 16.4 L17.6 8.2';
const TICK_LENGTH = 20;

const DASH_PATH = 'M6.5 12 L17.5 12';
const DASH_LENGTH = 12;

const VIEWBOX = 24;

/** The box dips this far before springing back — enough to see, too fast to notice. */
const DIP = 0.86;

/* ------------------------------------------------------------------ helpers */

function toneFill(t: Theme, tone: CheckboxTone, invalid: boolean) {
  if (invalid) return { fill: t.color.danger, ink: t.color.onDanger };
  return tone === 'accent'
    ? { fill: t.color.accent, ink: t.color.onAccent }
    : { fill: t.color.primary, ink: t.color.onPrimary };
}

function boxSize(t: Theme, size: CheckboxSize): number {
  return size === 'md' ? t.spacing.xl : t.spacing.lg;
}

/* --------------------------------------------------------------- checkbox */

export function Checkbox({
  checked,
  onChange,
  indeterminate = false,
  label,
  description,
  size = 'md',
  tone = 'primary',
  invalid = false,
  disabled = false,
  disabledReason,
  accessibilityLabel,
  accessibilityHint,
  style,
  testID,
}: CheckboxProps) {
  const t = useTheme();
  const box = boxSize(t, size);
  const { fill, ink } = toneFill(t, tone, invalid);

  const active = indeterminate || checked;
  const on = useSharedValue(active ? 1 : 0);
  const pop = useSharedValue(1);
  const first = React.useRef(true);

  useEffect(() => {
    on.value = withTiming(active ? 1 : 0, t.motion.timing(t.motion.duration.fast, 'smooth'));
    if (first.current) {
      first.current = false;
      return;
    }
    // The bounce belongs to the interaction, not to the mount.
    pop.value = withSequence(
      withTiming(DIP, t.motion.timing(t.motion.duration.instant, 'accelerate')),
      withSpring(1, BOX_SPRING),
    );
  }, [active, on, pop, t.motion]);

  const restFill = t.color.surface;
  const restBorder = invalid ? t.color.danger : t.color.borderStrong;

  const boxStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(on.value, [0, 1], [restFill, fill]),
    borderColor: interpolateColor(on.value, [0, 1], [restBorder, fill]),
    transform: [{ scale: pop.value }],
  }));

  const tickProps = useAnimatedProps(() => ({
    strokeDashoffset: interpolate(on.value, [0, 1], [TICK_LENGTH, 0]),
    opacity: indeterminate ? 0 : on.value,
  }));

  const dashProps = useAnimatedProps(() => ({
    strokeDashoffset: interpolate(on.value, [0, 1], [DASH_LENGTH, 0]),
    opacity: indeterminate ? on.value : 0,
  }));

  const inert = disabled || disabledReason !== undefined;

  const handlePress = useCallback(() => {
    if (inert) return;
    haptics.commit();
    onChange(indeterminate ? true : !checked);
  }, [checked, indeterminate, inert, onChange]);

  // The SVG lives inside the border, so it draws at the padding box's size and
  // the stroke is scaled back into viewBox units — otherwise a 20pt checkbox
  // gets a hairline tick and a 24pt one gets a marker pen.
  const inner = box - t.borderWidth.thick * 2;
  const stroke = (t.borderWidth.thick * VIEWBOX) / inner;

  const control = (
    <Animated.View
      style={[
        styles.center,
        {
          width: box,
          height: box,
          borderRadius: size === 'md' ? t.radius.sm : t.radius.xs,
          borderWidth: t.borderWidth.thick,
        },
        boxStyle,
      ]}
    >
      <Svg width={inner} height={inner} viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}>
        <AnimatedPath
          d={TICK_PATH}
          stroke={ink}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          strokeDasharray={TICK_LENGTH}
          animatedProps={tickProps}
        />
        <AnimatedPath
          d={DASH_PATH}
          stroke={ink}
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={DASH_LENGTH}
          animatedProps={dashProps}
        />
      </Svg>
    </Animated.View>
  );

  return (
    <Selectable
      role="checkbox"
      state={{ checked: indeterminate ? 'mixed' : checked, disabled }}
      label={label}
      description={description}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      disabled={disabled}
      disabledReason={disabledReason}
      inert={inert}
      onPress={handlePress}
      control={control}
      style={style}
      testID={testID}
    />
  );
}

/* ------------------------------------------------------------ radio button */

export function RadioButton({
  selected,
  onSelect,
  label,
  description,
  size = 'md',
  tone = 'primary',
  invalid = false,
  disabled = false,
  disabledReason,
  accessibilityLabel,
  accessibilityHint,
  style,
  testID,
}: RadioButtonProps) {
  const t = useTheme();
  const box = boxSize(t, size);
  const { fill } = toneFill(t, tone, invalid);

  const on = useSharedValue(selected ? 1 : 0);
  useEffect(() => {
    // A radio can only ever be turned *on* by the user, so the dot always
    // springs in and only ever fades out — asymmetry that matches the semantics.
    on.value = selected
      ? withSpring(1, BOX_SPRING)
      : withTiming(0, t.motion.timing(t.motion.duration.fast, 'accelerate'));
  }, [on, selected, t.motion]);

  const restBorder = invalid ? t.color.danger : t.color.borderStrong;
  const ringStyle = useAnimatedStyle(() => ({
    borderColor: interpolateColor(on.value, [0, 1], [restBorder, fill]),
  }));

  const dot = box - t.spacing.md;
  const dotStyle = useAnimatedStyle(() => ({
    transform: [{ scale: on.value }],
    opacity: on.value,
  }));

  const inert = disabled || disabledReason !== undefined;

  const handlePress = useCallback(() => {
    if (inert || selected) return;
    haptics.select();
    onSelect();
  }, [inert, onSelect, selected]);

  const control = (
    <Animated.View
      style={[
        styles.center,
        {
          width: box,
          height: box,
          borderRadius: t.radius.pill,
          borderWidth: t.borderWidth.thick,
          backgroundColor: t.color.surface,
        },
        ringStyle,
      ]}
    >
      <Animated.View
        style={[{ width: dot, height: dot, borderRadius: t.radius.pill, backgroundColor: fill }, dotStyle]}
      />
    </Animated.View>
  );

  return (
    <Selectable
      role="radio"
      state={{ checked: selected, selected, disabled }}
      label={label}
      description={description}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      disabled={disabled}
      disabledReason={disabledReason}
      inert={inert}
      onPress={handlePress}
      control={control}
      style={style}
      testID={testID}
    />
  );
}

/* ------------------------------------------------------------------ shared */

/** The row scaffolding both controls share — label placement, target, a11y. */
function Selectable({
  role,
  state,
  label,
  description,
  accessibilityLabel,
  accessibilityHint,
  disabled,
  disabledReason,
  inert,
  onPress,
  control,
  style,
  testID,
}: {
  role: 'checkbox' | 'radio';
  state: { checked: boolean | 'mixed'; selected?: boolean; disabled: boolean };
  label?: string;
  description?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  disabled: boolean;
  disabledReason?: string;
  inert: boolean;
  onPress: () => void;
  control: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const t = useTheme();

  return (
    <Touchable
      accessibilityRole={role}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={state}
      disabled={disabled}
      disabledReason={disabledReason}
      haptic="none"
      onPress={onPress}
      pressScale={label ? 'large' : 1}
      style={[
        label
          ? { alignSelf: 'stretch', minHeight: t.minTarget, justifyContent: 'center' }
          : styles.self,
        style,
      ]}
      testID={testID}
    >
      {label ? (
        <Row gap="md" align="start" style={{ paddingVertical: t.spacing.xs }}>
          {control}
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
        </Row>
      ) : (
        control
      )}
    </Touchable>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  self: { alignSelf: 'flex-start' },
});

export default Checkbox;
