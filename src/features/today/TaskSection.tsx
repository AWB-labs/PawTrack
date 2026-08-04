/**
 * Petal — TaskSection.
 *
 * The day's shape: Overdue first, then Morning · Afternoon · Evening · Night,
 * then whatever is still ahead of you.
 *
 * Why time-of-day rather than one flat list: a household of three pets runs to
 * a dozen slots a day, and a flat list makes you *read* to find out whether
 * you're behind. Buckets turn that into a glance — an empty Morning at 11am
 * means the morning went fine, and it costs no ink to say so.
 *
 * Two details that matter more than they look:
 *
 *   · **The header sticks.** Scrolling through Evening while the header still
 *     says "Afternoon" is how you lose your place in a list you're acting on.
 *     `SectionHeader`'s own `sticky` treatment (opaque ground, hairline,
 *     full-bleed) is what makes that legible; this module only decides *which*
 *     header is showing and what it counts.
 *   · **Still-upcoming work is peeled off, not sorted in.** At 7am a whole day
 *     of tasks in Morning/Afternoon/Evening reads as a wall. `groupTasks` with
 *     `deferUpcoming` moves everything that hasn't come round yet into one quiet
 *     "Later today" group, so the top of the screen only ever holds what you
 *     could actually do right now. Looking at another day switches that off —
 *     tomorrow is *all* upcoming, and calling it "later today" would be a lie.
 */

import React, { type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import type { CareTask } from '@/data/types';
import { toDate } from '@/lib/date';
import { useTheme } from '@/theme';
import { Icon, Row, SectionHeader, Text, type BadgeTone, type IconName } from '@/ui';

/* -------------------------------------------------------------------- types */

export type TaskGroupId = 'overdue' | 'morning' | 'afternoon' | 'evening' | 'night' | 'later';

export type TaskGroup = {
  id: TaskGroupId;
  title: string;
  icon: IconName;
  tasks: CareTask[];
  /** Logged or skipped. */
  done: number;
  /** Still waiting on someone. */
  outstanding: number;
};

export type GroupTasksOptions = {
  /**
   * Peel not-yet-due work into the trailing "Later today" group. True only when
   * the screen is showing today.
   */
  deferUpcoming?: boolean;
};

export type TaskSectionHeaderProps = {
  group: TaskGroup;
  /** Opaque ground + hairline, for a header floating over the list. */
  sticky?: boolean;
  /** Drops the leading space — for the first header in a run. */
  first?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export type TaskSectionProps = TaskSectionHeaderProps & {
  children: ReactNode;
  /** Vertical rhythm between rows. */
  gap?: 'sm' | 'md';
};

/* ---------------------------------------------------------------- constants */

/** Bucket boundaries, in local hours. Evening starts when the light goes. */
const AFTERNOON_FROM = 12;
const EVENING_FROM = 17;
const NIGHT_FROM = 21;

type GroupMeta = { title: string; icon: IconName };

const META: Record<TaskGroupId, GroupMeta> = {
  overdue: { title: 'Overdue', icon: 'alert-circle-outline' },
  morning: { title: 'Morning', icon: 'sunny-outline' },
  afternoon: { title: 'Afternoon', icon: 'partly-sunny-outline' },
  evening: { title: 'Evening', icon: 'moon-outline' },
  night: { title: 'Night', icon: 'bed-outline' },
  later: { title: 'Later today', icon: 'time-outline' },
};

/** Reading order. Overdue leads because it's the only group that's a problem. */
const ORDER: readonly TaskGroupId[] = ['overdue', 'morning', 'afternoon', 'evening', 'night', 'later'];

/* ------------------------------------------------------------------ helpers */

function bucketFor(task: CareTask): TaskGroupId {
  const at = toDate(task.at);
  const hour = at ? at.getHours() : AFTERNOON_FROM;
  if (hour < AFTERNOON_FROM) return 'morning';
  if (hour < EVENING_FROM) return 'afternoon';
  if (hour < NIGHT_FROM) return 'evening';
  return 'night';
}

/**
 * Split a day's stream into the groups the screen renders. Empty groups are
 * dropped rather than shown as zeroes — "Evening (0)" is furniture.
 */
export function groupTasks(
  tasks: readonly CareTask[],
  options: GroupTasksOptions = {},
): TaskGroup[] {
  const buckets = new Map<TaskGroupId, CareTask[]>();

  for (const task of tasks) {
    const id =
      task.state === 'overdue'
        ? 'overdue'
        : options.deferUpcoming === true && task.state === 'upcoming'
          ? 'later'
          : bucketFor(task);
    const existing = buckets.get(id);
    if (existing) existing.push(task);
    else buckets.set(id, [task]);
  }

  const groups: TaskGroup[] = [];
  for (const id of ORDER) {
    const items = buckets.get(id);
    if (!items || items.length === 0) continue;
    const sorted = [...items].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const done = sorted.filter((task) => task.state === 'done' || task.state === 'skipped').length;
    groups.push({
      id,
      title: META[id].title,
      icon: META[id].icon,
      tasks: sorted,
      done,
      outstanding: sorted.length - done,
    });
  }

  return groups;
}

/** The one thing outside this file that needs to know a group is the bad one. */
export const isAlarming = (group: TaskGroup): boolean => group.id === 'overdue';

/* --------------------------------------------------------------- component */

/**
 * Rendered separately from its rows so a screen can hand it to a ScrollView's
 * `stickyHeaderIndices` — a sticky header has to be a direct child of the
 * scroller, which rules out wrapping the group in a single component.
 */
export function TaskSectionHeader({
  group,
  sticky = false,
  first = false,
  style,
  testID,
}: TaskSectionHeaderProps) {
  const alarming = isAlarming(group);
  const quiet = group.id === 'later';
  const clear = group.outstanding === 0;

  const countTone: BadgeTone = alarming ? 'danger' : quiet ? 'neutral' : 'primary';

  return (
    <SectionHeader
      title={group.title}
      variant={quiet ? 'overline' : 'title'}
      icon={group.icon}
      iconColor={alarming ? 'danger' : quiet ? 'textTertiary' : 'primaryText'}
      count={group.tasks.length}
      countTone={countTone}
      sticky={sticky}
      first={first}
      style={style}
      testID={testID}
      trailing={
        clear ? (
          <Row gap="xxs">
            <Icon name="checkmark-circle" size="xs" color="success" />
            <Text variant="caption" color="textTertiary">
              All done
            </Text>
          </Row>
        ) : (
          <Text variant="caption" color={alarming ? 'danger' : 'textTertiary'} tabular>
            {group.outstanding} left
          </Text>
        )
      }
    />
  );
}

/** Header plus rows, for the places that don't need the header to stick. */
export function TaskSection({
  group,
  sticky,
  first,
  children,
  gap = 'sm',
  style,
  testID,
}: TaskSectionProps) {
  const t = useTheme();

  return (
    <View style={style} testID={testID}>
      <TaskSectionHeader group={group} sticky={sticky} first={first} />
      <View style={{ gap: t.spacing[gap] }}>{children}</View>
    </View>
  );
}

export default TaskSection;
