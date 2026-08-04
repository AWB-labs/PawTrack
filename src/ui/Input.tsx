/**
 * Petal — Input.
 *
 * The field the rest of the form is measured against. Everything structural
 * (frame, floating label, focus ring, message row) comes from `FormField`'s
 * kit, so what lives here is only what a *text* field adds:
 *
 *   · **A clear button that earns its place.** It zooms in when there's
 *     something to clear and out when there isn't, so it never sits there as
 *     dead chrome next to an empty box.
 *   · **A reveal toggle that says which state it's in.** The icon flips and the
 *     accessibility label flips with it — "Show password" / "Hide password" —
 *     because an eye glyph alone is genuinely ambiguous.
 *   · **A shake when an error arrives.** Colour alone is a weak signal and
 *     fails for a third of colour-blind users; the shake plus the error haptic
 *     land the message without relying on red.
 *
 * The imperative handle exists for one reason: a form that validates on submit
 * needs to focus *and* shake the first bad field. Everything else is props.
 */

import React, { useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import {
  StyleSheet,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type StyleProp,
  type TargetedEvent,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import Animated, { ZoomIn, ZoomOut } from 'react-native-reanimated';

import { useTheme } from '@/theme';
import {
  FieldCounter,
  FieldFrame,
  FieldIcon,
  FieldMessage,
  useFieldMetrics,
  useFieldShake,
  type FieldSize,
  type FieldVariant,
} from './FormField';
import { Icon, type IconName } from './Icon';
import { Row } from './Stack';
import { Touchable } from './Touchable';

/* -------------------------------------------------------------------- types */

export type InputHandle = {
  focus: () => void;
  blur: () => void;
  clear: () => void;
  /** Nudge the field to say "not this". Pairs with `focus()` on submit-invalid. */
  shake: () => void;
  isFocused: () => boolean;
};

export type InputProps = Omit<
  TextInputProps,
  'style' | 'editable' | 'placeholderTextColor' | 'selectionColor' | 'onChange'
> & {
  label?: string;
  helper?: string;
  /** Presence flips the field to its invalid skin and triggers the shake. */
  error?: string;
  variant?: FieldVariant;
  size?: FieldSize;

  leadingIcon?: IconName;
  /** Anything richer than an icon — a currency symbol, a species emoji, an avatar. */
  leading?: ReactNode;
  trailingIcon?: IconName;
  onTrailingPress?: () => void;
  trailingAccessibilityLabel?: string;
  trailing?: ReactNode;

  /** Adds the ⨯ control once there's something to clear. */
  clearable?: boolean;
  onClear?: () => void;
  /** Defaults on whenever `maxLength` is set. */
  showCounter?: boolean;
  /** Adds the show/hide control to a `secureTextEntry` field. */
  showRevealToggle?: boolean;

  required?: boolean;
  disabled?: boolean;
  /** Looks disabled, still explains itself when tapped. */
  disabledReason?: string;
  /** Hold the message row open so a validating form doesn't reflow. */
  reserveMessageSpace?: boolean;

  style?: StyleProp<ViewStyle>;
  ref?: React.Ref<InputHandle>;
};

/* ---------------------------------------------------------------- component */

export function Input({
  label,
  helper,
  error,
  variant = 'outlined',
  size = 'md',
  leadingIcon,
  leading,
  trailingIcon,
  onTrailingPress,
  trailingAccessibilityLabel,
  trailing,
  clearable = false,
  onClear,
  showCounter,
  showRevealToggle = true,
  required = false,
  disabled = false,
  disabledReason,
  reserveMessageSpace = false,
  style,
  ref,

  value,
  defaultValue,
  onChangeText,
  onFocus,
  onBlur,
  placeholder,
  maxLength,
  secureTextEntry = false,
  accessibilityLabel,
  accessibilityHint,
  testID,
  ...rest
}: InputProps) {
  const t = useTheme();
  const m = useFieldMetrics(size, !!label);
  const inputRef = useRef<TextInput>(null);
  const { shakeStyle, shake } = useFieldShake();

  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [innerValue, setInnerValue] = useState(defaultValue ?? '');

  const text = value ?? innerValue;
  const inert = disabled || disabledReason !== undefined;

  // A new error is a rejection, not a state change — say so physically.
  const previousError = useRef(error);
  useEffect(() => {
    if (error && error !== previousError.current) shake();
    previousError.current = error;
  }, [error, shake]);

  const handleChange = useCallback(
    (next: string) => {
      // Uncontrolled fields keep their own copy; controlled ones are told and
      // wait to be told back, which is the only way `maxLength` stays honest.
      if (value === undefined) setInnerValue(next);
      onChangeText?.(next);
    },
    [onChangeText, value],
  );

  useImperativeHandle(
    ref,
    () => ({
      focus: () => inputRef.current?.focus(),
      blur: () => inputRef.current?.blur(),
      clear: () => handleChange(''),
      shake,
      isFocused: () => inputRef.current?.isFocused() ?? false,
    }),
    [handleChange, shake],
  );

  const handleFocus = useCallback(
    (event: NativeSyntheticEvent<TargetedEvent>) => {
      setFocused(true);
      onFocus?.(event);
    },
    [onFocus],
  );

  const handleBlur = useCallback(
    (event: NativeSyntheticEvent<TargetedEvent>) => {
      setFocused(false);
      onBlur?.(event);
    },
    [onBlur],
  );

  const handleClear = useCallback(() => {
    handleChange('');
    onClear?.();
    inputRef.current?.focus();
  }, [handleChange, onClear]);

  // A placeholder can't be read while the label is still sitting on top of it.
  const floated = focused || text.length > 0 || !!placeholder;
  const counterOn = showCounter ?? maxLength !== undefined;
  const secure = secureTextEntry && !revealed;

  const { maxFontSizeMultiplier, lineHeight, ...bodyType } = t.type.body;

  const leadingNode =
    leading ??
    (leadingIcon ? (
      <FieldIcon name={leadingIcon} size={m.iconSize} active={focused} invalid={!!error} disabled={inert} />
    ) : undefined);

  const showClear = clearable && text.length > 0 && !inert;
  const showReveal = secureTextEntry && showRevealToggle && !inert;

  const trailingNode =
    trailing ??
    (showClear || showReveal || trailingIcon ? (
      <Row gap="xs">
        {showClear ? (
          <Animated.View entering={ZoomIn.duration(t.motion.duration.fast)} exiting={ZoomOut.duration(t.motion.duration.fast)}>
            <Touchable
              accessibilityRole="button"
              accessibilityLabel={label ? `Clear ${label.toLowerCase()}` : 'Clear text'}
              haptic="tap"
              onPress={handleClear}
              pressScale="small"
            >
              <View
                style={[
                  styles.clear,
                  {
                    width: m.textBlock,
                    height: m.textBlock,
                    borderRadius: m.textBlock / 2,
                    backgroundColor: t.color.surfaceAlt,
                  },
                ]}
              >
                <Icon name="close" size="xs" color="textSecondary" />
              </View>
            </Touchable>
          </Animated.View>
        ) : null}

        {showReveal ? (
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={revealed ? 'Hide password' : 'Show password'}
            accessibilityState={{ selected: revealed }}
            haptic="tap"
            onPress={() => setRevealed((prev) => !prev)}
            pressScale="small"
          >
            <Icon
              name={revealed ? 'eye-off-outline' : 'eye-outline'}
              size={m.iconSize}
              color={revealed ? 'primaryText' : 'textTertiary'}
            />
          </Touchable>
        ) : null}

        {trailingIcon ? (
          onTrailingPress ? (
            <Touchable
              accessibilityRole="button"
              accessibilityLabel={trailingAccessibilityLabel ?? 'Field action'}
              haptic="tap"
              onPress={onTrailingPress}
              pressScale="small"
            >
              <Icon name={trailingIcon} size={m.iconSize} color="textTertiary" />
            </Touchable>
          ) : (
            <Icon name={trailingIcon} size={m.iconSize} color="textTertiary" />
          )
        ) : null}
      </Row>
    ) : undefined);

  return (
    <Animated.View style={[shakeStyle, style]}>
      <FieldFrame
        label={label}
        floated={floated}
        focused={focused}
        invalid={!!error}
        disabled={inert}
        required={required}
        variant={variant}
        size={size}
        leading={leadingNode}
        trailing={trailingNode}
        testID={testID}
      >
        <TextInput
          ref={inputRef}
          value={text}
          onChangeText={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          editable={!inert}
          placeholder={placeholder}
          placeholderTextColor={t.color.textFaint}
          selectionColor={t.color.primary}
          cursorColor={t.color.primary}
          maxLength={maxLength}
          secureTextEntry={secure}
          allowFontScaling
          maxFontSizeMultiplier={maxFontSizeMultiplier}
          accessibilityLabel={accessibilityLabel ?? label ?? placeholder}
          accessibilityHint={disabledReason ?? accessibilityHint ?? helper}
          accessibilityState={{ disabled: inert }}
          style={[
            bodyType,
            styles.input,
            { height: m.textBlock, color: inert ? t.color.textTertiary : t.color.text },
          ]}
          {...rest}
        />
      </FieldFrame>

      <Row align="start" gap="md">
        <View style={styles.flex}>
          <FieldMessage helper={helper} error={error} reserve={reserveMessageSpace} />
        </View>
        {counterOn && maxLength !== undefined ? (
          <FieldCounter length={text.length} max={maxLength} active={focused} />
        ) : null}
      </Row>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // Zeroing the platform padding is what lets the frame's own metrics decide
  // where the baseline sits — otherwise Android adds ~8pt no one asked for.
  input: { padding: 0, margin: 0, includeFontPadding: false, textAlignVertical: 'center' },
  clear: { alignItems: 'center', justifyContent: 'center' },
});

export default Input;
