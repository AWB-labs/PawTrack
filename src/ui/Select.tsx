/**
 * Petal — Select.
 *
 * A field that opens a themed picker sheet. It wears the same frame as `Input`
 * so a form of mixed controls reads as one form, and everything below the
 * trigger is its own self-contained modal — deliberately not built on
 * `ui/Sheet`, because a select frequently has to open from inside another
 * sheet, and nested portals are exactly where a shared sheet host gives up.
 *
 * Choices worth naming:
 *
 *   · **Search appears when the list stops being scannable**, not when a prop
 *     says so. Past ~8 options a human scans instead of reads, and that's the
 *     moment a filter earns its keyboard.
 *   · **The check is drawn, not toggled.** It zooms in on the new row while the
 *     old one zooms out, so the eye follows the selection across the list
 *     instead of hunting for where it went.
 *   · **Descriptions are first-class.** Half the selects in this app are
 *     choosing a medicine form or a caregiver preset, where the second line is
 *     the part that actually makes the decision.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, useWindowDimensions, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  FadeIn,
  interpolate,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  ZoomIn,
  ZoomOut,
  type WithSpringConfig,
} from 'react-native-reanimated';

import haptics from '@/lib/haptics';
import { spring, useTheme } from '@/theme';
import {
  FieldFrame,
  FieldIcon,
  FieldMessage,
  FieldSheet,
  useFieldMetrics,
  useFieldShake,
  type FieldSize,
  type FieldVariant,
} from './FormField';
import { Icon, type IconName } from './Icon';
import { SearchField } from './SearchField';
import { Column, Row } from './Stack';
import { Text } from './Text';
import { Touchable } from './Touchable';

/* -------------------------------------------------------------------- types */

export type SelectValue = string | number;

export type SelectOption<T extends SelectValue> = {
  value: T;
  label: string;
  /** The line that actually decides it — dosage form, preset summary, breed group. */
  description?: string;
  icon?: IconName;
  /** Takes precedence over `icon`. Species and food read better as emoji. */
  emoji?: string;
  disabled?: boolean;
  /** Shown greyed with this reason when disabled. */
  disabledReason?: string;
};

export type SelectSection<T extends SelectValue> = {
  title?: string;
  options: SelectOption<T>[];
};

export type SelectProps<T extends SelectValue> = {
  value: T | null;
  onChange: (value: T) => void;
  /** Flat list. Ignored when `sections` is given. */
  options?: SelectOption<T>[];
  sections?: SelectSection<T>[];

  label?: string;
  placeholder?: string;
  helper?: string;
  error?: string;
  /** Sheet heading. Falls back to the field label. */
  title?: string;
  subtitle?: string;

  /** Defaults on once the list is long enough to need scanning. */
  searchable?: boolean;
  searchPlaceholder?: string;

  variant?: FieldVariant;
  size?: FieldSize;
  leadingIcon?: IconName;
  required?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  clearable?: boolean;
  onClear?: () => void;
  reserveMessageSpace?: boolean;

  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/** Past this many rows a list is scanned, not read — so it gets a filter. */
const SEARCH_THRESHOLD = 8;

/** Entrance stagger caps here; beyond it the list would feel slow, not lively. */
const STAGGER_CAP = 8;

/** See `Touchable` — the theme's `springWith` helper doesn't type-check yet. */
const CHEVRON_SPRING: WithSpringConfig = { ...spring.snappy, reduceMotion: ReduceMotion.System };

/* ------------------------------------------------------------------ helpers */

function toSections<T extends SelectValue>(
  options: SelectOption<T>[] | undefined,
  sections: SelectSection<T>[] | undefined,
): SelectSection<T>[] {
  if (sections) return sections;
  return options && options.length > 0 ? [{ options }] : [];
}

function matches(option: SelectOption<SelectValue>, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    option.label.toLowerCase().includes(needle) || (option.description?.toLowerCase().includes(needle) ?? false)
  );
}

/* ----------------------------------------------------------------- the row */

