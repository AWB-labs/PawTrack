/**
 * Create or edit a mealtime.
 *
 * One screen serves both — a missing `id` means create — so the two can never
 * drift apart. What stops it feeling like a form:
 *
 *   · **It previews itself.** The card at the top is the *actual*
 *     `FeedingScheduleCard` the timetable will show, updating as you type. You
 *     are editing a thing, not filling in fields about a thing.
 *   · **The reminder shows its own words.** A toggle labelled "Reminders" tells
 *     you nothing; seeing "Buddy's breakfast time! 🐾 — 120 g of kibble, the bowl
 *     awaits" tells you exactly what your phone will say at 7am. (The copy bank
 *     rotates its phrasing day to day so week three doesn't read like week one;
 *     this is the canonical one.)
 *   · **Days are a row of seven targets, not a multi-select.** Three presets
 *     cover almost every real schedule, and the rest is one tap per day.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';

import {
  useDeleteFeedingSchedule,
  useFeedingSchedules,
  useSaveFeedingSchedule,
} from '@/data/queries/useFeeding';
import { usePet } from '@/data/queries/usePets';
import type { FeedingSchedule, PortionUnit } from '@/data/types';
import { FeedingScheduleCard } from '@/features/feeding/FeedingScheduleCard';
import {
  PORTION_UNIT_OPTIONS,
  portionMax,
  portionStep,
} from '@/features/feeding/LogMealSheet';
import {
  EVERY_DAY,
  formatTimeOfDay,
  normalizeWeekdays,
  timeSlotLabel,
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
  weekdaysLabel,
} from '@/lib/date';
import { toHref } from '@/lib/deeplinks';
import { formatPortion, portionUnitLabel, possessive } from '@/lib/format';
import haptics from '@/lib/haptics';
import { DENIAL_COPY, type DenialReason } from '@/rbac/permissions';
import { usePermission } from '@/rbac/usePermission';
import { useTheme } from '@/theme';
import {
  Button,
  Chip,
  Column,
  ConfirmSheet,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  Input,
  Row,
  Screen,
  ScreenHeader,
  SectionHeader,
  Select,
  Stepper,
  Surface,
  Switch,
  Text,
  TextArea,
  TimeField,
  toast,
  Touchable,
  useSheet,
} from '@/ui';
import { PermissionLocked } from '@/ui/illustrations';
import { SkeletonGroup } from '@/ui/Skeleton';
import { ListRowSkeleton } from '@/ui/skeletons/ContentSkeletons';

/* ---------------------------------------------------------------- constants */

/** The five names that cover nearly every household's mealtimes. */
const LABEL_SUGGESTIONS = ['Breakfast', 'Lunch', 'Dinner', 'Supper', 'Snack'] as const;

const DAY_PRESETS: { id: string; label: string; days: number[] }[] = [
  { id: 'daily', label: 'Every day', days: [...EVERY_DAY] },
  { id: 'weekdays', label: 'Weekdays', days: [1, 2, 3, 4, 5] },
  { id: 'weekends', label: 'Weekends', days: [0, 6] },
];

const MAX_LABEL = 24;
const MAX_FOOD = 60;
const MAX_NOTES = 200;

/* ------------------------------------------------------------------ helpers */

function denial(reason: DenialReason | null): { title: string; body: string } {
  return DENIAL_COPY[reason ?? 'not-granted'];
}

const sameDays = (a: readonly number[], b: readonly number[]): boolean =>
  normalizeWeekdays(a).join(',') === normalizeWeekdays(b).join(',');

/* --------------------------------------------------------------- day picker */

type DayPickerProps = {
  value: number[];
  onChange: (days: number[]) => void;
  disabled?: boolean;
};

