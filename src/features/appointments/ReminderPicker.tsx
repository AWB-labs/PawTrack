/**
 * Petal — ReminderPicker.
 *
 * Four offsets as chips, and — the part that matters — a live preview of the
 * notification they produce.
 *
 * Reminder settings are normally a promise you can't check: you tick "1 day
 * before", and weeks later something arrives that you either wanted or didn't.
 * Showing the actual title, the actual body and the actual arrival time turns
 * the choice into something you can verify at the moment you make it, which is
 * also the moment you can still change it.
 *
 * The preview copy deliberately mirrors `lib/notifications`' first appointment
 * variant. It isn't the *only* wording the app will use — the real reminders
 * rotate their phrasing so week three doesn't read like week one — but it is a
 * true example rather than an invented one.
 *
 * Offsets that have already elapsed are kept selectable and called out instead
 * of being silently dropped: an owner booking for this afternoon should be told
 * why the "1 day before" they just tapped will never fire.
 */

import { differenceInCalendarDays } from 'date-fns';
import React, { useCallback, useMemo } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { countdownLabel, formatClock, formatDay, WEEKDAY_LONG } from '@/lib/date';
import { joinWithAnd, possessive } from '@/lib/format';
import { useNow } from '@/rbac/usePermission';
import { useTheme } from '@/theme';
import { Button, Chip, Column, Icon, Row, Surface, Text } from '@/ui';

/* -------------------------------------------------------------------- types */

export type ReminderOption = {
  /** Minutes before the appointment. Matches `Appointment.reminderOffsets`. */
  minutes: number;
  label: string;
  /** Announced to screen readers, where "1 wk" isn't enough. */
  accessibilityLabel: string;
};

