/**
 * Petal — SearchField.
 *
 * Three behaviours worth being deliberate about:
 *
 *   · **The cancel button slides in, it doesn't appear.** Its width is tweened
 *     from zero inside a clipping box, so the pill shrinks to make room instead
 *     of the row reflowing under the user's thumb mid-tap.
 *   · **Typing and searching are different events.** `onChangeText` fires per
 *     keystroke so the pill stays responsive; `onDebouncedChange` fires once
 *     the user pauses, and that's what a query should be wired to. Firing a
 *     network request per character is how search screens end up janky.
 *   · **Cancel means cancel.** It clears the text, blurs, and tells the parent
 *     — a cancel that only dismisses the keyboard leaves a filtered list behind
 *     and a user who can't work out why.
 */

import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  Keyboard,
  StyleSheet,
  TextInput,
  View,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type TargetedEvent,
  type ViewStyle,
} from 'react-native';
import Animated, {
  interpolate,
  interpolateColor,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  ZoomIn,
  ZoomOut,
  type WithSpringConfig,
} from 'react-native-reanimated';

import haptics from '@/lib/haptics';
import { spring, useTheme } from '@/theme';
import { ActivityDots } from './Button';
import { useFieldMetrics, type FieldSize } from './FormField';
import { Icon } from './Icon';
import { Text } from './Text';
import { Touchable } from './Touchable';

/* -------------------------------------------------------------------- types */

export type SearchFieldHandle = {
  focus: () => void;
  blur: () => void;
  clear: () => void;
};

export type SearchFieldProps = {
  value?: string;
  /** Fires on every keystroke. Use for the visible text, not for queries. */
  onChangeText?: (text: string) => void;
  /** Fires once typing settles. Wire your query here. */
  onDebouncedChange?: (text: string) => void;
  /** Defaults to the motion system's base duration. */
  debounceMs?: number;
  placeholder?: string;
  /** The cancel affordance. Off inside sheets, where the sheet is the exit. */
  showCancel?: boolean;
  cancelLabel?: string;
  onCancel?: () => void;
  onSubmit?: (text: string) => void;
  autoFocus?: boolean;
  /** Swaps the leading glyph for the working indicator. */
  loading?: boolean;
  disabled?: boolean;
  size?: FieldSize;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  ref?: React.Ref<SearchFieldHandle>;
};

/* ---------------------------------------------------------------- constants */

/** See `Touchable` — the theme's `springWith` helper doesn't type-check yet. */
const CANCEL_SPRING: WithSpringConfig = { ...spring.snappy, reduceMotion: ReduceMotion.System };

/* ---------------------------------------------------------------- component */