/** Seven real targets. Each one is its own toggle, announced by full name. */
function DayPicker({ value, onChange, disabled = false }: DayPickerProps) {
  const t = useTheme();
  const selected = useMemo(() => new Set(value), [value]);

  const toggle = useCallback(
    (day: number) => {
      const next = selected.has(day) ? value.filter((entry) => entry !== day) : [...value, day];
      // A schedule with no days is a schedule that never runs; refuse the last one.
      if (next.length === 0) {
        haptics.warn();
        return;
      }
      haptics.select();
      onChange(next.sort((a, b) => a - b));
    },
    [onChange, selected, value],
  );

  return (
    <Row gap="xs">
      {WEEKDAY_SHORT.map((short, index) => {
        const on = selected.has(index);
        return (
          <Touchable
            key={short}
            accessibilityRole="checkbox"
            accessibilityLabel={WEEKDAY_LONG[index] ?? short}
            accessibilityState={{ checked: on, disabled }}
            disabled={disabled}
            haptic="none"
            onPress={() => toggle(index)}
            pressScale="small"
            style={{ flex: 1 }}
          >
            <View
              style={{
                minHeight: t.minTarget,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: t.radius.md,
                backgroundColor: on ? t.color.primary : t.color.surfaceAlt,
                borderWidth: t.borderWidth.hairline,
                borderColor: on ? t.color.primary : t.color.border,
              }}
            >
              <Text
                variant="captionStrong"
                color={on ? t.color.onPrimary : 'textSecondary'}
                allowFontScaling={false}
              >
                {short.charAt(0)}
              </Text>
            </View>
          </Touchable>
        );
      })}
    </Row>
  );
}

/* ---------------------------------------------------------------- component */