function OptionRow<T extends SelectValue>({
  option,
  selected,
  index,
  onPress,
}: {
  option: SelectOption<T>;
  selected: boolean;
  index: number;
  onPress: (value: T) => void;
}) {
  const t = useTheme();
  const disc = t.spacing.xxl;

  return (
    <Animated.View
      entering={FadeIn.duration(t.motion.duration.base).delay(
        Math.min(index, STAGGER_CAP) * t.motion.stagger.tight,
      )}
    >
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={option.description ? `${option.label}. ${option.description}` : option.label}
        accessibilityState={{ selected, disabled: option.disabled }}
        disabled={option.disabled && !option.disabledReason}
        disabledReason={option.disabledReason}
        haptic="none"
        onPress={() => onPress(option.value)}
        pressScale="large"
        style={[
          styles.row,
          {
            paddingVertical: t.spacing.md,
            paddingHorizontal: t.spacing.md,
            gap: t.spacing.md,
            borderRadius: t.radius.lg,
            backgroundColor: selected ? t.color.primarySoft : 'transparent',
          },
        ]}
      >
        {option.emoji ? (
          <View style={[styles.center, { width: disc, height: disc }]}>
            <Text variant="title3">{option.emoji}</Text>
          </View>
        ) : option.icon ? (
          <View
            style={[
              styles.center,
              {
                width: disc,
                height: disc,
                borderRadius: t.radius.md,
                backgroundColor: selected ? t.color.primarySoftBorder : t.color.surfaceAlt,
              },
            ]}
          >
            <Icon name={option.icon} size="sm" color={selected ? 'onPrimarySoft' : 'textSecondary'} />
          </View>
        ) : null}

        <Column flex gap="hair">
          <Text variant="bodyStrong" color={option.disabled ? 'textFaint' : selected ? 'onPrimarySoft' : 'text'}>
            {option.label}
          </Text>
          {option.description ? (
            <Text variant="footnote" color={option.disabled ? 'textFaint' : 'textTertiary'}>
              {option.description}
            </Text>
          ) : null}
        </Column>

        {selected ? (
          <Animated.View
            entering={ZoomIn.springify().damping(spring.snappy.damping).stiffness(spring.snappy.stiffness)}
            exiting={ZoomOut.duration(t.motion.duration.fast)}
            style={[
              styles.center,
              {
                width: t.spacing.xl,
                height: t.spacing.xl,
                borderRadius: t.radius.pill,
                backgroundColor: t.color.primary,
              },
            ]}
          >
            <Icon name="checkmark" size="xs" color={t.color.onPrimary} />
          </Animated.View>
        ) : null}
      </Touchable>
    </Animated.View>
  );
}

/* ---------------------------------------------------------------- component */

