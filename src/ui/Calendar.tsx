/**
 * Petal — Calendar.
 *
 * A month grid built from scratch, because every off-the-shelf RN calendar
 * either drags in its own theming or can't do the two things this app actually
 * needs: coloured dots that distinguish *due* from *overdue* from *appointment*,
 * and a range mode for a caregiver's sitting window.
 *
 * How the paging works, and why it's built this way:
 *
 *   Each month page is laid out at an **absolute** offset — `(index - origin) *
 *   width` — and the track is translated by `-(page - origin) * width`. So
 *   committing a swipe changes which three months are mounted but *moves
 *   nothing*: the incoming page was already sitting at its final coordinate.
 *   The usual three-page carousel recentres itself after each swipe, and that
 *   recentre is the frame where you see a flicker. This one has no recentre.
 *
 * Other decisions worth knowing:
 *
 *   · **Six rows, always.** A month that needs five would otherwise shrink the
 *     sheet under your finger. Outside days are shown faintly and *are*
 *     tappable — tapping the 1st of next month pages there, which is what
 *     everyone tries.
 *   · **Selection is a mounted disc**, not 42 animated cells. One entering and
 *     one exiting animation per change, instead of 42 idle shared values.
 *   · **Dots keep their tone even under a selected disc**, sitting below it —
 *     recolouring them to the disc's ink would throw away the only information
 *     they carry.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  FadeIn,
  FadeInLeft,
  FadeInRight,
  FadeOutLeft,
  FadeOutRight,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  ZoomIn,
  ZoomOut,
  type WithSpringConfig,
} from 'react-native-reanimated';
import { runOnJS } from 'react-native-worklets';
import { addDays, format, isSameDay, isSameMonth, startOfMonth, startOfWeek } from 'date-fns';

import { toDateOnly, WEEKDAY_LONG } from '@/lib/date';
import haptics from '@/lib/haptics';
import { spring, useTheme, type Theme } from '@/theme';
import type { DateOnly } from '@/data/types';
import { IconButton } from './IconButton';
import { Row } from './Stack';
import { Text } from './Text';
import { Touchable } from './Touchable';

/* -------------------------------------------------------------------- types */

export type CalendarMarkTone = 'due' | 'overdue' | 'appointment' | 'done' | 'note';

export type CalendarMark = {
  tone?: CalendarMarkTone;
  /** Overrides the tone's colour — e.g. a pet's species identity colour. */
  color?: string;
  /** Folded into the day's spoken label. "2 doses due". */
  label?: string;
};

/** `{ '2026-08-04': [{ tone: 'overdue' }, { tone: 'appointment' }] }` */
export type CalendarMarks = Record<DateOnly, readonly CalendarMark[] | undefined>;

export type CalendarRange = { start: DateOnly | null; end: DateOnly | null };

export type CalendarProps = {
  mode?: 'single' | 'range';
  /** Single mode. */
  value?: DateOnly | null;
  onChange?: (date: DateOnly) => void;
  /** Range mode. */
  range?: CalendarRange;
  onRangeChange?: (range: CalendarRange) => void;

  /** Controlled visible month (any day within it). */
  month?: DateOnly;
  onMonthChange?: (monthStart: DateOnly) => void;

  minDate?: DateOnly;
  maxDate?: DateOnly;
  /** Extra per-day veto — closed clinic days, dates before a pet was adopted. */
  isDateDisabled?: (date: DateOnly) => boolean;

  marks?: CalendarMarks;
  /** 0 = Sunday, 1 = Monday. */
  firstDayOfWeek?: 0 | 1;
  showTodayRing?: boolean;
  /** Show the "Today" shortcut when the visible month isn't the current one. */
  showTodayShortcut?: boolean;

  style?: StyleProp<ViewStyle>;
  testID?: string;
};

type DayCell = {
  date: Date;
  key: DateOnly;
  outside: boolean;
};

/* ---------------------------------------------------------------- constants */

const ROWS = 6;
const COLUMNS = 7;
const CELLS = ROWS * COLUMNS;
const MAX_DOTS = 3;

/** See `Touchable` — the theme's `springWith` helper doesn't type-check yet. */
const PAGE_SPRING: WithSpringConfig = { ...spring.heavy, reduceMotion: ReduceMotion.System };
const DISC_SPRING = { damping: spring.snappy.damping, stiffness: spring.snappy.stiffness };

/** Fling assist: how much of a second of velocity counts toward the next page. */
const VELOCITY_WEIGHT = 0.22;

/* ------------------------------------------------------------------ helpers */

