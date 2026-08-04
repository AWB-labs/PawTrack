/**
 * Petal — DayStrip.
 *
 * The week ribbon under the Today header. It answers two questions at a glance
 * — *what day am I looking at* and *how did the rest of the week go* — and it
 * has to answer the second one without ever making you wait, because a calendar
 * whose dots arrive late is a calendar you stop trusting.
 *
 * Three decisions carry it:
 *
 *   · **The ring is the dot.** Each day wears a completion arc around its own
 *     numeral rather than a separate marker underneath, so "Tuesday was a good
 *     day" is a shape, not a legend you have to learn. Overdue turns the arc
 *     red; a finished day closes it in green.
 *   · **The fetched window is anchored, not centred.** Summaries are pulled five
 *     weeks at a time and the anchor only moves when the visible week leaves
 *     that window — so swiping two weeks either way costs nothing and the rings
 *     never blink out mid-gesture.
 *   · **The selection is a pill that travels.** A border that blinks from one
 *     date to another reads as a re-render; a pill that springs across reads as
 *     a choice being made. Weeks slide under the thumb and settle.
 *
 * Screen readers can't swipe, so the two chevrons in the caption row are the
 * real navigation and the gesture is the shortcut — not the other way round.
 */

import { addDays, differenceInCalendarDays, format, startOfWeek } from 'date-fns';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type WithSpringConfig,
} from 'react-native-reanimated';
import { runOnJS } from 'react-native-worklets';

import { useDaySummaryIndex } from '@/data/queries/useCareTasks';
import type { DateOnly, DaySummary, ID } from '@/data/types';
import haptics from '@/lib/haptics';
import { WEEKDAY_LONG, fromDateOnly, toDateOnly } from '@/lib/date';
import { spring, useTheme } from '@/theme';
import { IconButton, ProgressRing, Row, Text, Touchable, type ProgressRingTone } from '@/ui';

/* -------------------------------------------------------------------- types */

