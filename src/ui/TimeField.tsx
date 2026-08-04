/**
 * Petal — TimeField, and the wheel picker behind it.
 *
 * There is no cross-platform time picker in Expo Go worth shipping, so this is
 * a real drum: snapping scroll views with the selected row parked under a
 * highlight band, rows that fade and shrink with distance from centre, gradient
 * masks top and bottom, and a selection tick every time a row crosses the line.
 * The tick is what makes it feel mechanical rather than like a list that
 * happens to stop in convenient places.
 *
 * Feeding schedules and dose times are stored as `"HH:mm"` local strings (see
 * `data/types`), so that's exactly what this emits — no timezone anywhere near
 * a wall-clock value.
 *
 * `hourCycle: 'auto'` reads the device's own formatting rather than the locale
 * string, because plenty of people run an English locale with a 24-hour clock.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';

import { formatTimeOfDay, minutesToTimeOfDay, parseTimeOfDay } from '@/lib/date';
import haptics from '@/lib/haptics';
import { useTheme } from '@/theme';
import type { TimeOfDay } from '@/data/types';
import { Button } from './Button';
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

export type HourCycle = '12h' | '24h' | 'auto';

export type TimeWheelProps = {
  /** `"HH:mm"`, 24-hour. */
  value: TimeOfDay;
  onChange: (value: TimeOfDay) => void;
  minuteStep?: number;
  hourCycle?: HourCycle;
  /** Background the gradient masks blend into. Defaults to the raised surface. */
  ground?: string;
  testID?: string;
};

export type TimeFieldProps = {
  value: TimeOfDay | null;
  onChange: (value: TimeOfDay) => void;
  label?: string;
  placeholder?: string;
  helper?: string;
  error?: string;
  /** Dialog heading. Falls back to the field label. */
  title?: string;
  minuteStep?: number;
  hourCycle?: HourCycle;
  variant?: FieldVariant;
  size?: FieldSize;
  required?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  reserveMessageSpace?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/** Rows visible above and below the selection. Five total reads as a drum. */
const VISIBLE_ROWS = 5;
const PAD_ROWS = (VISIBLE_ROWS - 1) / 2;

const MERIDIEM = ['AM', 'PM'] as const;

/** Default fallback when the device gives us nothing to sniff. */
const DEFAULT_MINUTE_STEP = 5;

/* ------------------------------------------------------------------ helpers */

/**
 * Does this device show a 12-hour clock? `Intl` isn't guaranteed to expose
 * `hourCycle` on Hermes, so we format a known afternoon time and look for the
 * day-period marker — crude, but it agrees with the OS setting, which is the
 * thing the user actually chose.
 */
function detectTwelveHour(): boolean {
  try {
    const sample = new Date(2000, 0, 1, 13, 0, 0).toLocaleTimeString();
    return /am|pm/i.test(sample);
  } catch {
    return true;
  }
}

function clampIndex(index: number, length: number): number {
  return Math.min(length - 1, Math.max(0, index));
}

/* ------------------------------------------------------------------- wheel */

type WheelProps = {
  items: string[];
  index: number;
  onIndexChange: (index: number) => void;
  rowHeight: number;
  width: number;
  accessibilityLabel: string;
};

function Wheel({ items, index, onIndexChange, rowHeight, width, accessibilityLabel }: WheelProps) {
  const scrollRef = useRef<ScrollView>(null);
  /**
   * A plain ScrollView driving a shared value beats an Animated one here: the
   * wheel needs a real `scrollTo` to park on its initial value, and this way the
   * per-row fade still runs on the UI thread with nothing crossing back.
   */
  const offset = useSharedValue(index * rowHeight);
  const lastTick = useRef(index);
  const [ready, setReady] = useState(false);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = event.nativeEvent.contentOffset.y;
      offset.value = y;
      const nearest = Math.round(y / rowHeight);
      if (nearest !== lastTick.current) {
        lastTick.current = nearest;
        haptics.select();
      }
    },
    [offset, rowHeight],
  );

  // Park on the current value once the view has a size to scroll within.
  useEffect(() => {
    if (!ready) return;
    scrollRef.current?.scrollTo({ y: index * rowHeight, animated: false });
    offset.value = index * rowHeight;
    lastTick.current = index;
  }, [index, offset, ready, rowHeight]);

  const settle = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const next = clampIndex(Math.round(event.nativeEvent.contentOffset.y / rowHeight), items.length);
      if (next !== index) onIndexChange(next);
    },
    [index, items.length, onIndexChange, rowHeight],
  );

  return (
    <View style={{ width, height: rowHeight * VISIBLE_ROWS }}>
      <ScrollView
        ref={scrollRef}
        onLayout={() => setReady(true)}
        onScroll={handleScroll}
        onMomentumScrollEnd={settle}
        onScrollEndDrag={settle}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        snapToInterval={rowHeight}
        disableIntervalMomentum
        decelerationRate="fast"
        contentContainerStyle={{ paddingVertical: rowHeight * PAD_ROWS }}
        accessibilityLabel={accessibilityLabel}
      >
        {items.map((item, i) => (
          <WheelRow key={item} label={item} index={i} offset={offset} rowHeight={rowHeight} />
        ))}
      </ScrollView>
    </View>
  );
}

