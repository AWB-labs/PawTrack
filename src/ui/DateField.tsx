/**
 * Petal — DateField.
 *
 * The field half of `Calendar`. It wears the same frame as every other control
 * in a form, and opens the month grid in a centred dialog rather than a bottom
 * sheet: a calendar is a *chooser*, and choosers read better anchored in the
 * middle of the screen than crawling up from the bottom edge.
 *
 * Two behaviours differ by mode, deliberately:
 *
 *   · **Single** commits and closes the moment you tap a day — after one beat,
 *     so the selection disc is actually seen landing. Making someone tap "Done"
 *     after they've already answered the question is a tax.
 *   · **Range** stays open until both ends exist, because a half-picked window
 *     isn't an answer. The header reads back what's picked so far, and "Done"
 *     only lights up once it means something.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';

import { friendlyDate } from '@/lib/date';
import haptics from '@/lib/haptics';
import { useTheme } from '@/theme';
import type { DateOnly } from '@/data/types';
import { Button } from './Button';
import { Calendar, type CalendarMarks, type CalendarRange } from './Calendar';
import {
  FieldDialog,
  FieldFrame,
  FieldIcon,
  FieldMessage,
  useFieldMetrics,
  useFieldShake,
  type FieldSize,
  type FieldVariant,
} from './FormField';
import { Icon } from './Icon';
import { Row } from './Stack';
import { Text } from './Text';
import { Touchable } from './Touchable';

/* -------------------------------------------------------------------- types */

