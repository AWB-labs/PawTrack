/**
 * Petal — the pet's vital signs, in one row.
 *
 * Four numbers a person actually asks about: how heavy, how old, are the meds
 * going in, and when is the vet. They scroll horizontally rather than wrapping
 * into a grid because a grid of four tiles is a dashboard, and a dashboard is
 * exactly the feeling a pet profile must avoid.
 *
 * Two details worth defending:
 *
 *   · **The weight delta is judged against the vet's target, not against zero.**
 *     A gain is good news for an underweight cat and bad news for an overweight
 *     one; colouring every rise amber would be a small daily lie.
 *   · **Nothing on file is a *designed* value, not a blank.** "No weigh-ins yet"
 *     with a tap that opens the log beats an em dash that explains nothing.
 *
 * Units are a display concern: kilograms come in, the user's preference decides
 * what leaves.
 */

import React, { useMemo, type ReactNode } from 'react';
import { ScrollView, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import type { Appointment, Pet, WeightEntry } from '@/data/types';
import { describeAge, formatDay, friendlyDate, relativeTime } from '@/lib/date';
import {
  formatWeightDelta,
  possessive,
  toDisplayWeight,
  weightUnitLabel,
} from '@/lib/format';
import { usePreferences } from '@/stores/preferences';
import { useTheme } from '@/theme';
import { Skeleton, SkeletonGroup, StatTile, type StatDelta } from '@/ui';

/* -------------------------------------------------------------------- types */

export type PetStatRowProps = {
  pet: Pet;
  /** Oldest first, exactly as `useWeights()` returns them. */
  weights?: readonly WeightEntry[];
  /** 0–1 across the pet's active medicines. `null` means there are none. */
  adherence?: number | null;
  /** Soonest upcoming visit, or null when the calendar is clear. */
  nextAppointment?: Appointment | null;
  loading?: boolean;
  onPressWeight?: () => void;
  onPressAge?: () => void;
  onPressMedicine?: () => void;
  onPressAppointment?: () => void;
  /** RBAC: a reason renders the tile dimmed and explains itself on tap. */
  weightDisabledReason?: string;
  medicineDisabledReason?: string;
  appointmentDisabledReason?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/** Points on the weight sparkline. More than this and it stops being a spark. */
const SPARK_POINTS = 8;

const TILE_COUNT = 4;

/* ------------------------------------------------------------------ helpers */

/** Is the newer reading closer to the vet-advised target than the older one? */
function weightDelta(
  latest: WeightEntry,
  previous: WeightEntry | undefined,
  target: number | null,
  unit: 'kg' | 'lb',
): StatDelta | null {
  if (!previous) return null;
  const change = latest.kg - previous.kg;
  if (Math.abs(change) < 0.005) {
    return { value: 0, label: 'Steady', tone: 'neutral' };
  }
  const tone: StatDelta['tone'] =
    target === null
      ? 'neutral'
      : Math.abs(latest.kg - target) <= Math.abs(previous.kg - target)
        ? 'positive'
        : 'negative';
  return { value: change, label: formatWeightDelta(change, { unit }), tone };
}

/* ---------------------------------------------------------------- component */

export function PetStatRow({
  pet,
  weights = [],
  adherence = null,
  nextAppointment = null,
  loading = false,
  onPressWeight,
  onPressAge,
  onPressMedicine,
  onPressAppointment,
  weightDisabledReason,
  medicineDisabledReason,
  appointmentDisabledReason,
  style,
  testID,
}: PetStatRowProps) {
  const t = useTheme();
  const unit = usePreferences((s) => s.weightUnit);

  const tileWidth = t.spacing.colossal * 2;
  const gap = t.spacing.md;

  const latest = weights.length > 0 ? weights[weights.length - 1] : undefined;
  const previous = weights.length > 1 ? weights[weights.length - 2] : undefined;

  const spark = useMemo(
    () => weights.slice(-SPARK_POINTS).map((entry) => toDisplayWeight(entry.kg, unit)),
    [unit, weights],
  );

  const scrollProps = {
    horizontal: true as const,
    showsHorizontalScrollIndicator: false,
    contentContainerStyle: { paddingHorizontal: t.gutter, gap },
  };

  if (loading) {
    return (
      <ScrollView {...scrollProps} scrollEnabled={false} style={style} testID={testID}>
        <SkeletonGroup label={`Loading ${possessive(pet.name)} numbers`} style={{ flexDirection: 'row', gap }}>
          {Array.from({ length: TILE_COUNT }, (_, index) => (
            <View
              key={index}
              style={{
                width: tileWidth,
                gap: t.spacing.sm,
                padding: t.spacing.base,
                borderRadius: t.radius.xl,
                backgroundColor: t.color.surface,
                ...t.elevation(1),
              }}
            >
              <Skeleton w="58%" h={t.type.caption.fontSize} r="xs" dim />
              <Skeleton w="72%" h={t.type.metric.fontSize} r="xs" />
              <Skeleton w="44%" h={t.type.caption.fontSize} r="xs" dim />
            </View>
          ))}
        </SkeletonGroup>
      </ScrollView>
    );
  }

  /* ---- weight ----------------------------------------------------------- */

  const displayWeight = latest ? toDisplayWeight(latest.kg, unit) : null;
  const decimals = displayWeight !== null && Math.abs(displayWeight) < 1 ? 2 : 1;

  const weightTile =
    latest && displayWeight !== null ? (
      <StatTile
        label="Weight"
        value={displayWeight}
        precision={decimals}
        format={(value) => value.toFixed(decimals)}
        unit={weightUnitLabel(unit)}
        delta={weightDelta(latest, previous, pet.targetWeightKg, unit)}
        icon="fitness-outline"
        sparkline={spark.length > 1 ? spark : undefined}
        caption={`Weighed ${relativeTime(latest.recordedAt)}`}
        onPress={onPressWeight}
        disabledReason={weightDisabledReason}
        accessibilityHint="Opens the weight history"
      />
    ) : (
      <StatTile
        label="Weight"
        value="—"
        icon="fitness-outline"
        // A locked tile has no readings *and* wouldn't show them — saying "none
        // yet" there would be a small daily lie to a sitter.
        caption={weightDisabledReason ?? `No weigh-ins yet for ${pet.name}`}
        onPress={onPressWeight}
        disabledReason={weightDisabledReason}
        accessibilityHint="Opens the weight history"
      />
    );

  /* ---- age -------------------------------------------------------------- */

  const age = describeAge(pet);
  const ageCaption = pet.birthday
    ? `Born ${formatDay(pet.birthday)}`
    : pet.approximateAgeMonths !== null
      ? 'Estimated — no birthday on file'
      : 'Add a birthday and we’ll remember it';

  const ageTile = (
    <StatTile
      label="Age"
      value={age ?? 'Unknown'}
      icon="gift-outline"
      iconColor="accentText"
      caption={ageCaption}
      onPress={onPressAge}
      accessibilityHint={onPressAge ? 'Opens the profile editor' : undefined}
    />
  );

  /* ---- adherence -------------------------------------------------------- */

  const adherenceTile =
    adherence === null ? (
      <StatTile
        label="Medicine"
        value="—"
        icon="medical-outline"
        caption={medicineDisabledReason ?? 'Nothing prescribed right now'}
        onPress={onPressMedicine}
        disabledReason={medicineDisabledReason}
        accessibilityHint="Opens medicines"
      />
    ) : (
      <StatTile
        label="Doses given"
        value={Math.round(adherence * 100)}
        unit="%"
        icon="medical-outline"
        caption="Of everything due this month"
        onPress={onPressMedicine}
        disabledReason={medicineDisabledReason}
        accessibilityHint="Opens medicines"
      />
    );

  /* ---- appointment ------------------------------------------------------ */

  // Omitted entirely (not just emptied) when the caller doesn't wire a press
  // handler — that's the caller's signal that vet-visit booking isn't part of
  // this build. A permanently non-interactive "Nothing booked" tile would be
  // a dead end wearing the same chrome as the working ones.
  const appointmentTile =
    onPressAppointment && nextAppointment ? (
      <StatTile
        label="Next vet visit"
        value={friendlyDate(nextAppointment.at)}
        icon="medkit-outline"
        iconColor="onInfoSoft"
        caption={nextAppointment.clinic ?? nextAppointment.reason}
        onPress={onPressAppointment}
        disabledReason={appointmentDisabledReason}
        accessibilityHint="Opens appointments"
      />
    ) : onPressAppointment ? (
      <StatTile
        label="Next vet visit"
        value="—"
        icon="medkit-outline"
        iconColor="onInfoSoft"
        caption={appointmentDisabledReason ?? 'Nothing booked'}
        onPress={onPressAppointment}
        disabledReason={appointmentDisabledReason}
        accessibilityHint="Opens appointments"
      />
    ) : null;

  const tiles: ReactNode[] = [weightTile, ageTile, adherenceTile, appointmentTile].filter(
    (tile) => tile !== null,
  );

  return (
    <ScrollView {...scrollProps} style={style} testID={testID}>
      {tiles.map((tile, index) => (
        <Animated.View
          key={index}
          entering={
            t.reduceMotion
              ? FadeIn.duration(t.motion.duration.base).delay(index * t.motion.stagger.tight)
              : FadeInDown.duration(t.motion.duration.slow)
                  .delay(index * t.motion.stagger.base)
                  .easing(t.motion.easing.decelerate)
          }
          style={{ width: tileWidth }}
        >
          {tile}
        </Animated.View>
      ))}
    </ScrollView>
  );
}

export default PetStatRow;
