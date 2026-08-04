/**
 * Petal — TextArea.
 *
 * `Input`'s multiline sibling. The only genuinely hard part of a multiline
 * field is the growth: a box that jumps a whole line the instant you wrap looks
 * broken, and one that grows without a ceiling pushes the save button off the
 * screen. So the height is a shared value tweened between the measured content
 * height and a `maxRows` clamp — it eases open, and once it hits the ceiling the
 * field scrolls internally instead of eating the page.
 *
 * Used for vet-visit write-ups, care notes and community posts, which is why the
 * counter is first-class here rather than opt-in: those all have real limits.
 */

import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  StyleSheet,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type StyleProp,
  type TargetedEvent,
  type TextInputContentSizeChangeEventData,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { useTheme } from '@/theme';
import {
  FieldCounter,
  FieldFrame,
  FieldMessage,
  useFieldMetrics,
  useFieldShake,
  type FieldSize,
  type FieldVariant,
} from './FormField';
import { Row } from './Stack';

/* -------------------------------------------------------------------- types */

export type TextAreaHandle = {
  focus: () => void;
  blur: () => void;
  clear: () => void;
  shake: () => void;
  isFocused: () => boolean;
};

export type TextAreaProps = Omit<
  TextInputProps,
  'style' | 'editable' | 'placeholderTextColor' | 'selectionColor' | 'multiline' | 'onChange'
> & {
  label?: string;
  helper?: string;
  error?: string;
  variant?: FieldVariant;
  size?: FieldSize;
  /** Resting height, in lines. */
  minRows?: number;
  /** Ceiling before the field scrolls its own content. */
  maxRows?: number;
  showCounter?: boolean;
  required?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  reserveMessageSpace?: boolean;
  style?: StyleProp<ViewStyle>;
  ref?: React.Ref<TextAreaHandle>;
};

/* ---------------------------------------------------------------- component */

export function TextArea({
  label,
  helper,
  error,
  variant = 'outlined',
  size = 'md',
  minRows = 3,
  maxRows = 8,
  showCounter,
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
  accessibilityLabel,
  accessibilityHint,
  testID,
  ...rest
}: TextAreaProps) {
  const t = useTheme();
  const m = useFieldMetrics(size, !!label);
  const inputRef = useRef<TextInput>(null);
  const { shakeStyle, shake } = useFieldShake();

  const [focused, setFocused] = useState(false);
  const [innerValue, setInnerValue] = useState(defaultValue ?? '');

  const text = value ?? innerValue;
  const inert = disabled || disabledReason !== undefined;

  const minHeight = m.textBlock * Math.max(1, minRows);
  const maxHeight = m.textBlock * Math.max(minRows, maxRows);

  const height = useSharedValue(minHeight);
  const [scrolls, setScrolls] = useState(false);

  const previousError = useRef(error);
  useEffect(() => {
    if (error && error !== previousError.current) shake();
    previousError.current = error;
  }, [error, shake]);

  const handleChange = useCallback(
    (next: string) => {
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

  const handleContentSize = useCallback(
    (event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => {
      const measured = event.nativeEvent.contentSize.height;
      // Quantised to whole lines before anything else. `onContentSizeChange`
      // fires with a slightly different raw pixel height on nearly every
      // keystroke — not just at a real line wrap — from cursor-position and
      // sub-pixel font-metric noise. Comparing raw pixels against a 1px
      // threshold let each of those near-misses slip through and restart the
      // timing animation from wherever the last one had gotten to, which is
      // what read as the box continuously "melting" downward while typing
      // rather than snapping once per genuine new line. Rounding to whole
      // lines first means every measurement for the *same* line count
      // collapses to the exact same target, so the animation only fires when
      // the line count actually changes.
      const lines = Math.round(measured / m.textBlock);
      const quantised = lines * m.textBlock;
      const next = Math.min(maxHeight, Math.max(minHeight, quantised));
      if (Math.abs(height.value - next) < 1) return;
      height.value = withTiming(next, t.motion.timing(t.motion.duration.fast, 'decelerate'));
      setScrolls(measured > maxHeight);
    },
    [height, m.textBlock, maxHeight, minHeight, t.motion],
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

  const heightStyle = useAnimatedStyle(() => ({ height: height.value }));

  const floated = focused || text.length > 0 || !!placeholder;
  const counterOn = showCounter ?? maxLength !== undefined;

  const { maxFontSizeMultiplier, ...bodyType } = t.type.body;

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
        grow
        testID={testID}
      >
        {/* The animated height lives on a wrapper rather than the input itself:
            a growing box is a layout change, and layout changes belong to a
            View, not to something that also owns a text cursor. */}
        <Animated.View style={heightStyle}>
          <TextInput
            ref={inputRef}
            multiline
            value={text}
            onChangeText={handleChange}
            onContentSizeChange={handleContentSize}
            onFocus={handleFocus}
            onBlur={handleBlur}
            editable={!inert}
            placeholder={placeholder}
            placeholderTextColor={t.color.textFaint}
            selectionColor={t.color.primary}
            cursorColor={t.color.primary}
            maxLength={maxLength}
            scrollEnabled={scrolls}
            allowFontScaling
            maxFontSizeMultiplier={maxFontSizeMultiplier}
            textAlignVertical="top"
            accessibilityLabel={accessibilityLabel ?? label ?? placeholder}
            accessibilityHint={disabledReason ?? accessibilityHint ?? helper}
            accessibilityState={{ disabled: inert }}
            style={[bodyType, styles.input, styles.flex, { color: inert ? t.color.textTertiary : t.color.text }]}
            {...rest}
          />
        </Animated.View>
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
  input: { padding: 0, margin: 0, includeFontPadding: false, textAlignVertical: 'top' },
});

export default TextArea;
