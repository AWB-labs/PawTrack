/**
 * Petal — LogMealSheet.
 *
 * Logging a meal is the single most repeated action in Petal, usually one-handed
 * with a dog already climbing the counter. So the sheet is built around one
 * sentence — *it happened exactly as planned* — and everything else is an
 * adjustment you only reach for when it didn't.
 *
 *   · **The scheduled path is one tap, at the top, in brand colour.** No
 *     stepper to confirm, no keyboard, no scroll. Everything below it is opt-in.
 *   · **Skipping is a first-class outcome, not a cancel.** A skipped meal is
 *     what a vet asks about, so it gets its own segment and its own reasons
 *     rather than being "didn't log it".
 *   · **Undo lives in the toast, not in a confirm.** The mutation is optimistic;
 *     asking "are you sure?" before a meal would cost more taps than it saves.
 *
 * The portion stepper's step size follows the unit — 10 g is a nudge, 10 cups is
 * a different animal — which is the difference between a stepper you hold and a
 * stepper you fight.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, LinearTransition } from 'react-native-reanimated';

import { useLogFeeding, useUndoFeedingLog } from '@/data/queries/useFeeding';
import type { FeedingLog, FeedingSchedule, ID, PortionUnit } from '@/data/types';
import { applyTimeOfDay, formatTimeOfDay, toTimeOfDay } from '@/lib/date';
import { formatPortion, portionUnitLabel, possessive } from '@/lib/format';
import haptics from '@/lib/haptics';
import { useTheme } from '@/theme';
import {
  Button,
  Chip,
  Column,
  Divider,
  Icon,
  Input,
  Row,
  Select,
  SegmentedControl,
  Sheet,
  SheetHeader,
  Stepper,
  Text,
  TextArea,
  TimeField,
  toast,
  Touchable,
  percentSnapPoints,
  type SelectOption,
  type Segment,
  type SheetController,
} from '@/ui';

/* -------------------------------------------------------------------- types */

export type MealOutcome = 'fed' | 'skipped';

export type LogMealSheetProps = {
  controller: SheetController;
  petId: ID;
  petName: string;
  /** Pre-fills everything. Null logs an unscheduled extra meal. */
  schedule?: FeedingSchedule | null;
  /** Fired after the adapter confirms — the screen owns any celebration. */
  onLogged?: (log: FeedingLog, outcome: MealOutcome) => void;
};

/* ---------------------------------------------------------------- constants */

/** Shared with the schedule editor so a portion is measured the same way twice. */
export const PORTION_UNIT_OPTIONS: SelectOption<PortionUnit>[] = [
  { value: 'g', label: 'Grams', description: 'Dry food weighed out', icon: 'scale-outline' },
  { value: 'ml', label: 'Millilitres', description: 'Milk, broth, liquid feed', icon: 'water-outline' },
  { value: 'cup', label: 'Cups', description: 'The scoop that lives in the bag', icon: 'cafe-outline' },
  { value: 'scoop', label: 'Scoops', description: 'Whatever your scoop holds', icon: 'ellipse-outline' },
  { value: 'can', label: 'Cans', description: 'Wet food, by the tin', icon: 'file-tray-outline' },
  { value: 'piece', label: 'Pieces', description: 'Chews, cubes, whole items', icon: 'apps-outline' },
];

const OUTCOMES: Segment<MealOutcome>[] = [
  { value: 'fed', label: 'Ate it', icon: 'checkmark-circle-outline' },
  { value: 'skipped', label: 'Skipped', icon: 'remove-circle-outline' },
];

/** The five reasons that cover almost every real skip. */
const SKIP_REASONS = [
  'Not hungry',
  'Already fed',
  'Off their food',
  'Vet’s orders',
  'We were out',
] as const;

/** Portions live at very different scales, so the nudge does too. */
export function portionStep(unit: PortionUnit): number {
  switch (unit) {
    case 'g':
    case 'ml':
      return 10;
    case 'cup':
    case 'scoop':
      return 0.25;
    case 'can':
      return 0.5;
    case 'piece':
    default:
      return 1;
  }
}

/** A sane ceiling per unit — 2 kg of kibble, or twenty of anything countable. */
export function portionMax(unit: PortionUnit): number {
  return unit === 'g' || unit === 'ml' ? 2000 : 20;
}

/* ---------------------------------------------------------------- component */