export type DateFieldProps = {
  mode?: 'single' | 'range';
  /** Single mode. */
  value?: DateOnly | null;
  onChange?: (date: DateOnly | null) => void;
  /** Range mode. */
  range?: CalendarRange;
  onRangeChange?: (range: CalendarRange) => void;

  label?: string;
  placeholder?: string;
  helper?: string;
  error?: string;
  /** Dialog heading. Falls back to the field label. */
  title?: string;

  minDate?: DateOnly;
  maxDate?: DateOnly;
  isDateDisabled?: (date: DateOnly) => boolean;
  marks?: CalendarMarks;
  firstDayOfWeek?: 0 | 1;

  variant?: FieldVariant;
  size?: FieldSize;
  required?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  clearable?: boolean;
  reserveMessageSpace?: boolean;

  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ------------------------------------------------------------------ helpers */

function describe(value: DateOnly | null | undefined): string | null {
  return value ? friendlyDate(value) : null;
}

function describeRange(range: CalendarRange | undefined): string | null {
  if (!range?.start) return null;
  if (!range.end) return `${friendlyDate(range.start)} — pick an end date`;
  return `${friendlyDate(range.start)} → ${friendlyDate(range.end)}`;
}

/* ---------------------------------------------------------------- component */

export function DateField({
  mode = 'single',
  value = null,
  onChange,
  range,
  onRangeChange,
  label,
  placeholder = 'Pick a date',
  helper,
  error,
  title,
  minDate,
  maxDate,
  isDateDisabled,
  marks,
  firstDayOfWeek = 1,
  variant = 'outlined',
  size = 'md',
  required = false,
  disabled = false,
  disabledReason,
  clearable = false,
  reserveMessageSpace = false,
  style,
  testID,
}: DateFieldProps) {
  const t = useTheme();
  const m = useFieldMetrics(size, !!label);
  const { shakeStyle, shake } = useFieldShake();

  const [open, setOpen] = useState(false);
  /** Range edits stay local until "Done" — a half-window shouldn't reach the form. */
  const [draft, setDraft] = useState<CalendarRange>({ start: null, end: null });

  const display = useMemo(
    () => (mode === 'range' ? describeRange(range) : describe(value)),
    [mode, range, value],
  );

  const inert = disabled || disabledReason !== undefined;
  const hasValue = display !== null;

  const handleOpen = useCallback(() => {
    if (disabledReason) {
      shake();
      return;
    }
    haptics.tap();
    setDraft(range ?? { start: null, end: null });
    setOpen(true);
  }, [disabledReason, range, shake]);

  const handleSingle = useCallback(
    (next: DateOnly) => {
      onChange?.(next);
      // One beat so the disc is seen landing before the dialog leaves.
      setTimeout(() => setOpen(false), t.motion.duration.base);
    },
    [onChange, t.motion.duration.base],
  );

  const handleConfirmRange = useCallback(() => {
    haptics.commit();
    onRangeChange?.(draft);
    setOpen(false);
  }, [draft, onRangeChange]);

  const handleClear = useCallback(() => {
    haptics.tap();
    if (mode === 'range') onRangeChange?.({ start: null, end: null });
    else onChange?.(null);
  }, [mode, onChange, onRangeChange]);

  const dialogSubtitle = mode === 'range' ? (describeRange(draft) ?? 'Pick the first day') : undefined;

  return (
    <Animated.View style={[shakeStyle, style]}>
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={label ? `${label}. ${display ?? placeholder}` : (display ?? placeholder)}
        accessibilityHint={helper}
        accessibilityState={{ disabled, expanded: open }}
        disabled={disabled}
        disabledReason={disabledReason}
        haptic="none"
        onPress={handleOpen}
        pressScale="subtle"
        testID={testID}
      >
        <FieldFrame
          label={label}
          // Matches Input/TextArea's rule: the value slot always shows *some*
          // text here (the picked date, or `placeholder` — which defaults to
          // 'Pick a date' and is never empty), so the label has to float clear
          // of it whenever a placeholder exists, not only once a value is set.
          // Missing `!!placeholder` left the label sitting in its resting
          // position directly on top of the placeholder text.
          floated={hasValue || open || !!placeholder}
          focused={open}
          invalid={!!error}
          disabled={inert}
          required={required}
          variant={variant}
          size={size}
          leading={
            <FieldIcon name="calendar-outline" size={m.iconSize} active={open} invalid={!!error} disabled={inert} />
          }
          trailing={
            clearable && hasValue && !inert ? (
              <Touchable
                accessibilityRole="button"
                accessibilityLabel={label ? `Clear ${label.toLowerCase()}` : 'Clear date'}
                haptic="none"
                onPress={handleClear}
                pressScale="small"
              >
                <View
                  style={{
                    width: m.textBlock,
                    height: m.textBlock,
                    borderRadius: m.textBlock / 2,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: t.color.surfaceAlt,
                  }}
                >
                  <Icon name="close" size="xs" color="textSecondary" />
                </View>
              </Touchable>
            ) : (
              <Icon name="chevron-down" size={m.iconSize} color={inert ? 'textFaint' : 'textTertiary'} />
            )
          }
        >
          <Text
            variant="body"
            color={inert ? 'textFaint' : hasValue ? 'text' : 'textFaint'}
            numberOfLines={1}
            style={{ height: m.textBlock }}
          >
            {display ?? placeholder}
          </Text>
        </FieldFrame>
      </Touchable>

      <FieldMessage helper={helper} error={error} reserve={reserveMessageSpace} />

      <FieldDialog
        visible={open}
        onRequestClose={() => setOpen(false)}
        title={title ?? label ?? (mode === 'range' ? 'Pick dates' : 'Pick a date')}
        subtitle={dialogSubtitle}
      >
        <Calendar
          mode={mode}
          value={value}
          onChange={handleSingle}
          range={mode === 'range' ? draft : undefined}
          onRangeChange={setDraft}
          minDate={minDate}
          maxDate={maxDate}
          isDateDisabled={isDateDisabled}
          marks={marks}
          firstDayOfWeek={firstDayOfWeek}
        />

        {mode === 'range' ? (
          <Row gap="md" style={{ paddingTop: t.spacing.base }}>
            <Button
              label="Clear"
              variant="ghost"
              onPress={() => setDraft({ start: null, end: null })}
              disabled={!draft.start}
            />
            <View style={{ flex: 1 }} />
            {/* `disabled`, not `disabledReason`: an unfinished window is
                something the user can fix in one more tap, and the dialog
                subtitle already says which tap. */}
            <Button
              label="Done"
              variant="primary"
              onPress={handleConfirmRange}
              disabled={!draft.start || !draft.end}
            />
          </Row>
        ) : null}
      </FieldDialog>
    </Animated.View>
  );
}

export default DateField;