const monthIndexOf = (date: Date): number => date.getFullYear() * 12 + date.getMonth();
const monthFromIndex = (index: number): Date => new Date(Math.floor(index / 12), index % 12, 1);

function parseDay(value: DateOnly | undefined | null): Date | null {
  if (!value) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return null;
  const parsed = new Date(year, month - 1, day);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The 42 cells of a month page, padded from adjacent months. */
function buildGrid(month: Date, firstDayOfWeek: 0 | 1): DayCell[] {
  const first = startOfWeek(startOfMonth(month), { weekStartsOn: firstDayOfWeek });
  const cells: DayCell[] = [];
  for (let i = 0; i < CELLS; i += 1) {
    const date = addDays(first, i);
    cells.push({ date, key: toDateOnly(date), outside: !isSameMonth(date, month) });
  }
  return cells;
}

function markColor(t: Theme, mark: CalendarMark): string {
  if (mark.color) return mark.color;
  switch (mark.tone) {
    case 'overdue':
      return t.color.danger;
    case 'due':
      return t.color.warning;
    case 'appointment':
      return t.color.info;
    case 'done':
      return t.color.success;
    case 'note':
    default:
      return t.color.textTertiary;
  }
}

/** `'2026-08-04'` → `'Tuesday, 4 August 2026'`, for screen readers. */
function spokenDate(date: Date): string {
  return `${WEEKDAY_LONG[date.getDay()]}, ${format(date, 'd MMMM yyyy')}`;
}

/* ------------------------------------------------------------------- cell */

type CellProps = {
  cell: DayCell;
  size: number;
  discSize: number;
  dotRow: number;
  selected: boolean;
  isToday: boolean;
  disabled: boolean;
  rangeStart: boolean;
  rangeEnd: boolean;
  inRange: boolean;
  marks: readonly CalendarMark[] | undefined;
  onPress: (cell: DayCell) => void;
};

const Cell = React.memo(function Cell({
  cell,
  size,
  discSize,
  dotRow,
  selected,
  isToday,
  disabled,
  rangeStart,
  rangeEnd,
  inRange,
  marks,
  onPress,
}: CellProps) {
  const t = useTheme();
  const day = cell.date.getDate();

  const ink = disabled
    ? t.color.textFaint
    : selected
      ? t.color.onPrimary
      : cell.outside
        ? t.color.textFaint
        : isToday
          ? t.color.primaryText
          : t.color.text;

  const states: string[] = [];
  if (isToday) states.push('today');
  if (rangeStart) states.push('start of range');
  else if (rangeEnd) states.push('end of range');
  else if (inRange) states.push('in range');
  const markNote = marks?.map((mark) => mark.label).filter(Boolean).join(', ');
  if (markNote) states.push(markNote);
  else if (marks && marks.length > 0) states.push(`${marks.length} reminder${marks.length === 1 ? '' : 's'}`);

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={
        states.length > 0 ? `${spokenDate(cell.date)}, ${states.join(', ')}` : spokenDate(cell.date)
      }
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      haptic="none"
      onPress={() => onPress(cell)}
      pressScale={disabled ? 1 : 'small'}
      style={[styles.cell, { width: size, height: size + dotRow }]}
    >
      {inRange || rangeStart || rangeEnd ? (
        <Animated.View
          entering={FadeIn.duration(t.motion.duration.fast)}
          pointerEvents="none"
          style={[
            styles.rangeBar,
            {
              height: discSize,
              top: (size - discSize) / 2,
              backgroundColor: t.color.primarySoft,
              // The wash stops at the ends instead of bleeding into empty cells.
              borderTopLeftRadius: rangeStart ? t.radius.pill : 0,
              borderBottomLeftRadius: rangeStart ? t.radius.pill : 0,
              borderTopRightRadius: rangeEnd ? t.radius.pill : 0,
              borderBottomRightRadius: rangeEnd ? t.radius.pill : 0,
              left: rangeStart ? (size - discSize) / 2 : 0,
              right: rangeEnd ? (size - discSize) / 2 : 0,
            },
          ]}
        />
      ) : null}

      <View style={[styles.discBox, { height: size }]}>
        {isToday && !selected ? (
          <View
            pointerEvents="none"
            style={[
              styles.disc,
              {
                width: discSize,
                height: discSize,
                borderRadius: t.radius.pill,
                borderWidth: t.borderWidth.thin,
                borderColor: t.color.primary,
              },
            ]}
          />
        ) : null}

        {selected ? (
          <Animated.View
            entering={ZoomIn.springify().damping(DISC_SPRING.damping).stiffness(DISC_SPRING.stiffness)}
            exiting={ZoomOut.duration(t.motion.duration.fast)}
            pointerEvents="none"
            style={[
              styles.disc,
              t.elevation(1),
              {
                width: discSize,
                height: discSize,
                borderRadius: t.radius.pill,
                backgroundColor: t.color.primary,
              },
            ]}
          />
        ) : null}

        <Text variant={isToday || selected ? 'subheadStrong' : 'subhead'} tabular color={ink}>
          {day}
        </Text>
      </View>

      <View style={[styles.dots, { height: dotRow, gap: t.spacing.hair }]}>
        {(marks ?? []).slice(0, MAX_DOTS).map((mark, index) => (
          <View
            key={index}
            style={{
              width: t.spacing.xxs,
              height: t.spacing.xxs,
              borderRadius: t.spacing.xxs / 2,
              backgroundColor: markColor(t, mark),
              opacity: cell.outside ? t.opacity.muted : 1,
            }}
          />
        ))}
      </View>
    </Touchable>
  );
});