export function LogMealSheet({
  controller,
  petId,
  petName,
  schedule = null,
  onLogged,
}: LogMealSheetProps) {
  const t = useTheme();
  const logMeal = useLogFeeding(petId);
  const undoMeal = useUndoFeedingLog(petId);

  const [outcome, setOutcome] = useState<MealOutcome>('fed');
  const [portion, setPortion] = useState(schedule?.portion ?? 1);
  const [unit, setUnit] = useState<PortionUnit>(schedule?.unit ?? 'g');
  const [food, setFood] = useState(schedule?.foodName ?? '');
  const [time, setTime] = useState(() => toTimeOfDay(new Date()));
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');

  /** A fresh sheet every time it opens — a stale draft is worse than no draft. */
  const reset = useCallback(() => {
    setOutcome('fed');
    setPortion(schedule?.portion ?? 1);
    setUnit(schedule?.unit ?? 'g');
    setFood(schedule?.foodName ?? '');
    setTime(toTimeOfDay(new Date()));
    setReason(null);
    setNote('');
  }, [schedule]);

  /**
   * Reset on *arrival*, not on every index change — dragging the sheet from its
   * first stop to its second is still the same edit, and wiping the draft
   * halfway through one would be unforgivable.
   */
  const wasOpen = useRef(false);
  const handleChange = useCallback(
    (index: number) => {
      const open = index >= 0;
      if (open && !wasOpen.current) reset();
      wasOpen.current = open;
    },
    [reset],
  );

  const title = schedule ? `${possessive(petName)} ${schedule.label.toLowerCase()}` : `Feed ${petName}`;
  const scheduledPortion = schedule ? formatPortion(schedule.portion, schedule.unit) : null;
  const busy = logMeal.isPending;

  const at = useMemo(() => {
    const stamped = applyTimeOfDay(new Date(), time);
    return (stamped ?? new Date()).toISOString();
  }, [time]);

  const submit = useCallback(
    async (input: {
      portion: number;
      unit: PortionUnit;
      foodName: string;
      skipped: boolean;
      at: string;
      note: string | null;
    }) => {
      try {
        const log = await logMeal.mutateAsync({
          scheduleId: schedule?.id ?? null,
          at: input.at,
          foodName: input.foodName.trim() || 'food',
          portion: input.portion,
          unit: input.unit,
          skipped: input.skipped,
          note: input.note,
        });

        controller.close();
        if (input.skipped) {
          haptics.warn();
          toast.undo(
            `${petName} skipped this one`,
            () => {
              undoMeal.mutate({ logId: log.id, scheduleId: log.scheduleId, at: log.at });
            },
            {
              description: 'Noted — appetite is worth tracking, so we kept it on the record.',
              icon: 'remove-circle-outline',
              haptic: false,
            },
          );
        } else {
          haptics.success();
          toast.undo(
            `${formatPortion(input.portion, input.unit)} logged for ${petName} 🐾`,
            () => {
              undoMeal.mutate({ logId: log.id, scheduleId: log.scheduleId, at: log.at });
            },
            {
              description: `${input.foodName.trim() || 'Food'} · ${formatTimeOfDay(time)}`,
              haptic: false,
            },
          );
        }
        onLogged?.(log, input.skipped ? 'skipped' : 'fed');
      } catch {
        // `useLogFeeding` rolls the caches back and raises the error toast; the
        // sheet stays open so the draft isn't lost.
      }
    },
    [controller, logMeal, onLogged, petName, schedule, time, undoMeal],
  );

  const logAsScheduled = useCallback(() => {
    if (!schedule) return;
    void submit({
      portion: schedule.portion,
      unit: schedule.unit,
      foodName: schedule.foodName,
      skipped: false,
      at: new Date().toISOString(),
      note: null,
    });
  }, [schedule, submit]);

  const logAdjusted = useCallback(() => {
    const skipped = outcome === 'skipped';
    const detail = [skipped ? reason : null, note.trim() || null].filter(Boolean).join(' — ');
    void submit({
      portion: skipped ? 0 : portion,
      unit,
      foodName: food,
      skipped,
      at,
      note: detail.length > 0 ? detail : null,
    });
  }, [at, food, note, outcome, portion, reason, unit]);

  const step = portionStep(unit);
  const fed = outcome === 'fed';

  return (
    <Sheet
      controller={controller}
      snapPoints={percentSnapPoints(0.66, 0.94)}
      scrollable
      onChange={handleChange}
      contentStyle={{ gap: t.spacing.lg }}
      footer={
        <Button
          label={
            fed
              ? `Log ${formatPortion(portion, unit)}`
              : `Mark ${possessive(petName)} meal skipped`
          }
          onPress={logAdjusted}
          variant={fed ? 'primary' : 'secondary'}
          size="lg"
          fullWidth
          loading={busy}
          haptic="none"
          accessibilityHint={
            fed
              ? `Records ${formatPortion(portion, unit)} of ${food || 'food'} at ${formatTimeOfDay(time)}.`
              : 'Keeps the meal on the record as skipped, which is what a vet asks about.'
          }
        />
      }
    >
      <SheetHeader
        title={title}
        subtitle={
          schedule
            ? `Usually ${scheduledPortion} of ${schedule.foodName} at ${formatTimeOfDay(schedule.time)}`
            : 'An extra meal, outside the timetable.'
        }
        onClose={controller.close}
        leading={
          <View
            style={[
              styles.center,
              {
                width: t.spacing.huge,
                height: t.spacing.huge,
                borderRadius: t.radius.lg,
                backgroundColor: t.color.accentSoft,
              },
            ]}
          >
            <Icon name="restaurant" size="lg" color="onAccentSoft" />
          </View>
        }
      />

      {schedule ? (
        <Animated.View entering={t.reduceMotion ? FadeIn : FadeInDown.duration(t.motion.duration.base)}>
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={`Log it as scheduled. ${scheduledPortion} of ${schedule.foodName}, right now.`}
            accessibilityHint="One tap logs the meal exactly as planned."
            haptic="none"
            onPress={logAsScheduled}
            pressScale="medium"
            style={[
              t.elevation(1),
              t.glow(t.color.primary),
              {
                flexDirection: 'row',
                alignItems: 'center',
                gap: t.spacing.base,
                padding: t.spacing.base,
                borderRadius: t.radius.xl,
                backgroundColor: t.color.primary,
              },
            ]}
          >
            <View
              style={[
                styles.center,
                {
                  width: t.spacing.xxxl,
                  height: t.spacing.xxxl,
                  borderRadius: t.radius.pill,
                  backgroundColor: t.color.onPrimary,
                },
              ]}
            >
              <Icon name="checkmark" size="lg" color={t.color.primary} />
            </View>
            <Column flex gap="hair">
              <Text variant="title3" color={t.color.onPrimary} numberOfLines={1}>
                Log it as scheduled
              </Text>
              <Text variant="footnote" color={t.color.onPrimary} numberOfLines={1} style={styles.soft}>
                {scheduledPortion} of {schedule.foodName} · right now
              </Text>
            </Column>
          </Touchable>
        </Animated.View>
      ) : null}

      <Divider label={schedule ? 'or adjust it' : 'the details'} spacing={0} />

      <SegmentedControl
        segments={OUTCOMES}
        value={outcome}
        onChange={setOutcome}
        accessibilityLabel="What happened at this meal"
      />

      <Animated.View layout={LinearTransition.duration(t.motion.duration.base)} style={{ gap: t.spacing.lg }}>
        {fed ? (
          <Animated.View
            key="fed"
            entering={FadeIn.duration(t.motion.duration.base)}
            exiting={FadeOut.duration(t.motion.duration.fast)}
            style={{ gap: t.spacing.lg }}
          >
            <Column gap="sm">
              <Text variant="subheadStrong" color="textSecondary">
                How much went down?
              </Text>
              <Row gap="md" align="center">
                <Stepper
                  value={portion}
                  onChange={setPortion}
                  min={0}
                  max={portionMax(unit)}
                  step={step}
                  unit={portionUnitLabel(unit, portion)}
                  accessibilityLabel="Portion"
                  accessibilityHint="Hold to change it quickly."
                />
                <View style={styles.grow}>
                  <Select
                    value={unit}
                    onChange={setUnit}
                    options={PORTION_UNIT_OPTIONS}
                    label="Unit"
                    title="Measured in"
                    subtitle="Whatever you actually use at the bowl."
                  />
                </View>
              </Row>
            </Column>

            <Input
              value={food}
              onChangeText={setFood}
              label="Food"
              placeholder="Kibble, wet food, the good stuff"
              leadingIcon="nutrition-outline"
              clearable
              maxLength={60}
              showCounter={false}
              autoCapitalize="sentences"
            />
          </Animated.View>
        ) : (
          <Animated.View
            key="skipped"
            entering={FadeIn.duration(t.motion.duration.base)}
            exiting={FadeOut.duration(t.motion.duration.fast)}
            style={{ gap: t.spacing.sm }}
          >
            <Text variant="subheadStrong" color="textSecondary">
              Any idea why?
            </Text>
            <Row gap="sm" wrap>
              {SKIP_REASONS.map((option) => (
                <Chip
                  key={option}
                  label={option}
                  selected={reason === option}
                  onPress={() => setReason((current) => (current === option ? null : option))}
                  size="sm"
                  accessibilityHint={`Records "${option}" as the reason ${petName} didn't eat.`}
                />
              ))}
            </Row>
            <Text variant="caption" color="textTertiary">
              Two skipped meals in a row is worth a call to the vet — we&apos;ll keep count for you.
            </Text>
          </Animated.View>
        )}

        <TimeField
          value={time}
          onChange={setTime}
          label="When"
          title="What time was this?"
          helper="Defaults to now. Nudge it if you're catching up."
          minuteStep={5}
        />

        <TextArea
          value={note}
          onChangeText={setNote}
          label="Note"
          placeholder={`Anything worth remembering about ${possessive(petName)} appetite`}
          minRows={2}
          maxRows={5}
          maxLength={240}
        />
      </Animated.View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  grow: { flex: 1 },
  soft: { opacity: 0.86 },
});

export default LogMealSheet;