export type ReminderPickerProps = {
  value: readonly number[];
  onChange: (offsets: number[]) => void;
  /** The appointment's time. Without it the preview explains what's missing. */
  at?: Date | null;
  petName: string;
  /** The visit's reason, so the previewed body is the real one. */
  reason?: string;
  clinic?: string | null;
  label?: string;
  helper?: string;
  disabled?: boolean;
  /** Renders the chips dimmed but tappable — wire the host to `explain()`. */
  disabledReason?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

const MINUTE = 1;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Four offsets, chosen for what each one is *for*: a week to arrange the day
 * off, a day to remember the carrier, two hours to leave in time, half an hour
 * to actually stand up.
 */
export const REMINDER_OPTIONS: readonly ReminderOption[] = [
  { minutes: 7 * DAY, label: '1 week', accessibilityLabel: 'One week before' },
  { minutes: DAY, label: '1 day', accessibilityLabel: 'One day before' },
  { minutes: 2 * HOUR, label: '2 hours', accessibilityLabel: 'Two hours before' },
  { minutes: 30 * MINUTE, label: '30 min', accessibilityLabel: 'Thirty minutes before' },
];

/** What most people end up choosing, offered as one tap when nothing is set. */
export const DEFAULT_REMINDER_OFFSETS: readonly number[] = [DAY, 2 * HOUR];

/* ------------------------------------------------------------------ helpers */

/** `[1440, 120]` → `"1 day & 2 hours before"`. Used in summaries elsewhere too. */
export function describeReminderOffsets(offsets: readonly number[]): string {
  if (offsets.length === 0) return 'No reminders';
  const labels = [...offsets]
    .sort((a, b) => b - a)
    .map((minutes) => REMINDER_OPTIONS.find((option) => option.minutes === minutes)?.label ?? countdownLabel(minutes).replace(/^in /, ''));
  return `${joinWithAnd(labels)} before`;
}

/**
 * Reads correctly from either end of a sentence — "3:00pm tomorrow" — so the
 * previewed body never has to capitalise it or fall back to "Today 3:00pm".
 */
function whenPhrase(at: Date, from: Date): string {
  const clock = formatClock(at);
  const days = differenceInCalendarDays(at, from);
  if (days === 0) return `${clock} today`;
  if (days === 1) return `${clock} tomorrow`;
  if (days > 1 && days < 7) return `${clock} on ${WEEKDAY_LONG[at.getDay()] ?? formatDay(at, from)}`;
  return `${clock} on ${formatDay(at, from)}`;
}

/* ---------------------------------------------------------------- component */

export function ReminderPicker({
  value,
  onChange,
  at = null,
  petName,
  reason,
  clinic,
  label = 'Reminders',
  helper,
  disabled = false,
  disabledReason,
  style,
  testID,
}: ReminderPickerProps) {
  const t = useTheme();
  const now = useNow();

  const selected = useMemo(() => new Set(value), [value]);

  const toggle = useCallback(
    (minutes: number) => {
      const next = new Set(value);
      if (next.has(minutes)) next.delete(minutes);
      else next.add(minutes);
      onChange([...next].sort((a, b) => b - a));
    },
    [onChange, value],
  );

  /** The reminder that arrives first — the one worth previewing. */
  const previewed = useMemo(() => {
    if (value.length === 0) return null;
    const sorted = [...value].sort((a, b) => b - a);
    if (!at) return { minutes: sorted[0] ?? 0, fireAt: null };
    const live = sorted.find((minutes) => at.getTime() - minutes * 60_000 > now.getTime());
    const minutes = live ?? sorted[sorted.length - 1] ?? 0;
    return { minutes, fireAt: new Date(at.getTime() - minutes * 60_000) };
  }, [at, now, value]);

  const elapsedCount = useMemo(() => {
    if (!at) return 0;
    return value.filter((minutes) => at.getTime() - minutes * 60_000 <= now.getTime()).length;
  }, [at, now, value]);

  const summary = useMemo(() => describeReminderOffsets(value), [value]);

  return (
    <Column gap="md" style={style} testID={testID}>
      <Column gap="hair">
        <Row justify="between" gap="sm">
          <Text variant="subheadStrong">{label}</Text>
          <Text variant="caption" color="textTertiary" numberOfLines={1}>
            {summary}
          </Text>
        </Row>
        {helper ? (
          <Text variant="footnote" color="textSecondary">
            {helper}
          </Text>
        ) : null}
      </Column>

      <Row gap="sm" wrap>
        {REMINDER_OPTIONS.map((option) => (
          <Chip
            key={option.minutes}
            label={option.label}
            selected={selected.has(option.minutes)}
            onPress={() => toggle(option.minutes)}
            disabled={disabled}
            disabledReason={disabledReason}
            accessibilityLabel={option.accessibilityLabel}
            accessibilityHint={
              selected.has(option.minutes) ? 'Turns this reminder off.' : 'Turns this reminder on.'
            }
          />
        ))}
      </Row>

      {elapsedCount > 0 && previewed ? (
        <Row gap="xs" align="start">
          <Icon name="information-circle-outline" size="xs" color="onWarningSoft" />
          <Text variant="caption" color="onWarningSoft" style={{ flex: 1 }}>
            {elapsedCount === value.length
              ? 'This visit is too soon for any of these — they’d have needed to fire already.'
              : `${elapsedCount} of these would have fired already, so they’ll be skipped.`}
          </Text>
        </Row>
      ) : null}

      {previewed ? (
        <Animated.View
          // Keyed on the previewed offset so a new choice arrives rather than
          // mutating in place — the change is the whole point of the preview.
          key={`preview-${previewed.minutes}`}
          entering={
            t.reduceMotion
              ? FadeIn.duration(t.motion.duration.base)
              : FadeInDown.duration(t.motion.duration.base).easing(t.motion.easing.decelerate)
          }
        >
          <NotificationPreview
            minutes={previewed.minutes}
            fireAt={previewed.fireAt}
            at={at}
            petName={petName}
            reason={reason}
            clinic={clinic}
          />
        </Animated.View>
      ) : (
        <Animated.View entering={FadeIn.duration(t.motion.duration.base)}>
          <Surface
            variant="surfaceAlt"
            radius="lg"
            padding="base"
            border
            style={{ gap: t.spacing.sm }}
          >
            <Row gap="sm">
              <Icon name="notifications-off-outline" size="sm" color="textTertiary" />
              <Text variant="subheadStrong" color="textSecondary" style={{ flex: 1 }}>
                No reminders set
              </Text>
            </Row>
            <Text variant="footnote" color="textTertiary">
              {`${possessive(petName)} visit will live on this screen and nowhere else. A nudge the day before is usually enough.`}
            </Text>
            <Button
              label="Use the usual two"
              variant="ghost"
              size="sm"
              leftIcon="notifications-outline"
              disabled={disabled}
              disabledReason={disabledReason}
              onPress={() => onChange([...DEFAULT_REMINDER_OFFSETS])}
              accessibilityHint="Turns on a reminder one day and two hours before."
            />
          </Surface>
        </Animated.View>
      )}
    </Column>
  );
}

/* ------------------------------------------------------------ the preview */

type NotificationPreviewProps = {
  minutes: number;
  fireAt: Date | null;
  at: Date | null;
  petName: string;
  reason?: string;
  clinic?: string | null;
};

/**
 * A notification, drawn the way the OS will draw it. The icon well, the app
 * name and the arrival stamp are what make it read as "a thing that will
 * happen" rather than "a description of a setting".
 */
function NotificationPreview({
  minutes,
  fireAt,
  at,
  petName,
  reason,
  clinic,
}: NotificationPreviewProps) {
  const t = useTheme();
  const well = t.spacing.xxl;

  const subject = reason?.trim() ? reason.trim() : 'Vet visit';
  const title = `${possessive(petName)} appointment is ${countdownLabel(minutes)}`;
  const body =
    at && fireAt
      ? `${subject}${clinic ? ` at ${clinic}` : ''} — ${whenPhrase(at, fireAt)}.`
      : `${subject}${clinic ? ` at ${clinic}` : ''} — we’ll fill in the time once you pick one.`;

  const arrival = fireAt
    ? `Arrives ${formatDay(fireAt)} · ${formatClock(fireAt)}`
    : 'Pick a date and time to see when this lands';

  return (
    <Surface
      variant="surfaceAlt"
      elevation={1}
      radius="lg"
      padding="md"
      style={{ gap: t.spacing.sm }}
      accessibilityRole="summary"
      accessibilityLabel={`Reminder preview. ${title}. ${body} ${arrival}.`}
    >
      <Row gap="sm" align="start">
        <View
          style={{
            width: well,
            height: well,
            borderRadius: t.radius.sm,
            backgroundColor: t.color.primarySoft,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="paw" size="sm" color="onPrimarySoft" />
        </View>

        <Column flex gap="hair">
          <Row justify="between" gap="sm">
            <Text variant="overline" color="textTertiary" numberOfLines={1} style={{ flexShrink: 1 }}>
              Petal
            </Text>
            <Text variant="caption" color="textFaint" numberOfLines={1} tabular>
              {countdownLabel(minutes).replace(/^in /, '')} before
            </Text>
          </Row>
          <Text variant="subheadStrong" numberOfLines={2}>
            {title}
          </Text>
          <Text variant="footnote" color="textSecondary" numberOfLines={3}>
            {body}
          </Text>
        </Column>
      </Row>

      <Row gap="xs">
        <Icon name="time-outline" size="xs" color="textTertiary" />
        <Text variant="caption" color="textTertiary" numberOfLines={1}>
          {arrival}
        </Text>
      </Row>
    </Surface>
  );
}

export default ReminderPicker;
