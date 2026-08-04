/**
 * Petal — FeedingHistory.
 *
 * The record of what actually went in the bowl, and the one question the record
 * exists to answer: *is this pet eating normally?*
 *
 *   · **The week comes first.** Seven bars answer "are we on track" before any
 *     individual row is read. Tapping a bar reads that day back in words rather
 *     than opening a tooltip nobody can dismiss one-handed.
 *   · **Skipped meals are counted out loud.** Two in a week and the appetite
 *     note appears — stated as a fact with a next step, never as a telling-off,
 *     because the owner is usually already worried by the time they look.
 *   · **Days are the grouping, because days are how people remember.** "Was it
 *     Tuesday she went off her food?" is the question; a flat reverse-chronological
 *     list can't answer it.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';

import type { FeedingLog, FeedingSchedule, ID } from '@/data/types';
import {
  friendlyDate,
  formatClock,
  isSameLocalDay,
  lastNDays,
  normalizeWeekdays,
  toDate,
  toDateOnly,
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
} from '@/lib/date';
import { formatPortion, plural, possessive } from '@/lib/format';
import { useTheme } from '@/theme';
import {
  Banner,
  BarChart,
  Button,
  Column,
  EmptyState,
  ErrorState,
  ListRow,
  Row,
  SectionHeader,
  StatTile,
  Surface,
  Text,
  type BarChartDatum,
} from '@/ui';
import { EmptyFeeding } from '@/ui/illustrations';
import { SkeletonGroup } from '@/ui/Skeleton';
import { ChartSkeleton, ListRowSkeleton } from '@/ui/skeletons/ContentSkeletons';

/* -------------------------------------------------------------------- types */

export type FeedingHistoryProps = {
  petName: string;
  logs: readonly FeedingLog[];
  /** Used for the "expected meals" ceiling on each bar. */
  schedules?: readonly FeedingSchedule[];
  isPending?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** Empty-state action — usually "log the first meal". */
  onLogFirst?: () => void;
  /** Needs `feeding.log`; disables-and-explains the empty state's button. */
  logDisabledReason?: string;
  /** Turns a `loggedBy` id into a name. Falls back to "a caregiver". */
  resolveName?: (userId: ID) => string | null;
  /** Days shown before the "Show earlier" control appears. */
  initialDays?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

type DayGroup = { date: string; label: string; logs: FeedingLog[] };

/* ---------------------------------------------------------------- constants */

/** One week is the window a vet asks about, and the width a phone can show. */
const CHART_DAYS = 7;

/** Two skips inside the window is the point at which it stops being a blip. */
const APPETITE_THRESHOLD = 2;

const DEFAULT_DAYS_SHOWN = 5;

/* ------------------------------------------------------------------ helpers */

/** Meals this schedule expects on a given weekday. */
function expectedOn(schedules: readonly FeedingSchedule[], weekday: number): number {
  return schedules.filter(
    (schedule) => schedule.active && normalizeWeekdays(schedule.daysOfWeek).includes(weekday),
  ).length;
}

function groupByDay(logs: readonly FeedingLog[]): DayGroup[] {
  const buckets = new Map<string, FeedingLog[]>();
  for (const log of logs) {
    const at = toDate(log.at);
    if (!at) continue;
    const key = toDateOnly(at);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(log);
    else buckets.set(key, [log]);
  }

  return [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, rows]) => ({
      date,
      label: friendlyDate(date),
      logs: rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
    }));
}

/* ---------------------------------------------------------------- component */