export type DayStripProps = {
  /** The day the screen is showing. */
  selected: DateOnly;
  onSelect: (date: DateOnly) => void;
  /** Today, in the device's calendar. Passed in so the strip has no clock of its own. */
  today: DateOnly;
  /** Null scopes the rings to every pet the viewer can see. */
  petId?: ID | null;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

type DayCellProps = {
  date: Date;
  dateKey: DateOnly;
  summary: DaySummary | undefined;
  selected: boolean;
  isToday: boolean;
  onPress: (date: DateOnly) => void;
};

/* ---------------------------------------------------------------- constants */

const DAYS_IN_WEEK = 7;

/** Weeks fetched in one go. Two either side means normal browsing never refetches. */
const RANGE_WEEKS = 5;
const RANGE_LEAD_WEEKS = 2;

/** See `@/ui/Touchable` — the theme's `springWith` helper doesn't type-check yet. */
const SETTLE: WithSpringConfig = { ...spring.snappy, reduceMotion: ReduceMotion.System };

/** Fraction of the strip's width that commits a week change on release. */
const COMMIT_FRACTION = 0.22;

/** Flick speed that turns the page even from a short drag. */
const FLICK_VELOCITY = 480;

/** The strip trails the thumb slightly, which is what makes it feel like paper. */
const DRAG_FOLLOW = 0.85;

/* ------------------------------------------------------------------ helpers */

function weekStartOf(date: DateOnly): DateOnly {
  return toDateOnly(startOfWeek(fromDateOnly(date) ?? new Date()));
}

function shiftDays(date: DateOnly, days: number): DateOnly {
  const base = fromDateOnly(date);
  return base ? toDateOnly(addDays(base, days)) : date;
}

/** "March", or "Feb – Mar" when the week straddles two of them. */
function spanLabel(start: Date, end: Date, now: Date): string {
  const sameMonth = start.getMonth() === end.getMonth();
  const sameYear = start.getFullYear() === now.getFullYear();
  if (sameMonth) return sameYear ? format(start, 'MMMM') : format(start, 'MMMM yyyy');
  return `${format(start, 'MMM')} – ${format(end, sameYear ? 'MMM' : 'MMM yyyy')}`;
}

function ringTone(summary: DaySummary | undefined): ProgressRingTone {
  if (!summary || summary.total === 0) return 'primary';
  if (summary.overdue > 0) return 'danger';
  return summary.done === summary.total ? 'success' : 'primary';
}

/* ---------------------------------------------------------------- component */

export function DayStrip({ selected, onSelect, today, petId = null, style, testID }: DayStripProps) {
  const t = useTheme();

  const [weekStart, setWeekStart] = useState(() => weekStartOf(selected));
  const [anchor, setAnchor] = useState(() => shiftDays(weekStartOf(selected), -RANGE_LEAD_WEEKS * DAYS_IN_WEEK));
  const [width, setWidth] = useState(0);

  const measured = useSharedValue(0);
  const widthRef = useRef(0);
  const slide = useSharedValue(0);

  /* ---- the visible week ------------------------------------------------- */

  // Picking a day never moves the week (it's already the right one); jumping to
  // Today, or arriving with a different date, does.
  useEffect(() => {
    const next = weekStartOf(selected);
    setWeekStart((prev) => (prev === next ? prev : next));
  }, [selected]);

  const shiftWeek = useCallback(
    (delta: number) => {
      setWeekStart((prev) => shiftDays(prev, delta * DAYS_IN_WEEK));
      // The replacement week arrives from the side the old one left towards.
      slide.value = delta * widthRef.current;
      slide.value = withSpring(0, SETTLE);
      haptics.select();
    },
    [slide],
  );

  /* ---- the fetched window ----------------------------------------------- */

  useEffect(() => {
    const start = fromDateOnly(anchor);
    const week = fromDateOnly(weekStart);
    if (!start || !week) return;
    const offset = differenceInCalendarDays(week, start);
    if (offset >= 0 && offset <= (RANGE_WEEKS - 1) * DAYS_IN_WEEK) return;
    setAnchor(shiftDays(weekStart, -RANGE_LEAD_WEEKS * DAYS_IN_WEEK));
  }, [anchor, weekStart]);

  const rangeTo = useMemo(() => shiftDays(anchor, RANGE_WEEKS * DAYS_IN_WEEK - 1), [anchor]);
  const { data: summaries } = useDaySummaryIndex(anchor, rangeTo, petId);

  /* ---- days -------------------------------------------------------------- */

  const days = useMemo(() => {
    const start = fromDateOnly(weekStart) ?? new Date();
    return Array.from({ length: DAYS_IN_WEEK }, (_, index) => {
      const date = addDays(start, index);
      return { date, key: toDateOnly(date) };
    });
  }, [weekStart]);

  const firstDay = days[0]?.date ?? new Date();
  const lastDay = days[DAYS_IN_WEEK - 1]?.date ?? firstDay;
  const todayDate = useMemo(() => fromDateOnly(today) ?? new Date(), [today]);

  const selectedIndex = days.findIndex((day) => day.key === selected);
  const onSelectedWeek = selectedIndex >= 0;

  /* ---- the travelling pill ---------------------------------------------- */

  const [pillIndex, setPillIndex] = useState(() => Math.max(0, selectedIndex));
  useEffect(() => {
    if (selectedIndex >= 0) setPillIndex(selectedIndex);
  }, [selectedIndex]);

  const cellWidth = width / DAYS_IN_WEEK;
  const pillX = useSharedValue(0);
  const pillOpacity = useSharedValue(0);
  const placed = useRef(false);

  useEffect(() => {
    if (cellWidth === 0) return;
    const target = pillIndex * cellWidth;
    // The first placement is a fact, not a movement — springing in from zero on
    // mount would read as the strip choosing a day by itself.
    if (!placed.current) {
      placed.current = true;
      pillX.value = target;
    } else {
      pillX.value = withSpring(target, SETTLE);
    }
  }, [cellWidth, pillIndex, pillX]);

  useEffect(() => {
    pillOpacity.value = withTiming(
      onSelectedWeek && cellWidth > 0 ? 1 : 0,
      t.motion.timing(t.motion.duration.fast, 'smooth'),
    );
  }, [cellWidth, onSelectedWeek, pillOpacity, t.motion]);

  const pillStyle = useAnimatedStyle(() => ({
    opacity: pillOpacity.value,
    transform: [{ translateX: pillX.value }],
  }));

  /* ---- the swipe --------------------------------------------------------- */

  const exitTiming = useMemo(
    () => t.motion.timing(t.motion.duration.fast, 'accelerate'),
    [t.motion],
  );

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        // Horizontal intent only — a vertical drag belongs to the screen.
        .activeOffsetX([-14, 14])
        .failOffsetY([-14, 14])
        .onUpdate((event) => {
          slide.value = event.translationX * DRAG_FOLLOW;
        })
        .onEnd((event) => {
          const span = measured.value;
          const committed =
            span > 0 &&
            (Math.abs(event.translationX) > span * COMMIT_FRACTION ||
              Math.abs(event.velocityX) > FLICK_VELOCITY);

          if (!committed) {
            slide.value = withSpring(0, SETTLE);
            return;
          }

          const delta = event.translationX > 0 ? -1 : 1;
          slide.value = withTiming(-delta * span, exitTiming, (finished) => {
            'worklet';
            if (finished) runOnJS(shiftWeek)(delta);
          });
        }),
    [exitTiming, measured, shiftWeek, slide],
  );

  const slideStyle = useAnimatedStyle(() => ({ transform: [{ translateX: slide.value }] }));

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const next = event.nativeEvent.layout.width;
      measured.value = next;
      widthRef.current = next;
      setWidth((prev) => (Math.abs(prev - next) < 1 ? prev : next));
    },
    [measured],
  );

  /* ---- render ------------------------------------------------------------ */

  const showTodayJump = selected !== today;

  return (
    <View style={[{ gap: t.spacing.xs }, style]} testID={testID}>
      <Row justify="between" gap="sm">
        <Text variant="overline" color="textTertiary" numberOfLines={1} style={styles.grow}>
          {spanLabel(firstDay, lastDay, todayDate)}
        </Text>

        <Row gap="xxs">
          {showTodayJump ? (
            <Touchable
              accessibilityRole="button"
              accessibilityLabel="Jump to today"
              haptic="select"
              onPress={() => onSelect(today)}
              pressScale="small"
              style={{
                paddingHorizontal: t.spacing.sm,
                paddingVertical: t.spacing.xxs,
                borderRadius: t.radius.pill,
                backgroundColor: t.color.primarySoft,
              }}
            >
              <Text variant="captionStrong" color="onPrimarySoft">
                Today
              </Text>
            </Touchable>
          ) : null}

          <IconButton
            icon="chevron-back"
            accessibilityLabel="Previous week"
            variant="ghost"
            tone="neutral"
            size="sm"
            haptic="none"
            onPress={() => shiftWeek(-1)}
          />
          <IconButton
            icon="chevron-forward"
            accessibilityLabel="Next week"
            variant="ghost"
            tone="neutral"
            size="sm"
            haptic="none"
            onPress={() => shiftWeek(1)}
          />
        </Row>
      </Row>

      <View onLayout={handleLayout} style={styles.clip}>
        <GestureDetector gesture={gesture}>
          <Animated.View
            accessibilityRole="tablist"
            accessibilityLabel="Pick a day"
            style={[styles.row, slideStyle]}
          >
            <Animated.View
              pointerEvents="none"
              style={[
                styles.pill,
                {
                  width: cellWidth,
                  borderRadius: t.radius.xl,
                  backgroundColor: t.color.primarySoft,
                  borderWidth: t.borderWidth.hairline,
                  borderColor: t.color.primarySoftBorder,
                },
                pillStyle,
              ]}
            />

            {days.map((day) => (
              <DayCell
                key={day.key}
                date={day.date}
                dateKey={day.key}
                summary={summaries?.get(day.key)}
                selected={day.key === selected}
                isToday={day.key === today}
                onPress={onSelect}
              />
            ))}
          </Animated.View>
        </GestureDetector>
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------- cell */

function DayCell({ date, dateKey, summary, selected, isToday, onPress }: DayCellProps) {
  const t = useTheme();

  const diameter = t.spacing.xxxl;
  const total = summary?.total ?? 0;
  const done = summary?.done ?? 0;
  const value = total === 0 ? 0 : done / total;
  const empty = total === 0;

  const weekday = WEEKDAY_LONG[date.getDay()] ?? '';
  const numberColor = selected
    ? 'onPrimarySoft'
    : isToday
      ? 'accentText'
      : empty
        ? 'textTertiary'
        : 'text';

  const tally = empty
    ? 'nothing scheduled'
    : done === total
      ? `all ${total} done`
      : `${done} of ${total} done`;

  return (
    <Touchable
      accessibilityRole="tab"
      accessibilityLabel={`${weekday} ${format(date, 'd MMMM')}${isToday ? ', today' : ''}`}
      accessibilityHint={tally}
      accessibilityState={{ selected }}
      haptic="select"
      onPress={() => onPress(dateKey)}
      pressScale="small"
      style={[styles.cell, { paddingVertical: t.spacing.sm, gap: t.spacing.xxs }]}
    >
      <Text
        variant={selected ? 'captionStrong' : 'caption'}
        color={selected ? 'onPrimarySoft' : 'textTertiary'}
        // The numeral beside it is the fixed-width part; letting a one-character
        // label grow 1.8× would push the ring out of its cell.
        maxFontSizeMultiplier={1.3}
      >
        {weekday.charAt(0)}
      </Text>

      {/* The ring is a picture of the label the Touchable already announces. */}
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <ProgressRing
          value={value}
          size={diameter}
          thickness={t.borderWidth.thick}
          tone={ringTone(summary)}
          trackColor={empty ? t.color.divider : t.color.surfaceAlt}
        >
          <Text variant="subheadStrong" color={numberColor} tabular maxFontSizeMultiplier={1.2}>
            {date.getDate()}
          </Text>
        </ProgressRing>
      </View>

      <View
        style={{
          width: t.spacing.xxs,
          height: t.spacing.xxs,
          borderRadius: t.spacing.xxs / 2,
          backgroundColor: isToday ? t.color.accent : 'transparent',
        }}
      />
    </Touchable>
  );
}

/* ------------------------------------------------------------------ styles */

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  cell: { flex: 1, alignItems: 'center' },
  pill: { position: 'absolute', top: 0, bottom: 0, left: 0 },
  grow: { flexShrink: 1 },
});

export default DayStrip;
