/**
 * Petal — MedicineCard.
 *
 * A prescription, said the way a person needs to hear it at 7am: what it is,
 * how much, when the next one is, and — before anything else — whether it goes
 * with food. That last flag lives on the card rather than in the instructions
 * because getting it wrong is the difference between a dose that works and a
 * dose that comes straight back up.
 *
 * Three deliberate choices:
 *
 *   · **The countdown is live.** It reads the shared 30-second clock the RBAC
 *     layer already runs, so "in 2 hours" becomes "due now" on its own rather
 *     than at the next navigation.
 *   · **Adherence is a ring, not a percentage in a corner.** A number needs
 *     reading; an arc is understood in peripheral vision, which is all this card
 *     gets on a busy screen.
 *   · **The refill nudge is inside the card, not a separate banner.** It is a
 *     fact about *this* medicine, and a banner floating above three cards can't
 *     say which one it means.
 */

import React, { useMemo, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import type { Medicine, MedicineForm, MedicineFrequency } from '@/data/types';
import { PetStatusPill, type PetStatusChip } from '@/features/pets/PetCard';
import { formatClock, formatTimeOfDay, friendlyDate, relativeTime, toDate } from '@/lib/date';
import { joinWithAnd, plural, possessive } from '@/lib/format';
import { useNow } from '@/rbac/usePermission';
import { useTheme, type Theme } from '@/theme';
import {
  Button,
  Column,
  Icon,
  IconButton,
  ProgressRing,
  Row,
  Surface,
  Text,
  Touchable,
  type IconName,
} from '@/ui';

/* -------------------------------------------------------------------- types */

export type MedicineCardProps = {
  medicine: Medicine;
  petName: string;
  /** 0–1 over the adherence window. Omit to hide the ring entirely. */
  adherence?: number | null;
  /** Doses given and expected *today*, for the line under the name. */
  today?: { given: number; expected: number };
  /** The next scheduled slot. The screen owns the maths so the card can't drift. */
  nextDoseAt?: Date | null;
  /** Doses at or below which the refill nudge appears. */
  refillThreshold?: number;

  onPress?: () => void;
  /** Owner-only (`medicine.edit`) — omit for caregivers rather than disabling. */
  onEdit?: () => void;
  onRefill?: () => void;
  /** Dose controls live here, outside the card's own tap target. */
  footer?: ReactNode;

  index?: number;
  animate?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export type MedicineFormMeta = { label: string; icon: IconName };

/* ---------------------------------------------------------------- constants */

const STAGGER_CAP = 8;

/** Below this the refill nudge appears on the card. */
const DEFAULT_REFILL_THRESHOLD = 5;

/**
 * One glyph per dosage form. Shared with the medicine editor so the icon a
 * person picked is the icon they see on the card afterwards.
 */
export const MEDICINE_FORM_META: Record<MedicineForm, MedicineFormMeta> = {
  tablet: { label: 'Tablet', icon: 'ellipse-outline' },
  capsule: { label: 'Capsule', icon: 'egg-outline' },
  liquid: { label: 'Liquid', icon: 'flask-outline' },
  injection: { label: 'Injection', icon: 'medical-outline' },
  topical: { label: 'Topical', icon: 'hand-left-outline' },
  drops: { label: 'Drops', icon: 'eyedrop-outline' },
  chew: { label: 'Chew', icon: 'nutrition-outline' },
  inhaler: { label: 'Inhaler', icon: 'cloud-outline' },
};

/** Plain-language frequency, and how many doses a day it implies. */
export const MEDICINE_FREQUENCY_META: Record<
  MedicineFrequency,
  { label: string; short: string; perDay: number }
> = {
  daily: { label: 'Once a day', short: 'Daily', perDay: 1 },
  twiceDaily: { label: 'Twice a day', short: 'Twice daily', perDay: 2 },
  threeTimesDaily: { label: 'Three times a day', short: '3× daily', perDay: 3 },
  everyOtherDay: { label: 'Every other day', short: 'Alternate days', perDay: 0.5 },
  weekly: { label: 'Once a week', short: 'Weekly', perDay: 1 / 7 },
  monthly: { label: 'Once a month', short: 'Monthly', perDay: 1 / 30 },
  asNeeded: { label: 'Only when needed', short: 'As needed', perDay: 0 },
};

/* ------------------------------------------------------------------ helpers */

/** Doses a day this frequency implies. `0` means "there is no schedule". */
export function dosesPerDay(frequency: MedicineFrequency): number {
  return MEDICINE_FREQUENCY_META[frequency].perDay;
}

/** True once the course has an end date that has already passed. */
export function isCourseFinished(medicine: Medicine, now: Date = new Date()): boolean {
  const end = toDate(medicine.endsAt);
  if (!end) return false;
  // `endsAt` is a calendar day, so the course runs to the end of it.
  return end.getTime() + 24 * 60 * 60 * 1000 <= now.getTime();
}

function ringTone(rate: number): 'success' | 'primary' | 'warning' {
  if (rate >= 0.9) return 'success';
  if (rate >= 0.7) return 'primary';
  return 'warning';
}

function statusChip(medicine: Medicine, finished: boolean): PetStatusChip | null {
  if (finished) return { id: 'finished', label: 'Course finished', icon: 'checkmark-done', tone: 'neutral' };
  if (!medicine.active) return { id: 'paused', label: 'Paused', icon: 'pause-circle-outline', tone: 'neutral' };
  if (medicine.frequency === 'asNeeded') {
    return { id: 'prn', label: 'As needed', icon: 'hand-right-outline', tone: 'info' };
  }
  return null;
}

function wellSkin(t: Theme, muted: boolean): { fill: string; ink: string } {
  return muted
    ? { fill: t.color.surfaceAlt, ink: t.color.textSecondary }
    : { fill: t.color.primarySoft, ink: t.color.onPrimarySoft };
}

/* ---------------------------------------------------------------- component */

export function MedicineCard({
  medicine,
  petName,
  adherence = null,
  today,
  nextDoseAt = null,
  refillThreshold = DEFAULT_REFILL_THRESHOLD,
  onPress,
  onEdit,
  onRefill,
  footer,
  index = 0,
  animate = true,
  style,
  testID,
}: MedicineCardProps) {
  const t = useTheme();
  const now = useNow();

  const form = MEDICINE_FORM_META[medicine.form];
  const frequency = MEDICINE_FREQUENCY_META[medicine.frequency];
  const finished = isCourseFinished(medicine, now);
  const muted = finished || !medicine.active;
  const skin = wellSkin(t, muted);
  const chip = statusChip(medicine, finished);

  const times = medicine.timesOfDay.map(formatTimeOfDay);
  const remaining = medicine.remainingDoses;
  const lowStock = !muted && remaining !== null && remaining <= refillThreshold;

  /** "in 2 hours · 6pm", or "due now" once the slot has passed. */
  const countdown = useMemo(() => {
    if (muted || !nextDoseAt) return null;
    const overdue = nextDoseAt.getTime() <= now.getTime();
    return {
      overdue,
      label: overdue ? 'Due now' : `Next ${relativeTime(nextDoseAt, now)}`,
      clock: formatClock(nextDoseAt),
    };
  }, [muted, nextDoseAt, now]);

  const spoken = useMemo(
    () =>
      [
        `${medicine.name} for ${petName}`,
        medicine.dosage,
        frequency.label,
        medicine.withFood ? 'Give with food' : null,
        countdown ? `${countdown.label} at ${countdown.clock}` : null,
        remaining !== null ? `${plural(remaining, 'dose')} left in the pack` : null,
        adherence !== null ? `${Math.round(adherence * 100)} percent of doses given` : null,
      ]
        .filter(Boolean)
        .join('. '),
    [adherence, countdown, frequency.label, medicine, petName, remaining],
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

  const header = (
    <Row gap="md" align="start">
      <View
        style={[
          styles.center,
          {
            width: t.spacing.huge,
            height: t.spacing.huge,
            borderRadius: t.radius.lg,
            backgroundColor: skin.fill,
          },
        ]}
      >
        <Icon name={form.icon} size="lg" color={skin.ink} />
      </View>

      <Column flex gap="hair">
        <Row gap="sm" align="start">
          <Text
            variant="title3"
            color={muted ? 'textSecondary' : 'text'}
            numberOfLines={1}
            style={styles.grow}
          >
            {medicine.name}
          </Text>
          {chip ? <PetStatusPill chip={chip} size="sm" /> : null}
        </Row>

        <Text variant="subhead" color="textSecondary" numberOfLines={2}>
          {medicine.dosage} · {frequency.label}
        </Text>

        {times.length > 0 && !muted ? (
          <Text variant="caption" color="textTertiary" numberOfLines={1}>
            {joinWithAnd(times)}
          </Text>
        ) : null}
      </Column>

      {adherence !== null && !muted ? (
        <ProgressRing
          value={adherence}
          size="sm"
          tone={ringTone(adherence)}
          showValue
          accessibilityLabel={`${Math.round(adherence * 100)} percent of ${possessive(petName)} ${medicine.name} doses given`}
        />
      ) : null}
    </Row>
  );

  return (
    <Animated.View entering={entering} style={style} testID={testID}>
      <Surface
        variant="surface"
        elevation={1}
        radius="xxl"
        padding="none"
        style={[styles.clip, muted ? { opacity: t.opacity.muted } : null]}
      >
        {onPress ? (
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={spoken}
            accessibilityHint={`Opens ${possessive(petName)} ${medicine.name}.`}
            haptic="tap"
            onPress={onPress}
            pressScale="large"
            dim
            style={{ padding: t.spacing.base }}
          >
            {header}
          </Touchable>
        ) : (
          <View
            accessible
            accessibilityRole="text"
            accessibilityLabel={spoken}
            style={{ padding: t.spacing.base }}
          >
            {header}
          </View>
        )}

        <Column style={{ paddingHorizontal: t.spacing.base, gap: t.spacing.sm }}>
          {medicine.withFood && !muted ? (
            <Row
              gap="sm"
              style={{
                paddingVertical: t.spacing.sm,
                paddingHorizontal: t.spacing.md,
                borderRadius: t.radius.md,
                backgroundColor: t.color.accentSoft,
              }}
            >
              <Icon name="restaurant" size="sm" color="onAccentSoft" />
              <Text variant="subheadStrong" color="onAccentSoft" style={styles.grow}>
                Give with food
              </Text>
            </Row>
          ) : null}

          {countdown ? (
            <Row gap="sm">
              <Icon
                name={countdown.overdue ? 'alert-circle' : 'time-outline'}
                size="sm"
                color={countdown.overdue ? 'warning' : 'textTertiary'}
              />
              <Text
                variant="subhead"
                color={countdown.overdue ? 'onWarningSoft' : 'textSecondary'}
                numberOfLines={1}
                style={styles.grow}
              >
                {countdown.label} · {countdown.clock}
              </Text>
              {today && today.expected > 0 ? (
                <Text variant="caption" color="textTertiary" tabular numberOfLines={1}>
                  {today.given}/{today.expected} today
                </Text>
              ) : null}
            </Row>
          ) : null}

          {finished && medicine.endsAt ? (
            <Text variant="caption" color="textTertiary">
              Course ended {friendlyDate(medicine.endsAt).toLowerCase()}.
            </Text>
          ) : null}

          {medicine.instructions ? (
            <Text variant="caption" color="textTertiary" numberOfLines={3}>
              {medicine.instructions}
            </Text>
          ) : null}

          {lowStock ? (
            <Row
              gap="sm"
              style={{
                paddingVertical: t.spacing.sm,
                paddingHorizontal: t.spacing.md,
                borderRadius: t.radius.md,
                backgroundColor: t.color.warningSoft,
              }}
            >
              <Icon name="alert-circle-outline" size="sm" color="onWarningSoft" />
              <Text variant="footnote" color="onWarningSoft" style={styles.grow}>
                {remaining === 0
                  ? `The pack is empty — ${petName} needs a refill today.`
                  : `${plural(remaining ?? 0, 'dose')} left. Worth a refill this week.`}
              </Text>
              {onRefill ? (
                <Button
                  label="Refill"
                  onPress={onRefill}
                  variant="secondary"
                  size="sm"
                  accessibilityHint={`Records a new pack of ${medicine.name}.`}
                />
              ) : null}
            </Row>
          ) : null}
        </Column>

        {footer || onEdit ? (
          <Row
            gap="sm"
            align="center"
            style={{ padding: t.spacing.base, paddingTop: t.spacing.md }}
          >
            <View style={styles.grow}>{footer}</View>
            {onEdit ? (
              <IconButton
                icon="pencil"
                accessibilityLabel={`Edit ${medicine.name}`}
                accessibilityHint="Opens the prescription editor."
                variant="tonal"
                tone="neutral"
                size="sm"
                onPress={onEdit}
              />
            ) : null}
          </Row>
        ) : (
          <View style={{ height: t.spacing.base }} />
        )}
      </Surface>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  grow: { flex: 1 },
  clip: { overflow: 'hidden' },
});

export default MedicineCard;
