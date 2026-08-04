/**
 * Petal — VaccinationTimeline.
 *
 * The schedule view: everything owed and everything done, on one rail with the
 * present moment drawn between them.
 *
 * **Time flows upward.** Furthest-future at the top, the now marker in the
 * middle, most-recent-past just below it, oldest at the bottom. That ordering is
 * the reason the marker is worth having: the two rows nobody scrolls past — the
 * next dose owed and the last dose given — end up pressed against it, and the
 * rail either side reads as "later" and "already done" without a word of
 * explanation.
 *
 * Two smaller decisions:
 *
 *   · **A record appears exactly once.** A vaccination row carries both a given
 *     date and a next-due date, so it could plausibly sit on either side. It
 *     goes above the line while anything is owed on it and below once nothing
 *     is — which is also how an owner thinks about it.
 *   · **Group headers are computed here, not by the rail.** Timeline dedupes
 *     `dayLabel` for us, but we suppress the header on the first history row on
 *     purpose: the now marker is already that row's heading, and stacking a year
 *     label on top of it reads as two dividers arguing.
 */

import React, { useMemo } from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';

import type { Vaccination, VaccinationStatus } from '@/data/types';
import { dueLabel, formatDay, toDate } from '@/lib/date';
import { possessive } from '@/lib/format';
import { EmptyState, Timeline, type TimelineEntry, type TimelineState, type TimelineTone } from '@/ui';
import { EmptyVaccinations } from '@/ui/illustrations';
import { useTheme } from '@/theme';
import { DUE_SOON_DAYS, daysUntilDue, vaccinationStatus } from './VaccinationCard';

/* -------------------------------------------------------------------- types */

export type VaccinationTimelineFilter = 'all' | 'upcoming' | 'history';