function WheelRow({
  label,
  index,
  offset,
  rowHeight,
}: {
  label: string;
  index: number;
  offset: SharedValue<number>;
  rowHeight: number;
}) {
  const style = useAnimatedStyle(() => {
    const distance = Math.abs(offset.value / rowHeight - index);
    return {
      opacity: interpolate(distance, [0, 1, 2], [1, 0.42, 0.16], Extrapolation.CLAMP),
      transform: [{ scale: interpolate(distance, [0, 1, 2], [1, 0.84, 0.72], Extrapolation.CLAMP) }],
    };
  });

  return (
    <Animated.View style={[{ height: rowHeight }, styles.center, style]}>
      <Text variant="title2" tabular>
        {label}
      </Text>
    </Animated.View>
  );
}

/* -------------------------------------------------------------- wheel picker */

export function TimeWheel({
  value,
  onChange,
  minuteStep = DEFAULT_MINUTE_STEP,
  hourCycle = 'auto',
  ground,
  testID,
}: TimeWheelProps) {
  const t = useTheme();
  const twelve = hourCycle === 'auto' ? detectTwelveHour() : hourCycle === '12h';

  const parsed = parseTimeOfDay(value) ?? { hour: 9, minute: 0 };
  const rowHeight = (t.type.title2.lineHeight ?? t.spacing.xl) + t.spacing.md;

  const hours = useMemo(
    () =>
      twelve
        ? Array.from({ length: 12 }, (_, i) => String(i + 1))
        : Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')),
    [twelve],
  );

  const minutes = useMemo(
    () =>
      Array.from({ length: Math.ceil(60 / minuteStep) }, (_, i) => String(i * minuteStep).padStart(2, '0')),
    [minuteStep],
  );

  const hourIndex = twelve ? (parsed.hour % 12 === 0 ? 11 : (parsed.hour % 12) - 1) : parsed.hour;
  const minuteIndex = clampIndex(Math.round(parsed.minute / minuteStep), minutes.length);
  const meridiemIndex = parsed.hour >= 12 ? 1 : 0;

  const emit = useCallback(
    (h: number, mi: number, mer: number) => {
      const hour24 = twelve ? ((h + 1) % 12) + (mer === 1 ? 12 : 0) : h;
      onChange(minutesToTimeOfDay(hour24 * 60 + mi * minuteStep));
    },
    [minuteStep, onChange, twelve],
  );

  const wheelWidth = t.spacing.colossal;
  const fade: readonly [string, string] = [ground ?? t.color.surfaceRaised, 'transparent'];

  return (
    <View style={styles.picker} testID={testID}>
      {/* Band first so the rows sit on top of it, not under a wash. */}
      <View
        pointerEvents="none"
        style={[
          styles.band,
          {
            top: rowHeight * PAD_ROWS,
            height: rowHeight,
            borderRadius: t.radius.md,
            backgroundColor: t.color.primarySoft,
          },
        ]}
      />

      <Row gap="xs" align="center">
        <Wheel
          items={hours}
          index={clampIndex(hourIndex, hours.length)}
          onIndexChange={(next) => emit(next, minuteIndex, meridiemIndex)}
          rowHeight={rowHeight}
          width={wheelWidth}
          accessibilityLabel="Hour"
        />
        <Text variant="title2" color="textTertiary">
          :
        </Text>
        <Wheel
          items={minutes}
          index={minuteIndex}
          onIndexChange={(next) => emit(hourIndex, next, meridiemIndex)}
          rowHeight={rowHeight}
          width={wheelWidth}
          accessibilityLabel="Minute"
        />
        {twelve ? (
          <Wheel
            items={[...MERIDIEM]}
            index={meridiemIndex}
            onIndexChange={(next) => emit(hourIndex, minuteIndex, next)}
            rowHeight={rowHeight}
            width={wheelWidth}
            accessibilityLabel="Before or after noon"
          />
        ) : null}
      </Row>

      <LinearGradient
        colors={fade}
        pointerEvents="none"
        style={[styles.mask, { top: 0, height: rowHeight * PAD_ROWS }]}
      />
      <LinearGradient
        colors={fade}
        start={{ x: 0, y: 1 }}
        end={{ x: 0, y: 0 }}
        pointerEvents="none"
        style={[styles.mask, { bottom: 0, height: rowHeight * PAD_ROWS }]}
      />
    </View>
  );
}