/* ------------------------------------------------------------------- page */

type MonthPageProps = {
  monthIndex: number;
  cellSize: number;
  discSize: number;
  dotRow: number;
  firstDayOfWeek: 0 | 1;
  today: Date;
  showTodayRing: boolean;
  selectedKeys: { single: DateOnly | null; start: DateOnly | null; end: DateOnly | null };
  marks: CalendarMarks | undefined;
  isDisabled: (cell: DayCell) => boolean;
  onPress: (cell: DayCell) => void;
};

const MonthPage = React.memo(function MonthPage({
  monthIndex,
  cellSize,
  discSize,
  dotRow,
  firstDayOfWeek,
  today,
  showTodayRing,
  selectedKeys,
  marks,
  isDisabled,
  onPress,
}: MonthPageProps) {
  const cells = useMemo(
    () => buildGrid(monthFromIndex(monthIndex), firstDayOfWeek),
    [firstDayOfWeek, monthIndex],
  );

  const startDate = parseDay(selectedKeys.start);
  const endDate = parseDay(selectedKeys.end);

  return (
    // Sized from the *floored* cell so seven cells can never round up into an
    // eighth row — a one-pixel overflow costs you a whole week of layout.
    <View style={[styles.grid, { width: cellSize * COLUMNS }]}>
      {cells.map((cell) => {
        const time = cell.date.getTime();
        const inRange =
          startDate !== null &&
          endDate !== null &&
          time > startDate.getTime() &&
          time < endDate.getTime();

        return (
          <Cell
            key={cell.key}
            cell={cell}
            size={cellSize}
            discSize={discSize}
            dotRow={dotRow}
            selected={
              cell.key === selectedKeys.single ||
              cell.key === selectedKeys.start ||
              cell.key === selectedKeys.end
            }
            isToday={showTodayRing && isSameDay(cell.date, today)}
            disabled={isDisabled(cell)}
            rangeStart={endDate !== null && cell.key === selectedKeys.start}
            rangeEnd={startDate !== null && cell.key === selectedKeys.end}
            inRange={inRange}
            marks={marks?.[cell.key]}
            onPress={onPress}
          />
        );
      })}
    </View>
  );
});

/* ---------------------------------------------------------------- component */

