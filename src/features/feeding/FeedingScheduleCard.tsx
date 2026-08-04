/**
 * Petal — FeedingScheduleCard.
 *
 * One scheduled meal, laid out in the order a person actually reads it: when,
 * what, how much, on which days, and whether it has happened yet. The clock sits
 * in its own gutter so a stack of these scans as a timetable rather than as a
 * list of paragraphs.
 *
 * Three things it is careful about:
 *
 *   · **A skipped meal is not a missing one.** Vets ask about appetite, so a
 *     skip gets the same weight as a logged meal in a different colour, never a
 *     blank row.
 *   · **The status pill lands rather than swaps.** Ticking a meal off is the
 *     app's most repeated reward; the pill springs in so the change reads as
 *     something that just happened.
 *   · **The footer sits outside the tap target.** A switch and three buttons
 *     inside one pressable card is how a tap lands on the wrong thing — and how
 *     VoiceOver loses them entirely, since an accessible container swallows its
 *     children.
 */

import React, { useMemo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';

import type { FeedingSchedule } from '@/data/types';
import { PetStatusPill, type PetStatusChip } from '@/features/pets/PetCard';
import {
  formatClock,
  formatTimeOfDay,
  normalizeWeekdays,
  timeSlotLabel,
  WEEKDAY_SHORT,
  weekdaysLabel,
} from '@/lib/date';
import { formatPortion, possessive } from '@/lib/format';
import { spring, useTheme, type Theme } from '@/theme';
import { Button, Column, Icon, IconButton, Row, Surface, Switch, Text, Touchable } from '@/ui';

/* -------------------------------------------------------------------- types */

/**
 * Where this meal stands *today*. `restDay` means the schedule simply doesn't
 * run today, which is a different fact from having been missed.
 */
export type MealStatus =
  | 'due'
  | 'overdue'
  | 'upcoming'
  | 'done'
  | 'skipped'
  | 'paused'
  | 'restDay';

export type FeedingScheduleCardProps = {
  schedule: FeedingSchedule;
  /** Every line of copy names the pet. */
  petName: string;
  status?: MealStatus;
  /** Who logged it — "Priya", or "you". Only read once the meal is settled. */
  loggedBy?: string | null;
  /** ISO timestamp of the log, for the "at 7:12am" half of the line. */
  loggedAt?: string | null;

  /** Opens the quick-log sheet. Omit and the body is inert. */
  onPress?: () => void;
  /** The one-tap affordance in the footer. */
  onLog?: () => void;
  logLabel?: string;
  /** Shown once the meal is settled, so a mistap is one tap from undone. */
  onUndo?: () => void;
  /** Needs `feeding.log`; pass a reason to disable-and-explain. */
  logDisabledReason?: string;

  onEdit?: () => void;
  onDelete?: () => void;
  onToggleActive?: (active: boolean) => void;
  /** Needs `feeding.schedule.edit`; covers edit, delete and the active toggle. */
  editDisabledReason?: string;

  /** Position in its list; drives the entrance stagger. */
  index?: number;
  animate?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export type WeekdayDotsProps = {
  /** `0`=Sunday … `6`=Saturday. Empty means every day. */
  days: readonly number[];
  /** Dimmed alongside a paused schedule. */
  muted?: boolean;
};

type StatusSkin = { chip: PetStatusChip; accent: string | undefined; dim: boolean };

/* ---------------------------------------------------------------- constants */

/** Past ~8 the cascade stops reading as choreography and starts as lag. */
const STAGGER_CAP = 8;

/* ------------------------------------------------------------------ helpers */

function statusSkin(t: Theme, status: MealStatus): StatusSkin {
  switch (status) {
    case 'done':
      return {
        chip: { id: 'done', label: 'Fed', icon: 'checkmark-circle', tone: 'success' },
        accent: t.color.success,
        dim: false,
      };
    case 'skipped':
      return {
        chip: { id: 'skipped', label: 'Skipped', icon: 'remove-circle', tone: 'warning' },
        accent: t.color.warning,
        dim: false,
      };
    case 'due':
      return {
        chip: { id: 'due', label: 'Due now', icon: 'notifications', tone: 'accent' },
        accent: t.color.accent,
        dim: false,
      };
    case 'overdue':
      return {
        chip: { id: 'overdue', label: 'Overdue', icon: 'alert-circle', tone: 'danger' },
        accent: t.color.danger,
        dim: false,
      };
    case 'paused':
      return {
        chip: { id: 'paused', label: 'Paused', icon: 'pause-circle-outline', tone: 'neutral' },
        accent: undefined,
        dim: true,
      };
    case 'restDay':
      return {
        chip: { id: 'restDay', label: 'Not today', icon: 'calendar-clear-outline', tone: 'neutral' },
        accent: undefined,
        dim: true,
      };
    case 'upcoming':
    default:
      return {
        chip: { id: 'upcoming', label: 'Coming up', icon: 'time-outline', tone: 'neutral' },
        accent: t.color.border,
        dim: false,
      };
  }
}

/** "Logged by Priya · 7:12am", degrading to whichever half we actually know. */
function loggedLine(status: MealStatus, by: string | null, at: string | null): string | null {
  if (status !== 'done' && status !== 'skipped') return null;
  const verb = status === 'done' ? 'Logged' : 'Marked skipped';
  const who = by ? `${verb} by ${by}` : verb;
  return at ? `${who} · ${formatClock(at)}` : who;
}

/* --------------------------------------------------------------- weekdays */

/**
 * Seven letters, filled on the days this meal runs. Announced as one phrase
 * ("Weekdays") rather than as seven letters — a screen reader spelling out
 * "S M T W T F S" is noise, not information.
 */
export function WeekdayDots({ days, muted = false }: WeekdayDotsProps) {
  const t = useTheme();
  const active = useMemo(() => new Set(normalizeWeekdays(days)), [days]);
  const box = t.spacing.lg;

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={weekdaysLabel(days)}
      style={[styles.row, { gap: t.spacing.hair }]}
    >
      {WEEKDAY_SHORT.map((name, index) => {
        const on = active.has(index);
        return (
          <View
            key={name}
            style={[
              styles.center,
              {
                width: box,
                height: box,
                borderRadius: t.radius.xs,
                backgroundColor: on ? t.color.primarySoft : t.color.surfaceAlt,
                opacity: muted ? t.opacity.muted : 1,
              },
            ]}
          >
            <Text
              variant="caption"
              color={on ? 'onPrimarySoft' : 'textFaint'}
              allowFontScaling={false}
            >
              {name.charAt(0)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/* ---------------------------------------------------------------- component */

export function FeedingScheduleCard({
  schedule,
  petName,
  status = 'upcoming',
  loggedBy = null,
  loggedAt = null,
  onPress,
  onLog,
  logLabel,
  onUndo,
  logDisabledReason,
  onEdit,
  onDelete,
  onToggleActive,
  editDisabledReason,
  index = 0,
  animate = true,
  style,
  testID,
}: FeedingScheduleCardProps) {
  const t = useTheme();
  const skin = statusSkin(t, status);

  const portion = formatPortion(schedule.portion, schedule.unit);
  const settled = status === 'done' || status === 'skipped';
  const footerNote = loggedLine(status, loggedBy, loggedAt);
  const meal = schedule.label.toLowerCase();

  const spoken = useMemo(
    () =>
      [
        `${schedule.label} for ${petName}`,
        formatTimeOfDay(schedule.time),
        `${portion} of ${schedule.foodName}`,
        weekdaysLabel(schedule.daysOfWeek),
        skin.chip.label,
        schedule.remindersOn ? 'Reminder on' : 'No reminder',
      ].join('. '),
    [petName, portion, schedule, skin.chip.label],
  );

  const entering = animate
    ? t.reduceMotion
      ? FadeIn.duration(t.motion.duration.base).delay(
          Math.min(index, STAGGER_CAP) * t.motion.stagger.tight,
        )
      : FadeIn.duration(t.motion.duration.slow)
          .delay(Math.min(index, STAGGER_CAP) * t.motion.stagger.base)
          .easing(t.motion.easing.decelerate)
    : undefined;

  const pillEntering = t.reduceMotion
    ? FadeIn.duration(t.motion.duration.fast)
    : ZoomIn.springify().damping(spring.snappy.damping).stiffness(spring.snappy.stiffness);

  const hasFooter = Boolean(onLog || onUndo || onToggleActive || onEdit || onDelete || footerNote);

  const body = (
    <Row gap="base" align="start">
      <Column style={{ width: t.spacing.giant + t.spacing.sm }} gap="hair">
        <Text variant="title3" color={skin.dim ? 'textTertiary' : 'text'} tabular numberOfLines={1}>
          {formatTimeOfDay(schedule.time)}
        </Text>
        <Text variant="caption" color="textTertiary" numberOfLines={1}>
          {timeSlotLabel(schedule.time)}
        </Text>
      </Column>

      <Column flex gap="xs">
        <Row gap="sm" align="start">
          <Text
            variant="headline"
            color={skin.dim ? 'textSecondary' : 'text'}
            numberOfLines={1}
            style={styles.grow}
          >
            {schedule.label}
          </Text>
          <Animated.View key={skin.chip.id} entering={pillEntering}>
            <PetStatusPill chip={skin.chip} size="sm" />
          </Animated.View>
        </Row>

        <Text variant="subhead" color="textSecondary" numberOfLines={2}>
          {portion} · {schedule.foodName}
        </Text>

        <Row gap="md" wrap style={{ paddingTop: t.spacing.hair }}>
          <WeekdayDots days={schedule.daysOfWeek} muted={skin.dim} />
          <Row gap="xxs">
            <Icon
              name={schedule.remindersOn ? 'notifications' : 'notifications-off-outline'}
              size="xs"
              color={schedule.remindersOn ? 'primaryText' : 'textTertiary'}
            />
            <Text
              variant="caption"
              color={schedule.remindersOn ? 'primaryText' : 'textTertiary'}
              numberOfLines={1}
            >
              {schedule.remindersOn ? 'Reminder on' : 'No reminder'}
            </Text>
          </Row>
        </Row>

        {schedule.notes ? (
          <Text variant="caption" color="textTertiary" numberOfLines={2}>
            {schedule.notes}
          </Text>
        ) : null}
      </Column>
    </Row>
  );

  return (
    <Animated.View entering={entering} style={style} testID={testID}>
      <Surface
        variant="surface"
        elevation={1}
        radius="xxl"
        padding="none"
        style={[styles.clipRow, skin.dim ? { opacity: t.opacity.muted } : null]}
      >
        {skin.accent ? (
          <View style={{ width: t.spacing.xxs, backgroundColor: skin.accent }} />
        ) : null}

        <Column flex>
          {onPress ? (
            <Touchable
              accessibilityRole="button"
              accessibilityLabel={spoken}
              accessibilityHint={`Opens the quick log for ${possessive(petName)} ${meal}.`}
              disabledReason={logDisabledReason}
              haptic="tap"
              onPress={onPress}
              pressScale="large"
              dim
              style={{ padding: t.spacing.base }}
            >
              {body}
            </Touchable>
          ) : (
            <View
              accessible
              accessibilityRole="text"
              accessibilityLabel={spoken}
              style={{ padding: t.spacing.base }}
            >
              {body}
            </View>
          )}

          {hasFooter ? (
            <>
              <View
                style={{
                  height: t.borderWidth.hairline,
                  marginHorizontal: t.spacing.base,
                  backgroundColor: t.color.divider,
                }}
              />
              <Row
                gap="sm"
                align="center"
                style={{ paddingHorizontal: t.spacing.base, paddingVertical: t.spacing.md }}
              >
                {onToggleActive ? (
                  <Row gap="sm" style={styles.grow}>
                    <Switch
                      value={schedule.active}
                      onValueChange={onToggleActive}
                      size="sm"
                      disabledReason={editDisabledReason}
                      accessibilityLabel={`${schedule.label} on the timetable`}
                      accessibilityHint={
                        schedule.active
                          ? `Pauses ${meal} without deleting it.`
                          : `Puts ${meal} back on the timetable.`
                      }
                    />
                    <Text variant="caption" color="textTertiary" numberOfLines={1} style={styles.grow}>
                      {schedule.active ? 'On the timetable' : 'Paused'}
                    </Text>
                  </Row>
                ) : footerNote ? (
                  <Text variant="caption" color="textTertiary" numberOfLines={2} style={styles.grow}>
                    {footerNote}
                  </Text>
                ) : (
                  <View style={styles.grow} />
                )}

                {onUndo && settled ? (
                  <Button
                    label="Undo"
                    onPress={onUndo}
                    variant="ghost"
                    size="sm"
                    leftIcon="arrow-undo-outline"
                    accessibilityHint={`Takes this back off ${possessive(petName)} day.`}
                  />
                ) : null}

                {onLog && !settled ? (
                  <Button
                    label={logLabel ?? 'Log it'}
                    onPress={onLog}
                    variant={status === 'due' || status === 'overdue' ? 'primary' : 'tonal'}
                    size="sm"
                    leftIcon="checkmark"
                    haptic="commit"
                    disabledReason={logDisabledReason}
                    accessibilityHint={`Logs ${portion} of ${schedule.foodName} for ${petName}.`}
                  />
                ) : null}

                {onEdit ? (
                  <IconButton
                    icon="pencil"
                    accessibilityLabel={`Edit ${meal}`}
                    accessibilityHint="Opens the schedule editor."
                    variant="tonal"
                    tone="neutral"
                    size="sm"
                    onPress={onEdit}
                    disabledReason={editDisabledReason}
                  />
                ) : null}

                {onDelete ? (
                  <IconButton
                    icon="trash-outline"
                    accessibilityLabel={`Delete ${meal}`}
                    accessibilityHint="Removes this mealtime from the timetable."
                    variant="tonal"
                    tone="danger"
                    size="sm"
                    onPress={onDelete}
                    disabledReason={editDisabledReason}
                  />
                ) : null}
              </Row>
            </>
          ) : null}
        </Column>
      </Surface>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  grow: { flex: 1 },
  clipRow: { overflow: 'hidden', flexDirection: 'row' },
});

export default FeedingScheduleCard;