/* ---------------------------------------------------------------- component */

export function TimeField({
  value,
  onChange,
  label,
  placeholder = 'Pick a time',
  helper,
  error,
  title,
  minuteStep = DEFAULT_MINUTE_STEP,
  hourCycle = 'auto',
  variant = 'outlined',
  size = 'md',
  required = false,
  disabled = false,
  disabledReason,
  reserveMessageSpace = false,
  style,
  testID,
}: TimeFieldProps) {
  const t = useTheme();
  const m = useFieldMetrics(size, !!label);
  const { shakeStyle, shake } = useFieldShake();

  const [open, setOpen] = useState(false);
  /** Scrolling a wheel shouldn't commit — the drum is a draft until "Done". */
  const [draft, setDraft] = useState<TimeOfDay>(value ?? '09:00');

  const inert = disabled || disabledReason !== undefined;
  const display = value ? formatTimeOfDay(value) : null;

  const handleOpen = useCallback(() => {
    if (disabledReason) {
      shake();
      return;
    }
    haptics.tap();
    setDraft(value ?? '09:00');
    setOpen(true);
  }, [disabledReason, shake, value]);

  const handleConfirm = useCallback(() => {
    haptics.commit();
    onChange(draft);
    setOpen(false);
  }, [draft, onChange]);

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
          // See DateField's identical fix: the value slot always shows *some*
          // text (the picked time, or `placeholder`, which defaults to
          // 'Pick a time'), so the label must float clear of it whenever a
          // placeholder exists — not only once a real value is set, or the
          // resting label sits directly on top of the placeholder text.
          floated={display !== null || open || !!placeholder}
          focused={open}
          invalid={!!error}
          disabled={inert}
          required={required}
          variant={variant}
          size={size}
          leading={<FieldIcon name="time-outline" size={m.iconSize} active={open} invalid={!!error} disabled={inert} />}
          trailing={<Icon name="chevron-down" size={m.iconSize} color={inert ? 'textFaint' : 'textTertiary'} />}
        >
          <Text
            variant="body"
            color={inert ? 'textFaint' : display ? 'text' : 'textFaint'}
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
        title={title ?? label ?? 'Pick a time'}
        subtitle={formatTimeOfDay(draft)}
      >
        <View style={{ alignItems: 'center', paddingVertical: t.spacing.sm }}>
          <TimeWheel value={draft} onChange={setDraft} minuteStep={minuteStep} hourCycle={hourCycle} />
        </View>

        <Row gap="md" style={{ paddingTop: t.spacing.base }}>
          <Button label="Cancel" variant="ghost" onPress={() => setOpen(false)} />
          <View style={styles.flex} />
          <Button label="Done" variant="primary" onPress={handleConfirm} />
        </Row>
      </FieldDialog>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  picker: { position: 'relative' },
  band: { position: 'absolute', left: 0, right: 0 },
  mask: { position: 'absolute', left: 0, right: 0 },
});

export default TimeField;
