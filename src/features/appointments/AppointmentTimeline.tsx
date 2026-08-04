/**
 * Petal — AppointmentTimeline.
 *
 * A list of vet visits grouped the way people actually think about them, which
 * is different in each direction:
 *
 *   · **Forwards, in weeks.** "This week / Next week / Later" is how anyone
 *     plans. A heading per calendar date would be a wall of dates for a list
 *     that usually holds three items.
 *   · **Backwards, in months.** History is remembered by month — "that was in
 *     March" — so the past groups by month, with the two most recent months
 *     named in plain words rather than dated.
 *
 * The grouping functions are exported because the screen above needs the same
 * counts for its filter chips and empty states, and two implementations of
 * "this week" would eventually disagree.
 *
 * Entrance is a single stagger counted across *all* groups, capped at eight, so
 * a long history cascades in for a beat and then simply appears.
 */

import { addWeeks, endOfWeek, format, isSameMonth, startOfWeek, subMonths } from 'date-fns';
import React, { useMemo } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import type { Appointment, AppointmentStatus, ID, PetDocument, Vaccination } from '@/data/types';
import { toDate } from '@/lib/date';
import { useNow } from '@/rbac/usePermission';
import { useTheme } from '@/theme';
import { Column, SectionHeader } from '@/ui';

import { AppointmentCard } from './AppointmentCard';

/* -------------------------------------------------------------------- types */

export type AppointmentDirection = 'upcoming' | 'past';

export type AppointmentGroup = {
  id: string;
  title: string;
  items: Appointment[];
};

export type AppointmentTimelineProps = {
  appointments: readonly Appointment[];
  petName: string;
  direction: AppointmentDirection;
  /** Shared clock. Defaults to the app's tick so group boundaries stay honest. */
  now?: Date;

  onOpen?: (appointment: Appointment) => void;
  openDisabledReason?: string;
  onStatusChange?: (appointment: Appointment, status: AppointmentStatus) => void;
  statusDisabledReason?: string;

  /** Already-fetched linked records, passed straight through to each card. */
  documents?: readonly PetDocument[];
  vaccinations?: readonly Vaccination[];
  onOpenDocument?: (documentId: ID) => void;
  onOpenVaccination?: (vaccinationId: ID) => void;

  /** Ids to leave out — the one already sitting in the screen's hero. */
  excludeIds?: readonly ID[];
  /** Off when the list re-renders behind a filter change rather than arriving. */
  animate?: boolean;

  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/** Beyond this the cascade reads as lag rather than choreography. */
const STAGGER_CAP = 8;

/** Weeks start on Monday here — "this week" ending on Sunday is what people mean. */
const WEEK_OPTIONS = { weekStartsOn: 1 } as const;

/* ------------------------------------------------------------------ helpers */

function timeOf(appointment: Appointment): number {
  return toDate(appointment.at)?.getTime() ?? 0;
}

/** Chronological, nearest first. */
export function groupUpcoming(
  appointments: readonly Appointment[],
  now: Date = new Date(),
): AppointmentGroup[] {
  const thisWeekEnds = endOfWeek(now, WEEK_OPTIONS).getTime();
  const nextWeekEnds = endOfWeek(addWeeks(startOfWeek(now, WEEK_OPTIONS), 1), WEEK_OPTIONS).getTime();

  const buckets: AppointmentGroup[] = [
    { id: 'this-week', title: 'This week', items: [] },
    { id: 'next-week', title: 'Next week', items: [] },
    { id: 'later', title: 'Later', items: [] },
  ];

  for (const appointment of [...appointments].sort((a, b) => timeOf(a) - timeOf(b))) {
    const at = timeOf(appointment);
    const bucket = at <= thisWeekEnds ? buckets[0] : at <= nextWeekEnds ? buckets[1] : buckets[2];
    bucket?.items.push(appointment);
  }

  return buckets.filter((group) => group.items.length > 0);
}

/** Reverse-chronological, newest first, one group per calendar month. */
export function groupPast(
  appointments: readonly Appointment[],
  now: Date = new Date(),
): AppointmentGroup[] {
  const lastMonth = subMonths(now, 1);
  const groups: AppointmentGroup[] = [];
  const index = new Map<string, AppointmentGroup>();

  for (const appointment of [...appointments].sort((a, b) => timeOf(b) - timeOf(a))) {
    const date = toDate(appointment.at);
    if (!date) continue;

    const id = format(date, 'yyyy-MM');
    let group = index.get(id);
    if (!group) {
      group = { id, title: monthTitle(date, now, lastMonth), items: [] };
      index.set(id, group);
      groups.push(group);
    }
    group.items.push(appointment);
  }

  return groups;
}

/**
 * The two most recent months read as words. Once you're further back than that,
 * "November 2025" is more useful than counting months in your head — and the
 * year is dropped while it's still the obvious one.
 */
function monthTitle(date: Date, now: Date, lastMonth: Date): string {
  if (isSameMonth(date, now)) return 'This month';
  if (isSameMonth(date, lastMonth)) return 'Last month';
  return date.getFullYear() === now.getFullYear()
    ? format(date, 'MMMM')
    : format(date, 'MMMM yyyy');
}

/* ---------------------------------------------------------------- component */

export function AppointmentTimeline({
  appointments,
  petName,
  direction,
  now: nowProp,
  onOpen,
  openDisabledReason,
  onStatusChange,
  statusDisabledReason,
  documents,
  vaccinations,
  onOpenDocument,
  onOpenVaccination,
  excludeIds,
  animate = true,
  style,
  testID,
}: AppointmentTimelineProps) {
  const t = useTheme();
  const clock = useNow();
  const now = nowProp ?? clock;

  const groups = useMemo(() => {
    const excluded = new Set(excludeIds ?? []);
    const rows = appointments.filter((row) => !excluded.has(row.id));
    return direction === 'upcoming' ? groupUpcoming(rows, now) : groupPast(rows, now);
  }, [appointments, direction, excludeIds, now]);

  if (groups.length === 0) return null;

  let position = 0;

  return (
    <View style={style} testID={testID}>
      {groups.map((group, groupIndex) => (
        <Column key={group.id} gap="md">
          <SectionHeader
            title={group.title}
            count={group.items.length}
            variant="overline"
            first={groupIndex === 0}
          />
          {group.items.map((appointment) => {
            const index = position;
            position += 1;
            return (
              <Animated.View
                key={appointment.id}
                entering={
                  animate
                    ? t.reduceMotion
                      ? FadeIn.duration(t.motion.duration.base).delay(
                          Math.min(index, STAGGER_CAP) * t.motion.stagger.tight,
                        )
                      : FadeInDown.duration(t.motion.duration.slow)
                          .delay(Math.min(index, STAGGER_CAP) * t.motion.stagger.base)
                          .easing(t.motion.easing.decelerate)
                    : undefined
                }
              >
                <AppointmentCard
                  appointment={appointment}
                  petName={petName}
                  now={now}
                  onPress={onOpen ? () => onOpen(appointment) : undefined}
                  pressDisabledReason={openDisabledReason}
                  onStatusChange={
                    onStatusChange ? (status) => onStatusChange(appointment, status) : undefined
                  }
                  statusDisabledReason={statusDisabledReason}
                  documents={documents}
                  vaccinations={vaccinations}
                  onOpenDocument={onOpenDocument}
                  onOpenVaccination={onOpenVaccination}
                />
              </Animated.View>
            );
          })}
        </Column>
      ))}
    </View>
  );
}

export default AppointmentTimeline;