export function SearchField({
  value,
  onChangeText,
  onDebouncedChange,
  debounceMs,
  placeholder = 'Search',
  showCancel = true,
  cancelLabel = 'Cancel',
  onCancel,
  onSubmit,
  autoFocus = false,
  loading = false,
  disabled = false,
  size = 'md',
  accessibilityLabel,
  style,
  testID,
  ref,
}: SearchFieldProps) {
  const t = useTheme();
  const m = useFieldMetrics(size, false);
  const inputRef = useRef<TextInput>(null);

  const [focused, setFocused] = useState(false);
  const [innerValue, setInnerValue] = useState(value ?? '');
  const [cancelWidth, setCancelWidth] = useState(0);

  const text = value ?? innerValue;
  const open = showCancel && (focused || text.length > 0);

  const progress = useSharedValue(0);
  const focus = useSharedValue(0);

  useEffect(() => {
    progress.value = withSpring(open ? 1 : 0, CANCEL_SPRING);
  }, [open, progress]);

  useEffect(() => {
    focus.value = withTiming(focused ? 1 : 0, t.motion.timing(t.motion.duration.fast, 'smooth'));
  }, [focus, focused, t.motion]);

  /* ----- debounce -------------------------------------------------------- */

  const delay = debounceMs ?? t.motion.duration.base;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emit = useRef(onDebouncedChange);
  emit.current = onDebouncedChange;

  useEffect(() => {
    if (!emit.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => emit.current?.(text), delay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [delay, text]);

  /* ----- handlers -------------------------------------------------------- */

  const handleChange = useCallback(
    (next: string) => {
      if (value === undefined) setInnerValue(next);
      onChangeText?.(next);
    },
    [onChangeText, value],
  );

  const handleClear = useCallback(() => {
    haptics.tap();
    handleChange('');
    inputRef.current?.focus();
  }, [handleChange]);

  const handleCancel = useCallback(() => {
    handleChange('');
    inputRef.current?.blur();
    Keyboard.dismiss();
    onCancel?.();
  }, [handleChange, onCancel]);

  const handleFocus = useCallback((_event: NativeSyntheticEvent<TargetedEvent>) => setFocused(true), []);
  const handleBlur = useCallback((_event: NativeSyntheticEvent<TargetedEvent>) => setFocused(false), []);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => inputRef.current?.focus(),
      blur: () => inputRef.current?.blur(),
      clear: () => handleChange(''),
    }),
    [handleChange],
  );

  const measureCancel = useCallback((event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    setCancelWidth((prev) => (Math.abs(prev - width) < 1 ? prev : width));
  }, []);

  /* ----- styles ---------------------------------------------------------- */

  const restBorder = t.color.border;
  const focusBorder = t.color.focus;
  const pillStyle = useAnimatedStyle(() => ({
    borderColor: interpolateColor(focus.value, [0, 1], [restBorder, focusBorder]),
  }));

  const gap = t.spacing.sm;
  const cancelStyle = useAnimatedStyle(() => ({
    width: interpolate(progress.value, [0, 1], [0, cancelWidth + gap]),
    opacity: progress.value,
    transform: [{ translateX: interpolate(progress.value, [0, 1], [gap, 0]) }],
  }));

  const { maxFontSizeMultiplier, lineHeight, ...bodyType } = t.type.body;

  return (
    <View style={[styles.row, style]} testID={testID}>
      <Animated.View
        style={[
          styles.pill,
          {
            height: m.height,
            paddingHorizontal: m.padX,
            gap: m.gap,
            borderRadius: t.radius.pill,
            borderWidth: t.borderWidth.thin,
            backgroundColor: t.color.surfaceAlt,
            opacity: disabled ? t.opacity.muted : 1,
          },
          pillStyle,
        ]}
      >
        {loading ? (
          <View style={{ width: m.textBlock, alignItems: 'center' }}>
            <ActivityDots color={t.color.textTertiary} active />
          </View>
        ) : (
          <Icon name="search" size={m.iconSize} color={focused ? 'primaryText' : 'textTertiary'} />
        )}

        <TextInput
          ref={inputRef}
          value={text}
          onChangeText={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onSubmitEditing={() => onSubmit?.(text)}
          editable={!disabled}
          placeholder={placeholder}
          placeholderTextColor={t.color.textFaint}
          selectionColor={t.color.primary}
          cursorColor={t.color.primary}
          autoFocus={autoFocus}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          clearButtonMode="never"
          allowFontScaling
          maxFontSizeMultiplier={maxFontSizeMultiplier}
          accessibilityRole="search"
          accessibilityLabel={accessibilityLabel ?? placeholder}
          accessibilityState={{ disabled }}
          style={[bodyType, styles.input, { height: m.textBlock, color: t.color.text }]}
        />

        {text.length > 0 && !disabled ? (
          <Animated.View
            entering={ZoomIn.duration(t.motion.duration.fast)}
            exiting={ZoomOut.duration(t.motion.duration.fast)}
          >
            <Touchable
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              haptic="none"
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
                    backgroundColor: t.color.borderStrong,
                  },
                ]}
              >
                <Icon name="close" size="xs" color="textInverse" />
              </View>
            </Touchable>
          </Animated.View>
        ) : null}
      </Animated.View>

      {showCancel ? (
        <Animated.View style={[styles.cancelClip, cancelStyle]} pointerEvents={open ? 'auto' : 'none'}>
          <View style={{ paddingLeft: gap }}>
            <Touchable
              accessibilityRole="button"
              accessibilityLabel={cancelLabel}
              haptic="tap"
              onLayout={measureCancel}
              onPress={handleCancel}
              pressScale="small"
            >
              <Text variant="button" color="primaryText" numberOfLines={1}>
                {cancelLabel}
              </Text>
            </Touchable>
          </View>
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  pill: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  input: { flex: 1, padding: 0, margin: 0, includeFontPadding: false, textAlignVertical: 'center' },
  clear: { alignItems: 'center', justifyContent: 'center' },
  // Clipping is what turns the width tween into a slide rather than a squash.
  cancelClip: { overflow: 'hidden', flexDirection: 'row', alignItems: 'center' },
});

export default SearchField;