export function Select<T extends SelectValue>({
  value,
  onChange,
  options,
  sections,
  label,
  placeholder = 'Choose one',
  helper,
  error,
  title,
  subtitle,
  searchable,
  searchPlaceholder = 'Search options',
  variant = 'outlined',
  size = 'md',
  leadingIcon,
  required = false,
  disabled = false,
  disabledReason,
  clearable = false,
  onClear,
  reserveMessageSpace = false,
  style,
  testID,
}: SelectProps<T>) {
  const t = useTheme();
  const m = useFieldMetrics(size, !!label);
  const { height: windowHeight } = useWindowDimensions();
  const { shakeStyle, shake } = useFieldShake();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const resolved = useMemo(() => toSections(options, sections), [options, sections]);
  const total = useMemo(() => resolved.reduce((sum, s) => sum + s.options.length, 0), [resolved]);
  const withSearch = searchable ?? total > SEARCH_THRESHOLD;

  const selected = useMemo(() => {
    for (const section of resolved) {
      const hit = section.options.find((option) => option.value === value);
      if (hit) return hit;
    }
    return null;
  }, [resolved, value]);

  const filtered = useMemo(() => {
    if (!withSearch || !query.trim()) return resolved;
    return resolved
      .map((section) => ({ ...section, options: section.options.filter((option) => matches(option, query)) }))
      .filter((section) => section.options.length > 0);
  }, [query, resolved, withSearch]);

  const inert = disabled || disabledReason !== undefined;

  const chevron = useSharedValue(0);
  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${interpolate(chevron.value, [0, 1], [0, 180])}deg` }],
  }));

  const setOpenState = useCallback(
    (next: boolean) => {
      setOpen(next);
      chevron.value = withSpring(next ? 1 : 0, CHEVRON_SPRING);
      if (!next) setQuery('');
    },
    [chevron],
  );

  const handleTrigger = useCallback(() => {
    if (disabledReason) {
      shake();
      return;
    }
    haptics.tap();
    setOpenState(true);
  }, [disabledReason, setOpenState, shake]);

  const handlePick = useCallback(
    (next: T) => {
      haptics.select();
      onChange(next);
      // A beat of daylight so the check animation is actually seen before the
      // sheet leaves — instant dismissal reads as "did that register?".
      setTimeout(() => setOpenState(false), t.motion.duration.fast);
    },
    [onChange, setOpenState, t.motion.duration.fast],
  );

  const handleClear = useCallback(() => {
    haptics.tap();
    onClear?.();
  }, [onClear]);

  const hasValue = selected !== null;
  const listMaxHeight = windowHeight * 0.5;

  return (
    <Animated.View style={[shakeStyle, style]}>
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={label ? `${label}. ${selected?.label ?? placeholder}` : (selected?.label ?? placeholder)}
        accessibilityHint={helper}
        accessibilityState={{ disabled, expanded: open }}
        disabled={disabled}
        disabledReason={disabledReason}
        haptic="none"
        onPress={handleTrigger}
        pressScale="subtle"
        testID={testID}
      >
        <FieldFrame
          label={label}
          floated={hasValue || open}
          focused={open}
          invalid={!!error}
          disabled={inert}
          required={required}
          variant={variant}
          size={size}
          leading={
            selected?.emoji ? (
              <Text variant="body">{selected.emoji}</Text>
            ) : leadingIcon ? (
              <FieldIcon name={leadingIcon} size={m.iconSize} active={open} invalid={!!error} disabled={inert} />
            ) : undefined
          }
          trailing={
            <Row gap="xs">
              {clearable && hasValue && !inert ? (
                <Touchable
                  accessibilityRole="button"
                  accessibilityLabel={label ? `Clear ${label.toLowerCase()}` : 'Clear selection'}
                  haptic="none"
                  onPress={handleClear}
                  pressScale="small"
                >
                  <View
                    style={[
                      styles.center,
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
              ) : null}
              <Animated.View style={chevronStyle}>
                <Icon name="chevron-down" size={m.iconSize} color={inert ? 'textFaint' : 'textTertiary'} />
              </Animated.View>
            </Row>
          }
        >
          <Text
            variant="body"
            color={inert ? 'textFaint' : hasValue ? 'text' : 'textFaint'}
            numberOfLines={1}
            style={{ height: m.textBlock }}
          >
            {selected?.label ?? placeholder}
          </Text>
        </FieldFrame>
      </Touchable>

      <FieldMessage helper={helper} error={error} reserve={reserveMessageSpace} />

      <FieldSheet
        visible={open}
        onRequestClose={() => setOpenState(false)}
        title={title ?? label ?? 'Choose'}
        subtitle={subtitle}
        dismissOnDrag
      >
        {withSearch ? (
          <View style={{ paddingBottom: t.spacing.md }}>
            <SearchField
              value={query}
              onChangeText={setQuery}
              placeholder={searchPlaceholder}
              showCancel={false}
              size="md"
            />
          </View>
        ) : null}

        {filtered.length === 0 ? (
          <Column align="center" gap="sm" style={{ paddingVertical: t.spacing.xxl }}>
            <Icon name="search-outline" size="xl" color="textFaint" />
            <Text variant="bodyStrong" align="center">
              Nothing matches “{query.trim()}”
            </Text>
            <Text variant="footnote" color="textTertiary" align="center">
              Try a shorter word, or clear the search to see everything.
            </Text>
          </Column>
        ) : (
          <ScrollView
            style={{ maxHeight: listMaxHeight }}
            contentContainerStyle={{ paddingBottom: t.spacing.sm }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {filtered.map((section, sectionIndex) => (
              <View key={section.title ?? `section-${sectionIndex}`}>
                {section.title ? (
                  <Text
                    variant="overline"
                    color="textTertiary"
                    style={{
                      paddingHorizontal: t.spacing.md,
                      paddingTop: sectionIndex === 0 ? 0 : t.spacing.base,
                      paddingBottom: t.spacing.xs,
                    }}
                  >
                    {section.title}
                  </Text>
                ) : null}
                {section.options.map((option, index) => (
                  <OptionRow
                    key={String(option.value)}
                    option={option}
                    selected={option.value === value}
                    index={index}
                    onPress={handlePick}
                  />
                ))}
              </View>
            ))}
          </ScrollView>
        )}
      </FieldSheet>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
});

export default Select;