export type VaccinationTimelineProps = {
  vaccinations: readonly Vaccination[];
  /** Injected so the whole screen shares one clock. */
  now?: Date;
  filter?: VaccinationTimelineFilter;
  onSelect?: (vaccination: Vaccination) => void;
  /** Rows look disabled and explain themselves — the RBAC affordance. */
  disabledReason?: string;
  /** Warms the empty copy. */
  petName?: string;
  /** Shown when the filter empties the rail. */
  onAdd?: () => void;
  addLabel?: string;
  addDisabledReason?: string;
  dense?: boolean;
  animate?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

type Bucket = {
  vaccination: Vaccination;
  /** Milliseconds — the rail's sort key, and it is not the same field for both halves. */
  at: number;
  group: string;
};

/* ------------------------------------------------------------------ helpers */

const TONE_BY_STATUS: Record<VaccinationStatus, TimelineTone> = {
  overdue: 'danger',
  dueSoon: 'warning',
  scheduled: 'info',
  upToDate: 'success',
  unknown: 'neutral',
};

const STATE_BY_STATUS: Record<VaccinationStatus, TimelineState> = {
  overdue: 'missed',
  dueSoon: 'due',
  scheduled: 'upcoming',
  upToDate: 'done',
  unknown: 'skipped',
};

/** The header a future row sits under. Ordered top-down: far, near, late. */
function upcomingGroup(days: number): string {
  if (days < 0) return 'Overdue';
  if (days <= DUE_SOON_DAYS) return 'Next few weeks';
  return 'Further ahead';
}

/* ---------------------------------------------------------------- component */

export function VaccinationTimeline({
  vaccinations,
  now,
  filter = 'all',
  onSelect,
  disabledReason,
  petName,
  onAdd,
  addLabel = 'Add a vaccination',
  addDisabledReason,
  dense = false,
  animate = true,
  style,
  testID,
}: VaccinationTimelineProps) {
  const t = useTheme();
  const clock = useMemo(() => now ?? new Date(), [now]);

  const { entries, nowIndex } = useMemo(() => {
    const upcoming: Bucket[] = [];
    const history: Bucket[] = [];

    for (const vaccination of vaccinations) {
      const status = vaccinationStatus(vaccination, clock);
      const owed = status === 'overdue' || status === 'dueSoon' || status === 'scheduled';
      const due = toDate(vaccination.dueAt);
      const given = toDate(vaccination.administeredAt);

      if (owed && due) {
        upcoming.push({
          vaccination,
          at: due.getTime(),
          group: upcomingGroup(daysUntilDue(vaccination, clock) ?? 0),
        });
        continue;
      }

      const anchor = given ?? due;
      history.push({
        vaccination,
        at: anchor?.getTime() ?? 0,
        group: anchor ? String(anchor.getFullYear()) : 'No date on file',
      });
    }

    // Furthest future first, so the soonest lands against the now marker.
    upcoming.sort((a, b) => b.at - a.at);
    // Most recent first, so the last thing that happened lands against it too.
    history.sort((a, b) => b.at - a.at);

    const show =
      filter === 'upcoming'
        ? { upcoming, history: [] as Bucket[] }
        : filter === 'history'
          ? { upcoming: [] as Bucket[], history }
          : { upcoming, history };

    const rows: TimelineEntry[] = [];

    const push = (bucket: Bucket, previous: Bucket | undefined, suppressGroup: boolean) => {
      const { vaccination } = bucket;
      const status = vaccinationStatus(vaccination, clock);
      const given = vaccination.administeredAt;
      const owed = status === 'overdue' || status === 'dueSoon' || status === 'scheduled';

      const subtitle = owed
        ? [
            given ? `Last given ${formatDay(given, clock)}` : 'Never given',
            vaccination.clinic ?? vaccination.vetName,
          ]
            .filter((part): part is string => Boolean(part))
            .join(' · ')
        : [
            vaccination.vetName ?? vaccination.clinic,
            vaccination.dueAt ? `next ${dueLabel(vaccination.dueAt, clock)}` : 'no booster needed',
          ]
            .filter((part): part is string => Boolean(part))
            .join(' · ');

      const anchor = owed ? vaccination.dueAt : (given ?? vaccination.dueAt);

      rows.push({
        id: vaccination.id,
        title: vaccination.name,
        subtitle,
        meta: anchor ? formatDay(anchor, clock) : undefined,
        icon: vaccination.core ? 'shield-checkmark-outline' : 'shield-outline',
        tone: TONE_BY_STATUS[status],
        state: STATE_BY_STATUS[status],
        dayLabel: suppressGroup || previous?.group === bucket.group ? undefined : bucket.group,
        onPress: onSelect ? () => onSelect(vaccination) : undefined,
        disabledReason,
        accessibilityLabel: `${vaccination.name}. ${vaccination.core ? 'Core' : 'Non-core'}. ${subtitle}.`,
        accessibilityHint: onSelect ? 'Opens this record.' : undefined,
      });
    };

    show.upcoming.forEach((bucket, index) => push(bucket, show.upcoming[index - 1], false));
    show.history.forEach((bucket, index) =>
      // The now marker is the first history row's heading; a year label stacked
      // on top of it would be a second divider saying the same thing. Only the
      // combined rail draws that marker, so only it suppresses the label.
      push(bucket, show.history[index - 1], index === 0 && filter === 'all'),
    );

    return { entries: rows, nowIndex: show.upcoming.length };
  }, [clock, disabledReason, filter, onSelect, vaccinations]);

  if (entries.length === 0) {
    const copy =
      filter === 'upcoming'
        ? {
            headline: 'Nothing owed right now',
            body: petName
              ? `${possessive(petName)} boosters are all in date. We'll nudge you a month before the next one.`
              : 'Every booster is in date. We’ll nudge you a month before the next one.',
          }
        : filter === 'history'
          ? {
              headline: 'No doses on record yet',
              body: petName
                ? `Once you add a shot ${petName} has already had, it'll live here for good.`
                : 'Once you add a shot that’s already been given, it’ll live here for good.',
            }
          : {
              headline: petName ? `No vaccinations on file for ${petName}` : 'No vaccinations on file',
              body: petName
                ? `Add ${possessive(petName)} first one and we'll track the due date so you don't have to.`
                : 'Add the first one and we’ll track the due date so you don’t have to.',
            };

    return (
      <EmptyState
        variant="compact"
        illustration={<EmptyVaccinations size={t.spacing.colossal * 2.2} />}
        headline={copy.headline}
        body={copy.body}
        action={
          onAdd
            ? {
                label: addLabel,
                icon: 'add',
                onPress: onAdd,
                disabledReason: addDisabledReason,
              }
            : undefined
        }
        style={style}
        testID={testID}
      />
    );
  }

  return (
    <Timeline
      entries={entries}
      nowIndex={filter === 'all' ? nowIndex : null}
      nowLabel="Today"
      dense={dense}
      animate={animate}
      style={style}
      testID={testID}
    />
  );
}

export default VaccinationTimeline;