export function FeedingHistory({
  petName,
  logs,
  schedules = [],
  isPending = false,
  error,
  onRetry,
  onLogFirst,
  logDisabledReason,
  resolveName,
  initialDays = DEFAULT_DAYS_SHOWN,
  style,
  testID,
}: FeedingHistoryProps) {
  const t = useTheme();
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const week = useMemo(() => lastNDays(CHART_DAYS), []);

  const chart = useMemo<BarChartDatum[]>(
    () =>
      week.map((date) => {
        const day = toDate(date);
        const weekday = day ? day.getDay() : 0;
        const onThisDay = logs.filter((log) => isSameLocalDay(log.at, date));
        const fed = onThisDay.filter((log) => !log.skipped).length;
        const target = Math.max(expectedOn(schedules, weekday), fed);
        const skipped = onThisDay.filter((log) => log.skipped).length;

        return {
          key: date,
          label: WEEKDAY_SHORT[weekday] ?? '—',
          value: fed,
          target,
          tone: skipped > 0 && fed === 0 ? 'warning' : 'primary',
          accessibilityLabel: `${WEEKDAY_LONG[weekday] ?? 'That day'}: ${fed} of ${plural(target, 'meal')}${
            skipped > 0 ? `, ${plural(skipped, 'skip')}` : ''
          }`,
        };
      }),
    [logs, schedules, week],
  );

  const weekTotals = useMemo(() => {
    const inWeek = logs.filter((log) => week.some((date) => isSameLocalDay(log.at, date)));
    const fed = inWeek.filter((log) => !log.skipped).length;
    const skipped = inWeek.length - fed;
    const expected = week.reduce((sum, date) => {
      const day = toDate(date);
      return sum + expectedOn(schedules, day ? day.getDay() : 0);
    }, 0);
    return { fed, skipped, expected };
  }, [logs, schedules, week]);

  const groups = useMemo(() => groupByDay(logs), [logs]);
  const visible = expanded ? groups : groups.slice(0, initialDays);

  const selection = useMemo(() => {
    if (!selectedDay) return null;
    const datum = chart.find((entry) => entry.key === selectedDay);
    if (!datum) return null;
    const day = toDate(selectedDay);
    const weekday = day ? day.getDay() : 0;
    const name = friendlyDate(selectedDay);
    const target = datum.target ?? 0;
    if (target === 0 && datum.value === 0) return `Nothing was scheduled on ${name.toLowerCase()}.`;
    if (datum.value >= target && target > 0) {
      return `${name}: every meal went down. ${WEEKDAY_LONG[weekday] ?? 'That day'} was a good one.`;
    }
    return `${name}: ${datum.value} of ${plural(target, 'meal')} logged.`;
  }, [chart, selectedDay]);

  const handleSelect = useCallback((datum: BarChartDatum) => {
    setSelectedDay((current) => (current === datum.key ? null : datum.key));
  }, []);

  const nameFor = useCallback(
    (userId: ID) => resolveName?.(userId) ?? 'a caregiver',
    [resolveName],
  );

  /* ---- states ----------------------------------------------------------- */

  if (isPending) {
    return (
      <SkeletonGroup label={`Loading ${possessive(petName)} meals`} gap="lg" style={style} testID={testID}>
        <ChartSkeleton bars={CHART_DAYS} />
        <ListRowSkeleton count={4} avatar />
      </SkeletonGroup>
    );
  }

  if (error) {
    return (
      <View style={style} testID={testID}>
        <ErrorState
          error={error}
          title="We couldn’t load the meal history"
          body={`Nothing you logged is lost — ${possessive(petName)} record just didn’t come back this time.`}
          onRetry={onRetry}
          variant="compact"
          frame
        />
      </View>
    );
  }

  if (logs.length === 0) {
    return (
      <View style={style} testID={testID}>
        <EmptyState
          variant="compact"
          frame
          illustration={<EmptyFeeding size={t.spacing.colossal * 2} />}
          headline="No meals logged yet"
          body={`Tick off ${possessive(petName)} first meal and this turns into an appetite record you can show a vet.`}
          action={
            onLogFirst
              ? {
                  label: `Log ${possessive(petName)} first meal`,
                  icon: 'restaurant-outline',
                  onPress: onLogFirst,
                  disabledReason: logDisabledReason,
                }
              : undefined
          }
        />
      </View>
    );
  }

  /* ---- content ---------------------------------------------------------- */

  return (
    <Animated.View
      layout={LinearTransition.duration(t.motion.duration.base)}
      style={[{ gap: t.spacing.lg }, style]}
      testID={testID}
    >
      <Surface variant="surface" elevation={1} radius="xxl" padding="base" style={{ gap: t.spacing.base }}>
        <Row justify="between" align="start" gap="md">
          <Column gap="hair" flex>
            <Text variant="overline" color="textTertiary">
              Last seven days
            </Text>
            <Text variant="title3" numberOfLines={2}>
              {weekTotals.expected > 0
                ? `${weekTotals.fed} of ${weekTotals.expected} meals logged`
                : `${plural(weekTotals.fed, 'meal')} logged`}
            </Text>
          </Column>
        </Row>

        <BarChart
          data={chart}
          selectedKey={selectedDay}
          onSelect={handleSelect}
          formatValue={(value) => String(value)}
          accessibilityLabel={`${possessive(petName)} meals over the last seven days`}
        />

        <Animated.View
          key={selection ?? 'hint'}
          entering={FadeIn.duration(t.motion.duration.fast)}
          layout={LinearTransition.duration(t.motion.duration.fast)}
        >
          <Text variant="footnote" color={selection ? 'textSecondary' : 'textTertiary'}>
            {selection ?? 'Tap a day to see how it went.'}
          </Text>
        </Animated.View>
      </Surface>

      <Row gap="md" align="stretch">
        <StatTile
          label="Meals logged"
          value={weekTotals.fed}
          size="sm"
          icon="restaurant-outline"
          iconColor="accentText"
          caption="in the last week"
        />
        <StatTile
          label="Skipped"
          value={weekTotals.skipped}
          size="sm"
          icon="remove-circle-outline"
          iconColor={weekTotals.skipped >= APPETITE_THRESHOLD ? 'onWarningSoft' : 'textTertiary'}
          caption={weekTotals.skipped === 0 ? 'clean sweep' : 'worth watching'}
        />
      </Row>

      {weekTotals.skipped >= APPETITE_THRESHOLD ? (
        <Banner
          tone="warning"
          icon="pulse-outline"
          title={`${petName} has skipped ${plural(weekTotals.skipped, 'meal')} this week`}
          message="A change in appetite is the first thing a vet asks about. Keep logging the skips — the pattern is the useful part."
        />
      ) : null}

      <Column gap="sm">
        {visible.map((group, groupIndex) => (
          <Animated.View
            key={group.date}
            entering={
              t.reduceMotion
                ? FadeIn.duration(t.motion.duration.base)
                : FadeIn.duration(t.motion.duration.slow)
                    .delay(Math.min(groupIndex, 8) * t.motion.stagger.base)
                    .easing(t.motion.easing.decelerate)
            }
          >
            <SectionHeader
              title={group.label}
              count={group.logs.length}
              countTone={group.logs.some((log) => log.skipped) ? 'warning' : 'neutral'}
              variant="overline"
              first={groupIndex === 0}
            />
            <Surface variant="surface" elevation={1} radius="xl" paddingX="base">
              {group.logs.map((log, index) => (
                <ListRow
                  key={log.id}
                  icon={log.skipped ? 'remove-circle-outline' : 'restaurant-outline'}
                  iconTone={log.skipped ? 'warning' : 'accent'}
                  title={log.skipped ? 'Skipped' : log.foodName}
                  subtitle={
                    log.skipped
                      ? (log.note ?? `${petName} didn’t eat this one`)
                      : formatPortion(log.portion, log.unit)
                  }
                  caption={`Logged by ${nameFor(log.loggedBy)}`}
                  value={formatClock(log.at)}
                  size="dense"
                  divider={index < group.logs.length - 1}
                />
              ))}
            </Surface>
          </Animated.View>
        ))}
      </Column>

      {groups.length > initialDays ? (
        <Row justify="center">
          <Button
            label={expanded ? 'Show less' : `Show ${groups.length - initialDays} earlier days`}
            onPress={() => setExpanded((current) => !current)}
            variant="ghost"
            size="sm"
            rightIcon={expanded ? 'chevron-up' : 'chevron-down'}
          />
        </Row>
      ) : null}
    </Animated.View>
  );
}

export default FeedingHistory;
