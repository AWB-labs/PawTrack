/**
 * Petal — AdherencePanel.
 *
 * How well a course is actually being kept, over a week, a month or a quarter.
 *
 * The hard part here is tone. A number like "68%" is a judgement if you let it
 * be one, and the person reading it is usually the person already worried about
 * their pet. So:
 *
 *   · **Missed doses are counted, never coloured red.** The bars stay on brand
 *     and the shortfall shows as the gap between the fill and the track — the
 *     same information, without the chart shouting.
 *   · **The headline is a sentence, not a verdict.** "This one's been hard to
 *     keep up with" invites the next step; "poor adherence" invites closing the
 *     app.
 *   · **"Missed" is explained.** It means a slot passed with nothing logged,
 *     which is not the same as a deliberate skip, and a person shouldn't have to
 *     guess which bucket their forgetfulness landed in.
 *
 * The rate itself is never guessed at optimistically — see `useMedicine.ts`.
 * This is the one number in Petal that must not be wrong about medication.
 */

import React, { useMemo, useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { useAdherence } from '@/data/queries/useMedicine';
import type { AdherenceSummary, ID, Medicine } from '@/data/types';
import { friendlyDate, toDate, WEEKDAY_SHORT } from '@/lib/date';
import { formatPercent, plural, possessive } from '@/lib/format';
import { useTheme, type Theme } from '@/theme';
import {
  BarChart,
  Column,
  Divider,
  EmptyState,
  ErrorState,
  Icon,
  ProgressRing,
  Row,
  SegmentedControl,
  Surface,
  Text,
  type BarChartDatum,
  type Segment,
} from '@/ui';
import { EmptyMedicine } from '@/ui/illustrations';
import { ChartSkeleton } from '@/ui/skeletons/ContentSkeletons';

/* -------------------------------------------------------------------- types */

export type AdherencePanelProps = {
  petId: ID;
  petName: string;
  medicine: Medicine;
  /** Windows offered, in days. Defaults to a week, a month and a quarter. */
  windows?: readonly number[];
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

type Bucket = BarChartDatum & { expected: number };

/* ---------------------------------------------------------------- constants */

const DEFAULT_WINDOWS = [7, 30, 90] as const;

/** More bars than this on a phone and each one is a hairline. */
const MAX_BARS = 10;

/* ------------------------------------------------------------------ helpers */

/**
 * One bar per day while the days fit; beyond that, equal chunks so a quarter
 * still reads as ten shapes rather than ninety slivers.
 */
function bucketize(daily: AdherenceSummary['daily']): Bucket[] {
  if (daily.length === 0) return [];
  const chunk = Math.max(1, Math.ceil(daily.length / MAX_BARS));
  const buckets: Bucket[] = [];

  for (let start = 0; start < daily.length; start += chunk) {
    const slice = daily.slice(start, start + chunk);
    const first = slice[0];
    const last = slice[slice.length - 1];
    if (!first || !last) continue;

    const given = slice.reduce((sum, day) => sum + day.given, 0);
    const expected = slice.reduce((sum, day) => sum + day.expected, 0);
    const from = toDate(first.date);
    const to = toDate(last.date);

    const label =
      chunk === 1
        ? from
          ? WEEKDAY_SHORT[from.getDay()]
          : first.date
        : String(to ? to.getDate() : slice.length);

    buckets.push({
      key: first.date,
      label,
      value: given,
      target: expected,
      expected,
      accessibilityLabel:
        chunk === 1
          ? `${friendlyDate(first.date)}: ${given} of ${plural(expected, 'dose')} given`
          : `${friendlyDate(first.date)} to ${friendlyDate(last.date)}: ${given} of ${plural(expected, 'dose')} given`,
    });
  }

  return buckets;
}

/** Warm, factual, and never a grade. */
function verdict(petName: string, rate: number, windowDays: number): { headline: string; body: string } {
  const period = windowDays === 7 ? 'this week' : `over the last ${windowDays} days`;
  if (rate >= 1) {
    return {
      headline: 'Every dose, every time',
      body: `Not one missed ${period}. That is genuinely hard to do.`,
    };
  }
  if (rate >= 0.9) {
    return {
      headline: `${possessive(petName)} course is on track`,
      body: `Almost every dose landed ${period}.`,
    };
  }
  if (rate >= 0.7) {
    return {
      headline: 'A few doses have slipped',
      body: `Most got in ${period}. Reminders help more than willpower does.`,
    };
  }
  return {
    headline: 'This one’s been hard to keep up with',
    body: `Plenty were missed ${period}. Turning reminders on for it is usually the fix.`,
  };
}

function ringTone(rate: number): 'success' | 'primary' | 'warning' {
  if (rate >= 0.9) return 'success';
  if (rate >= 0.7) return 'primary';
  return 'warning';
}

function breakdownSkin(t: Theme, kind: 'given' | 'skipped' | 'missed'): string {
  if (kind === 'given') return t.color.success;
  if (kind === 'skipped') return t.color.warning;
  return t.color.borderStrong;
}

/* ---------------------------------------------------------------- component */

export function AdherencePanel({
  petId,
  petName,
  medicine,
  windows = DEFAULT_WINDOWS,
  style,
  testID,
}: AdherencePanelProps) {
  const t = useTheme();
  const [windowDays, setWindowDays] = useState<number>(windows[1] ?? windows[0] ?? 30);

  const query = useAdherence(petId, medicine.id, windowDays);
  const summary = query.data ?? null;

  const segments = useMemo<Segment<number>[]>(
    () =>
      windows.map((days) => ({
        value: days,
        label: days === 7 ? '7 days' : days === 30 ? '30 days' : `${days} days`,
        accessibilityLabel: `Last ${plural(days, 'day')}`,
      })),
    [windows],
  );

  const buckets = useMemo(() => (summary ? bucketize(summary.daily) : []), [summary]);

  const picker = (
    <SegmentedControl
      segments={segments}
      value={windowDays}
      onChange={setWindowDays}
      size="sm"
      accessibilityLabel="Adherence window"
    />
  );

  /* ---- states ----------------------------------------------------------- */

  if (query.isPending) {
    return (
      <Column gap="md" style={style} testID={testID}>
        {picker}
        <ChartSkeleton bars={7} />
      </Column>
    );
  }

  if (query.isError || !summary) {
    return (
      <Column gap="md" style={style} testID={testID}>
        {picker}
        <ErrorState
          error={query.error}
          title="We couldn’t work out the adherence"
          body={`Every dose you logged is still recorded — the sum just didn’t come back this time.`}
          onRetry={() => query.refetch()}
          variant="compact"
          frame
        />
      </Column>
    );
  }

  if (summary.expected === 0) {
    return (
      <Column gap="md" style={style} testID={testID}>
        {picker}
        <EmptyState
          variant="compact"
          frame
          illustration={<EmptyMedicine size={t.spacing.colossal * 2} />}
          headline="Nothing to measure yet"
          body={`No doses of ${medicine.name} were due in this window. Come back once ${petName} has a few under their belt.`}
        />
      </Column>
    );
  }

  /* ---- content ---------------------------------------------------------- */

  const words = verdict(petName, summary.rate, windowDays);
  const tone = ringTone(summary.rate);

  const breakdown: { kind: 'given' | 'skipped' | 'missed'; label: string; value: number }[] = [
    { kind: 'given', label: 'Given', value: summary.given },
    { kind: 'skipped', label: 'Skipped', value: summary.skipped },
    { kind: 'missed', label: 'Missed', value: summary.missed },
  ];

  return (
    <Column gap="md" style={style} testID={testID}>
      {picker}

      <Animated.View entering={FadeIn.duration(t.motion.duration.base)}>
        <Surface variant="surface" elevation={1} radius="xxl" padding="base" style={{ gap: t.spacing.lg }}>
          <Row gap="base" align="center">
            <ProgressRing
              value={summary.rate}
              size="lg"
              tone={tone}
              gradient={summary.rate >= 0.9}
              showValue
              accessibilityLabel={`${formatPercent(summary.rate)} of ${possessive(petName)} ${medicine.name} doses given over ${plural(windowDays, 'day')}`}
            />

            <Column flex gap="xs">
              <Text variant="title3" numberOfLines={2}>
                {words.headline}
              </Text>
              <Text variant="footnote" color="textSecondary">
                {words.body}
              </Text>
              <Row gap="xxs">
                <Icon
                  name={summary.streakDays > 0 ? 'flame' : 'flame-outline'}
                  size="xs"
                  color={summary.streakDays > 0 ? 'accentText' : 'textTertiary'}
                />
                <Text
                  variant="caption"
                  color={summary.streakDays > 0 ? 'accentText' : 'textTertiary'}
                  numberOfLines={1}
                >
                  {summary.streakDays > 0
                    ? `${plural(summary.streakDays, 'day')} in a row`
                    : 'Today can start a streak'}
                </Text>
              </Row>
            </Column>
          </Row>

          <Divider spacing={0} />

          <Row gap="md">
            {breakdown.map((entry) => (
              <Column key={entry.kind} flex gap="hair">
                <Row gap="xs">
                  <View
                    style={{
                      width: t.spacing.sm,
                      height: t.spacing.sm,
                      borderRadius: t.radius.pill,
                      backgroundColor: breakdownSkin(t, entry.kind),
                    }}
                  />
                  <Text variant="caption" color="textTertiary" numberOfLines={1}>
                    {entry.label}
                  </Text>
                </Row>
                <Text variant="metricSmall" tabular>
                  {entry.value}
                </Text>
              </Column>
            ))}
          </Row>

          <BarChart
            data={buckets}
            formatValue={(value) => String(value)}
            accessibilityLabel={`${medicine.name} doses given over the last ${plural(windowDays, 'day')}`}
          />

          <Text variant="caption" color="textTertiary">
            Each bar&apos;s full height is what was scheduled. “Missed” means the slot passed with
            nothing logged — different from a skip you decided on.
          </Text>
        </Surface>
      </Animated.View>
    </Column>
  );
}

export default AdherencePanel;