export default function FeedingScheduleFormScreen() {
  const t = useTheme();
  const router = useRouter();
  const { petId = '', id } = useLocalSearchParams<{ petId?: string; id?: string }>();

  const petQuery = usePet(petId);
  const pet = petQuery.data ?? null;
  const petName = pet?.name ?? 'your pet';

  const permission = usePermission('feeding.schedule.edit', petId);
  const schedulesQuery = useFeedingSchedules(permission.allowed ? petId : null);
  const saveSchedule = useSaveFeedingSchedule(petId);
  const deleteSchedule = useDeleteFeedingSchedule(petId);
  const deleteSheet = useSheet();

  const existing = useMemo(
    () => (id ? (schedulesQuery.data ?? []).find((row) => row.id === id) : undefined),
    [id, schedulesQuery.data],
  );

  /* ---- draft ------------------------------------------------------------ */

  const [label, setLabel] = useState('Breakfast');
  const [time, setTime] = useState('07:00');
  const [days, setDays] = useState<number[]>([...EVERY_DAY]);
  const [foodName, setFoodName] = useState('');
  const [portion, setPortion] = useState(100);
  const [unit, setUnit] = useState<PortionUnit>('g');
  const [remindersOn, setRemindersOn] = useState(true);
  const [active, setActive] = useState(true);
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<{ label?: string; food?: string }>({});

  /** Seed once, when the row arrives — later refetches must not stamp on edits. */
  const seeded = useRef(false);
  useEffect(() => {
    if (!existing || seeded.current) return;
    seeded.current = true;
    setLabel(existing.label);
    setTime(existing.time);
    setDays(normalizeWeekdays(existing.daysOfWeek));
    setFoodName(existing.foodName);
    setPortion(existing.portion);
    setUnit(existing.unit);
    setRemindersOn(existing.remindersOn);
    setActive(existing.active);
    setNotes(existing.notes ?? '');
  }, [existing]);

  const draft = useMemo<FeedingSchedule>(
    () => ({
      id: existing?.id ?? 'draft',
      petId,
      label: label.trim() || 'Mealtime',
      time,
      foodName: foodName.trim() || 'their food',
      portion,
      unit,
      daysOfWeek: days,
      remindersOn,
      active,
      notes: notes.trim() || null,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    }),
    [active, days, existing, foodName, label, notes, petId, portion, remindersOn, time, unit],
  );

  /* ---- actions ---------------------------------------------------------- */

  const save = useCallback(async () => {
    const next: { label?: string; food?: string } = {};
    if (!label.trim()) next.label = 'Give this meal a name — “Breakfast” works.';
    if (!foodName.trim()) next.food = `What does ${petName} actually eat at this one?`;
    if (portion <= 0) next.food = 'A portion of nothing is a skipped meal, not a schedule.';

    setErrors(next);
    if (Object.keys(next).length > 0) {
      haptics.error();
      return;
    }

    try {
      await saveSchedule.mutateAsync({
        id: existing?.id,
        label: label.trim(),
        time,
        foodName: foodName.trim(),
        portion,
        unit,
        daysOfWeek: days,
        remindersOn,
        active,
        notes: notes.trim() || null,
      });

      haptics.success();
      toast.success(
        existing ? `${label.trim()} updated` : `${label.trim()} is on the timetable`,
        {
          description: remindersOn
            ? `We'll nudge you at ${formatTimeOfDay(time)} — ${weekdaysLabel(days).toLowerCase()}.`
            : `${formatTimeOfDay(time)}, ${weekdaysLabel(days).toLowerCase()}. No reminder, as you asked.`,
          haptic: false,
        },
      );
      router.back();
    } catch {
      // The mutation raises its own error toast; the draft stays put.
    }
  }, [
    active,
    days,
    existing,
    foodName,
    label,
    notes,
    petName,
    portion,
    remindersOn,
    router,
    saveSchedule,
    time,
    unit,
  ]);

  /* ---- gates ------------------------------------------------------------ */

  const close = (
    <IconButton
      icon="close"
      accessibilityLabel="Close"
      accessibilityHint="Discards this mealtime and goes back."
      variant="tonal"
      tone="neutral"
      onPress={() => router.back()}
    />
  );

  if (!permission.allowed) {
    const copy = denial(permission.reason);
    return (
      <Screen center header={<ScreenHeader title="Mealtime" large={false} leading={close} />}>
        <EmptyState
          tone="neutral"
          illustration={<PermissionLocked size={t.spacing.colossal * 3} />}
          headline={copy.title}
          body={copy.body}
          action={{
            label: 'Tell me more',
            icon: 'help-circle-outline',
            onPress: () => permission.explain({ petName }),
          }}
          secondaryAction={{ label: 'Go back', onPress: () => router.back() }}
        />
      </Screen>
    );
  }

  if (id && schedulesQuery.isPending) {
    return (
      <Screen header={<ScreenHeader title="Mealtime" large={false} leading={close} />} scroll>
        <SkeletonGroup label="Loading this mealtime" gap="lg">
          <ListRowSkeleton count={4} avatar={false} />
        </SkeletonGroup>
      </Screen>
    );
  }

  if (id && schedulesQuery.isError) {
    return (
      <Screen center header={<ScreenHeader title="Mealtime" large={false} leading={close} />}>
        <ErrorState
          error={schedulesQuery.error}
          title="We couldn’t open this mealtime"
          body="It’s still on the timetable — the app just couldn’t fetch it this time."
          onRetry={() => schedulesQuery.refetch()}
        />
      </Screen>
    );
  }

  if (id && !existing) {
    return (
      <Screen center header={<ScreenHeader title="Mealtime" large={false} leading={close} />}>
        <EmptyState
          tone="neutral"
          icon="calendar-clear-outline"
          headline="That mealtime is gone"
          body={`It looks like it was deleted. ${possessive(petName)} other meals are untouched.`}
          action={{
            label: 'Back to feeding',
            icon: 'arrow-back',
            onPress: () => router.replace(toHref(`/pet/${petId}/feeding`)),
          }}
        />
      </Screen>
    );
  }

  /* ---- content ---------------------------------------------------------- */

  return (
    <Screen
      header={
        <ScreenHeader
          title={existing ? 'Edit mealtime' : 'New mealtime'}
          subtitle={pet ? `for ${pet.name}` : undefined}
          leading={close}
          actions={
            existing ? (
              <IconButton
                icon="trash-outline"
                accessibilityLabel="Delete this mealtime"
                accessibilityHint="Removes it from the timetable."
                variant="tonal"
                tone="danger"
                onPress={() => deleteSheet.open()}
              />
            ) : null
          }
        />
      }
      scroll
      contentContainerStyle={{ gap: t.spacing.xl, paddingBottom: t.spacing.xxl }}
      footer={
        <Button
          label={existing ? 'Save changes' : `Add ${label.trim() || 'this meal'}`}
          onPress={() => void save()}
          variant="primary"
          size="lg"
          fullWidth
          hero
          loading={saveSchedule.isPending}
          haptic="none"
          accessibilityHint={`Puts ${formatPortion(portion, unit)} of ${foodName.trim() || 'food'} at ${formatTimeOfDay(time)} on ${possessive(petName)} timetable.`}
        />
      }
    >
      <Animated.View layout={LinearTransition.duration(t.motion.duration.base)}>
        <FeedingScheduleCard
          schedule={draft}
          petName={petName}
          status={active ? 'upcoming' : 'paused'}
          animate={false}
        />
      </Animated.View>

      <Column gap="base">
        <SectionHeader
          title="When"
          subtitle={`${timeSlotLabel(time)} · ${weekdaysLabel(days)}`}
          icon="alarm-outline"
          iconColor="accentText"
          first
        />

        <TimeField
          value={time}
          onChange={setTime}
          label="Time"
          title="What time is this meal?"
          minuteStep={5}
          helper="Reminders land on the dot."
        />

        <Column gap="sm">
          <Text variant="subheadStrong" color="textSecondary">
            Which days?
          </Text>
          <Row gap="sm" wrap>
            {DAY_PRESETS.map((preset) => (
              <Chip
                key={preset.id}
                label={preset.label}
                selected={sameDays(days, preset.days)}
                onPress={() => {
                  haptics.select();
                  setDays([...preset.days]);
                }}
                size="sm"
              />
            ))}
          </Row>
          <DayPicker value={days} onChange={setDays} />
        </Column>
      </Column>

      <Column gap="base">
        <SectionHeader
          title="What"
          subtitle={`${formatPortion(portion, unit)} of ${foodName.trim() || 'their food'}`}
          icon="nutrition-outline"
          iconColor="primaryText"
        />

        <Column gap="sm">
          <Input
            value={label}
            onChangeText={(next) => {
              setLabel(next);
              if (errors.label) setErrors((current) => ({ ...current, label: undefined }));
            }}
            label="Name this meal"
            placeholder="Breakfast"
            error={errors.label}
            leadingIcon="pricetag-outline"
            maxLength={MAX_LABEL}
            showCounter={false}
            clearable
            autoCapitalize="sentences"
          />
          <Row gap="sm" wrap>
            {LABEL_SUGGESTIONS.map((suggestion) => (
              <Chip
                key={suggestion}
                label={suggestion}
                selected={label.trim().toLowerCase() === suggestion.toLowerCase()}
                onPress={() => {
                  setLabel(suggestion);
                  setErrors((current) => ({ ...current, label: undefined }));
                }}
                size="sm"
              />
            ))}
          </Row>
        </Column>

        <Input
          value={foodName}
          onChangeText={(next) => {
            setFoodName(next);
            if (errors.food) setErrors((current) => ({ ...current, food: undefined }));
          }}
          label="Food"
          placeholder="Kibble, wet food, the raw stuff"
          error={errors.food}
          leadingIcon="restaurant-outline"
          maxLength={MAX_FOOD}
          showCounter={false}
          clearable
          autoCapitalize="sentences"
        />

        <Column gap="sm">
          <Text variant="subheadStrong" color="textSecondary">
            How much?
          </Text>
          <Row gap="md" align="center">
            <Stepper
              value={portion}
              onChange={setPortion}
              min={0}
              max={portionMax(unit)}
              step={portionStep(unit)}
              unit={portionUnitLabel(unit, portion)}
              accessibilityLabel="Portion size"
              accessibilityHint="Hold to change it quickly."
            />
            <View style={{ flex: 1 }}>
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
      </Column>

      <Column gap="base">
        <SectionHeader
          title="Reminder"
          subtitle={
            remindersOn
              ? `A nudge at ${formatTimeOfDay(time)}, ${weekdaysLabel(days).toLowerCase()}.`
              : 'Off — nothing will buzz for this meal.'
          }
          icon="notifications-outline"
          iconColor="accentText"
        />

        <Surface variant="surface" elevation={1} radius="xl" padding="base" style={{ gap: t.spacing.base }}>
          <Switch
            value={remindersOn}
            onValueChange={setRemindersOn}
            label="Remind me at mealtime"
            description="A local notification — nothing leaves your phone."
          />

          {remindersOn ? (
            <Animated.View
              entering={FadeIn.duration(t.motion.duration.base)}
              layout={LinearTransition.duration(t.motion.duration.base)}
              style={{ gap: t.spacing.sm }}
            >
              <NotificationPreview
                petName={petName}
                label={draft.label}
                portion={formatPortion(portion, unit)}
                food={draft.foodName}
              />
              <Text variant="caption" color="textTertiary">
                The wording shifts a little day to day, so week three doesn&apos;t read like week one.
              </Text>
            </Animated.View>
          ) : null}
        </Surface>
      </Column>

      <Column gap="base">
        <SectionHeader title="Anything else" variant="overline" />
        <TextArea
          value={notes}
          onChangeText={setNotes}
          label="Notes"
          placeholder={`Soak the biscuits, or split it if ${petName} bolts it`}
          minRows={2}
          maxRows={5}
          maxLength={MAX_NOTES}
        />
        {existing ? (
          <Switch
            value={active}
            onValueChange={setActive}
            label="On the timetable"
            description={
              active
                ? 'Showing on Today, and reminding you if reminders are on.'
                : 'Paused — kept on file, but nothing will be scheduled.'
            }
          />
        ) : null}
      </Column>

      <ConfirmSheet
        controller={deleteSheet}
        title={`Delete ${(existing?.label ?? 'this meal').toLowerCase()}?`}
        body={`Meals already logged stay on ${possessive(petName)} record — only the schedule and its reminder go.`}
        confirmLabel="Delete it"
        cancelLabel="Keep it"
        icon="trash-outline"
        onConfirm={() => {
          if (!existing) return;
          deleteSchedule.mutate(existing.id);
          toast.success(`${existing.label} removed`, {
            description: `${possessive(petName)} other mealtimes are untouched.`,
            haptic: false,
          });
          router.back();
        }}
      />
    </Screen>
  );
}