export function Calendar({
  mode = 'single',
  value = null,
  onChange,
  range,
  onRangeChange,
  month,
  onMonthChange,
  minDate,
  maxDate,
  isDateDisabled,
  marks,
  firstDayOfWeek = 1,
  showTodayRing = true,
  showTodayShortcut = true,
  style,
  testID,
}: CalendarProps) {
  const t = useTheme();
  const today = useMemo(() => new Date(), []);
  const todayIndex = monthIndexOf(today);

  const anchor = parseDay(month) ?? parseDay(value) ?? parseDay(range?.start ?? null) ?? today;
  const origin = useRef(monthIndexOf(anchor));

  const [page, setPage] = useState(() => monthIndexOf(anchor));
  const [width, setWidth] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);

  const x = useSharedValue(0);

  const minIndex = useMemo(() => {
    const parsed = parseDay(minDate);
    return parsed ? monthIndexOf(parsed) : Number.MIN_SAFE_INTEGER;
  }, [minDate]);

  const maxIndex = useMemo(() => {
    const parsed = parseDay(maxDate);
    return parsed ? monthIndexOf(parsed) : Number.MAX_SAFE_INTEGER;
  }, [maxDate]);

  /* ----- paging ---------------------------------------------------------- */

  const settle = useCallback(
    (target: number, animate: boolean) => {
      if (width <= 0) return;
      const offset = -(target - origin.current) * width;
      x.value = animate ? withSpring(offset, PAGE_SPRING) : offset;
    },
    [width, x],
  );

  const goTo = useCallback(
    (target: number, animate = true) => {
      const clamped = Math.min(maxIndex, Math.max(minIndex, target));
      setDirection(clamped >= page ? 1 : -1);
      setPage(clamped);
      settle(clamped, animate);
      onMonthChange?.(toDateOnly(monthFromIndex(clamped)));
    },
    [maxIndex, minIndex, onMonthChange, page, settle],
  );

  // Re-anchor whenever the track is remeasured — rotation and split view both
  // land here. `page` is deliberately not a dependency: a page change settles
  // itself, animated, and re-running this would snap mid-spring.
  const pageRef = useRef(page);
  pageRef.current = page;
  useEffect(() => {
    settle(pageRef.current, false);
  }, [settle]);

  // Follow a controlled `month` prop without fighting the user's own swipes.
  const controlledIndex = month ? monthIndexOf(parseDay(month) ?? anchor) : null;
  const goToRef = useRef(goTo);
  goToRef.current = goTo;
  useEffect(() => {
    if (controlledIndex !== null && controlledIndex !== pageRef.current) goToRef.current(controlledIndex);
  }, [controlledIndex]);

  const commit = useCallback(
    (target: number) => {
      haptics.select();
      setDirection(target >= page ? 1 : -1);
      setPage(target);
      onMonthChange?.(toDateOnly(monthFromIndex(target)));
    },
    [onMonthChange, page],
  );

  const slop = t.spacing.md;
  const pan = useMemo(() => {
    const originIndex = origin.current;
    return Gesture.Pan()
      .enabled(width > 0)
      .activeOffsetX([-slop, slop])
      .failOffsetY([-slop * 2, slop * 2])
      .onUpdate((event) => {
        x.value = -(page - originIndex) * width + event.translationX;
      })
      .onEnd((event) => {
        const projected = page - (event.translationX + event.velocityX * VELOCITY_WEIGHT) / width;
        // One page per gesture: a fast flick shouldn't skip three months.
        const stepped = Math.min(page + 1, Math.max(page - 1, Math.round(projected)));
        const target = Math.min(maxIndex, Math.max(minIndex, stepped));
        x.value = withSpring(-(target - originIndex) * width, PAGE_SPRING);
        // Committing on release rather than on settle keeps the header in step
        // with the thumb; the incoming page is already mounted at its final
        // coordinate, so nothing moves when React catches up.
        if (target !== page) runOnJS(commit)(target);
      });
  }, [commit, maxIndex, minIndex, page, slop, width, x]);

  const trackStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));

  /* ----- selection ------------------------------------------------------- */

  const selectedKeys = useMemo(
    () =>
      mode === 'range'
        ? { single: null, start: range?.start ?? null, end: range?.end ?? null }
        : { single: value, start: null, end: null },
    [mode, range?.end, range?.start, value],
  );

  const isDisabled = useCallback(
    (cell: DayCell) => {
      if (minDate && cell.key < minDate) return true;
      if (maxDate && cell.key > maxDate) return true;
      return isDateDisabled?.(cell.key) ?? false;
    },
    [isDateDisabled, maxDate, minDate],
  );

  const handlePress = useCallback(
    (cell: DayCell) => {
      const cellIndex = monthIndexOf(cell.date);
      if (cellIndex !== page) goTo(cellIndex);

      if (mode === 'range') {
        const start = range?.start ?? null;
        const end = range?.end ?? null;
        if (!start || end || cell.key < start) {
          haptics.select();
          onRangeChange?.({ start: cell.key, end: null });
          return;
        }
        // Second tap closes the window — the moment the range means something.
        haptics.success();
        onRangeChange?.({ start, end: cell.key });
        return;
      }

      haptics.select();
      onChange?.(cell.key);
    },
    [goTo, mode, onChange, onRangeChange, page, range?.end, range?.start],
  );

  /* ----- geometry -------------------------------------------------------- */

  const onTrackLayout = useCallback((event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    setWidth((prev) => (Math.abs(prev - next) < 1 ? prev : next));
  }, []);

  const cellSize = width > 0 ? Math.floor(width / COLUMNS) : 0;
  const discSize = Math.max(0, cellSize - t.spacing.sm);
  const dotRow = t.spacing.xs;
  const gridHeight = (cellSize + dotRow) * ROWS;

  const pages = [page - 1, page, page + 1];
  const monthLabel = format(monthFromIndex(page), 'MMMM yyyy');

  const weekdays = useMemo(() => {
    const first = startOfWeek(new Date(), { weekStartsOn: firstDayOfWeek });
    return Array.from({ length: COLUMNS }, (_, i) => addDays(first, i));
  }, [firstDayOfWeek]);

  return (
    <View style={style} testID={testID}>
      <Row gap="sm" style={{ paddingBottom: t.spacing.sm }}>
        <IconButton
          icon="chevron-back"
          accessibilityLabel="Previous month"
          size="sm"
          tone="neutral"
          disabled={page <= minIndex}
          onPress={() => goTo(page - 1)}
        />

        <View style={[styles.title, { height: t.type.title3.lineHeight ?? t.spacing.xl }]}>
          <Animated.View
            key={monthLabel}
            entering={
              direction > 0
                ? FadeInRight.duration(t.motion.duration.base)
                : FadeInLeft.duration(t.motion.duration.base)
            }
            exiting={
              direction > 0
                ? FadeOutLeft.duration(t.motion.duration.fast)
                : FadeOutRight.duration(t.motion.duration.fast)
            }
            style={[StyleSheet.absoluteFill, styles.center]}
          >
            <Text variant="title3" accessibilityRole="header" numberOfLines={1}>
              {monthLabel}
            </Text>
          </Animated.View>
        </View>

        <IconButton
          icon="chevron-forward"
          accessibilityLabel="Next month"
          size="sm"
          tone="neutral"
          disabled={page >= maxIndex}
          onPress={() => goTo(page + 1)}
        />
      </Row>

      {showTodayShortcut && page !== todayIndex ? (
        <Animated.View
          entering={FadeIn.duration(t.motion.duration.fast)}
          style={[styles.center, { paddingBottom: t.spacing.sm }]}
        >
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={`Jump to ${format(today, 'MMMM yyyy')}`}
            haptic="tap"
            onPress={() => goTo(todayIndex)}
            pressScale="small"
            style={{
              paddingHorizontal: t.spacing.md,
              paddingVertical: t.spacing.xxs,
              borderRadius: t.radius.pill,
              backgroundColor: t.color.primarySoft,
            }}
          >
            <Text variant="caption" color="onPrimarySoft">
              Back to today
            </Text>
          </Touchable>
        </Animated.View>
      ) : null}

      <Row
        style={{
          paddingBottom: t.spacing.xs,
          // Match the grid's floored width so the letters sit over their columns.
          width: cellSize > 0 ? cellSize * COLUMNS : undefined,
          alignSelf: 'center',
        }}
      >
        {weekdays.map((day) => (
          <View key={day.getDay()} style={styles.weekday}>
            <Text variant="caption" color="textTertiary" accessibilityLabel={WEEKDAY_LONG[day.getDay()]}>
              {format(day, 'EEEEE')}
            </Text>
          </View>
        ))}
      </Row>

      <GestureDetector gesture={pan}>
        <View style={styles.clip} onLayout={onTrackLayout}>
          <Animated.View style={[{ height: gridHeight }, trackStyle]}>
            {width > 0
              ? pages.map((index) => (
                  <View
                    key={index}
                    style={[
                      styles.page,
                      { left: (index - origin.current) * width, width },
                    ]}
                    // Only the visible month should be reachable by a swipe gesture.
                    importantForAccessibility={index === page ? 'yes' : 'no-hide-descendants'}
                  >
                    <MonthPage
                      monthIndex={index}
                      cellSize={cellSize}
                      discSize={discSize}
                      dotRow={dotRow}
                      firstDayOfWeek={firstDayOfWeek}
                      today={today}
                      showTodayRing={showTodayRing}
                      selectedKeys={selectedKeys}
                      marks={marks}
                      isDisabled={isDisabled}
                      onPress={handlePress}
                    />
                  </View>
                ))
              : null}
          </Animated.View>
        </View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1 },
  weekday: { flex: 1, alignItems: 'center' },
  clip: { overflow: 'hidden' },
  page: { position: 'absolute', top: 0 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', alignSelf: 'center' },
  cell: { alignItems: 'center', justifyContent: 'flex-start' },
  discBox: { alignItems: 'center', justifyContent: 'center' },
  disc: { position: 'absolute' },
  rangeBar: { position: 'absolute' },
  dots: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
});

export default Calendar;