/* ------------------------------------------------------- reminder preview */

type NotificationPreviewProps = {
  petName: string;
  label: string;
  portion: string;
  food: string;
};

/**
 * The real thing, not a mock-up: this is the canonical variant from the copy
 * bank in `lib/notifications`, rendered as the lock screen will render it. A
 * toggle that says "Reminders" is a promise; this is the receipt.
 */
function NotificationPreview({ petName, label, portion, food }: NotificationPreviewProps) {
  const t = useTheme();

  return (
    <Surface
      variant="surfaceAlt"
      radius="lg"
      padding="md"
      border
      style={{ gap: t.spacing.sm, flexDirection: 'row' }}
    >
      <View
        style={{
          width: t.spacing.xxxl,
          height: t.spacing.xxxl,
          borderRadius: t.radius.md,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: t.color.primary,
        }}
      >
        <Icon name="paw" size="md" color={t.color.onPrimary} />
      </View>

      <Column flex gap="hair">
        <Row gap="xs">
          <Text variant="captionStrong" color="textTertiary" numberOfLines={1} style={{ flex: 1 }}>
            PETAL
          </Text>
          <Text variant="caption" color="textTertiary">
            now
          </Text>
        </Row>
        <Text variant="subheadStrong" numberOfLines={2}>
          {possessive(petName)} {label.toLowerCase()} time! 🐾
        </Text>
        <Text variant="footnote" color="textSecondary" numberOfLines={2}>
          {portion} of {food} — the bowl awaits.
        </Text>
      </Column>
    </Surface>
  );
}
