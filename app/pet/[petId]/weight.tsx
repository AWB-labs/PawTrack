/**
 * Weight history.
 *
 * One number matters more than the rest here — today's — so it gets the top of
 * the screen and the chart's scrub readout, and everything below it is the
 * ledger that produced it.
 *
 * Three things the screen is careful about:
 *
 *   · **The unit is a rendering, never a stored value.** Everything below is
 *     kilograms; the pounds a user sees are produced by `lib/format` at the last
 *     possible moment. The switch under the chart is there because someone
 *     reading a vet's letter in the other unit shouldn't have to leave.
 *   · **Deleting a weigh-in is undoable.** A row that vanishes behind a confirm
 *     dialogue is slower *and* scarier than one that vanishes with an Undo, and
 *     a single reading is cheap to put back.
 *   · **Reads are gated as hard as writes.** Without `weight.view` the query is
 *     never armed — passing `null` for the pet id is what disables it — so a
 *     sitter can't trip a permission error just by following a link.
 */

import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeInDown, LinearTransition } from 'react-native-reanimated';

import { usePetCaregivers } from '@/data/queries/useCaregivers';
import { useAddWeight, useDeleteWeight, useWeights } from '@/data/queries/useHealth';
import type { WeightEntry } from '@/data/types';
import { usePetScope } from '@/features/pets/PetScope';
import { WeightSummary } from '@/features/health/WeightSummary';
import { friendlyDate, formatClock } from '@/lib/date';
import { toHref } from '@/lib/deeplinks';
import { formatWeight, formatWeightDelta, plural, possessive, weightUnitLabel } from '@/lib/format';
import haptics from '@/lib/haptics';
import { DENIAL_COPY, type DenialReason } from '@/rbac/permissions';
import { usePermission } from '@/rbac/usePermission';
import { usePreferences } from '@/stores/preferences';
import { useSession } from '@/stores/session';
import { useTheme } from '@/theme';
import {
  Button,
  Column,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  Row,
  Screen,
  ScreenHeader,
  SectionHeader,
  SegmentedControl,
  SwipeRow,
  Text,
  toast,
  Touchable,
  type Segment,
} from '@/ui';
import { PermissionLocked } from '@/ui/illustrations';
import { SkeletonGroup } from '@/ui/Skeleton';
import { ChartSkeleton, ListRowSkeleton } from '@/ui/skeletons/ContentSkeletons';

/* -------------------------------------------------------------------- types */

type RangeValue = 'quarter' | 'year' | 'all';

/* ---------------------------------------------------------------- constants */

const RANGES: Segment<RangeValue>[] = [
  { value: 'quarter', label: '3 months' },
  { value: 'year', label: 'Year' },
  { value: 'all', label: 'All time' },
];

const RANGE_DAYS: Record<RangeValue, number | null> = {
  quarter: 90,
  year: 365,
  all: null,
};

const RANGE_LABEL: Record<RangeValue, string> = {
  quarter: 'Last three months',
  year: 'Last twelve months',
  all: 'Every reading',
};

/** Beyond this the entrance cascade reads as lag rather than choreography. */
const STAGGER_CAP = 8;

/* ------------------------------------------------------------------ helpers */

function denial(reason: DenialReason | null): { title: string; body: string } {
  return DENIAL_COPY[reason ?? 'not-granted'];
}

/* ---------------------------------------------------------------- component */

export default function WeightScreen() {
  const t = useTheme();
  const router = useRouter();
  const scope = usePetScope();
  const petId = scope.petId;
  const pet = scope.pet;

  const unit = usePreferences((s) => s.weightUnit);
  const setWeightUnit = usePreferences((s) => s.setWeightUnit);
  const userId = useSession((s) => s.user?.id) ?? '';

  const canView = usePermission('weight.view', petId);
  const canLog = usePermission('weight.log', petId);

  const weightsQuery = useWeights(canView.allowed ? petId : null);
  const caregiversQuery = usePetCaregivers(
    scope.capabilities.has('caregiver.view') ? petId : null,
  );

  const deleteWeight = useDeleteWeight(petId);
  const addWeight = useAddWeight(petId);

  const [range, setRange] = useState<RangeValue>('quarter');
  const [refreshing, setRefreshing] = useState(false);

  const entries = useMemo(() => weightsQuery.data ?? [], [weightsQuery.data]);
  /** Newest first — a ledger is read from the top. */
  const ledger = useMemo(() => [...entries].reverse(), [entries]);

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of caregiversQuery.data ?? []) map.set(row.userId, row.user.displayName);
    return map;
  }, [caregiversQuery.data]);

  const explainWith = useMemo(() => ({ petName: pet?.name ?? null }), [pet?.name]);

  /* ---- actions ---------------------------------------------------------- */

  const openRecord = useCallback(
    (entryId?: string) => {
      const query = entryId ? `?petId=${petId}&id=${entryId}` : `?petId=${petId}`;
      router.push(toHref(`/record/weight${query}`));
    },
    [petId, router],
  );

  const startAdd = useCallback(() => {
    if (canLog.allowed) openRecord();
    else canLog.explain(explainWith);
  }, [canLog, explainWith, openRecord]);

  const removeEntry = useCallback(
    (entry: WeightEntry) => {
      deleteWeight.mutate(entry.id, {
        onSuccess: () => {
          toast.undo(
            'Weigh-in removed',
            () => {
              addWeight.mutate({ kg: entry.kg, recordedAt: entry.recordedAt, note: entry.note });
            },
            {
              description: `${formatWeight(entry.kg, { unit })} on ${friendlyDate(entry.recordedAt).toLowerCase()}`,
              undoLabel: 'Put it back',
            },
          );
        },
      });
    },
    [addWeight, deleteWeight, unit],
  );

  const toggleUnit = useCallback(() => {
    const next = unit === 'kg' ? 'lb' : 'kg';
    haptics.select();
    setWeightUnit(next);
    toast.info(`Showing weights in ${next === 'kg' ? 'kilograms' : 'pounds'}`, {
      id: 'weight-unit',
      description: 'Everything is still stored exactly as it was recorded.',
      haptic: false,
    });
  }, [setWeightUnit, unit]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await weightsQuery.refetch();
    } finally {
      setRefreshing(false);
    }
  }, [weightsQuery]);

  const enter = useCallback(
    (index: number) =>
      t.reduceMotion
        ? FadeIn.duration(t.motion.duration.base).delay(
            Math.min(index, STAGGER_CAP) * t.motion.stagger.tight,
          )
        : FadeInDown.duration(t.motion.duration.slow)
            .delay(Math.min(index, STAGGER_CAP) * t.motion.stagger.base)
            .easing(t.motion.easing.decelerate),
    [t.motion, t.reduceMotion],
  );

  /* ---- chrome ----------------------------------------------------------- */

  const header = (
    <ScreenHeader
      title="Weight"
      subtitle={pet ? `${possessive(pet.name)} weigh-ins, oldest to newest` : undefined}
      actions={
        canLog.allowed ? (
          <IconButton
            icon="add"
            accessibilityLabel="Record a weight"
            accessibilityHint={pet ? `Adds a new weigh-in for ${pet.name}.` : undefined}
            variant="tonal"
            tone="primary"
            onPress={startAdd}
          />
        ) : null
      }
    />
  );

  /* ---- states ----------------------------------------------------------- */

  if (!canView.allowed) {
    return (
      <Screen header={header} center>
        <EmptyState
          tone="warning"
          illustration={<PermissionLocked size={t.spacing.colossal * 3} />}
          headline="Weight isn’t part of your access"
          body={
            pet
              ? `${denial(canView.reason).body} You can still do everything else you were asked to help with for ${pet.name}.`
              : denial(canView.reason).body
          }
          action={{
            label: 'Back to the profile',
            icon: 'arrow-back',
            onPress: () => router.replace(toHref(`/pet/${petId}`)),
          }}
          secondaryAction={{
            label: 'Why can’t I see this?',
            icon: 'help-circle-outline',
            onPress: () => canView.explain(explainWith),
          }}
        />
      </Screen>
    );
  }

  if (weightsQuery.isPending || !pet) {
    return (
      <Screen header={header} scroll>
        <SkeletonGroup label="Loading the weight history" gap="xl">
          <ChartSkeleton bars={6} />
          <ListRowSkeleton count={5} avatar={false} />
        </SkeletonGroup>
      </Screen>
    );
  }

  if (weightsQuery.isError) {
    return (
      <Screen header={header} center>
        <ErrorState
          error={weightsQuery.error}
          title="We couldn’t load the weigh-ins"
          body={`Every reading you've recorded for ${pet.name} is safe — the app just couldn't fetch them this time.`}
          onRetry={() => weightsQuery.refetch()}
        />
      </Screen>
    );
  }

  if (entries.length === 0) {
    return (
      <Screen header={header} center>
        <EmptyState
          icon="fitness-outline"
          tone="primary"
          headline={`No weigh-ins for ${pet.name} yet`}
          body={`The first one starts the chart. After that, every reading tells you whether ${pet.name} is heading the right way.`}
          action={{
            label: `Weigh ${pet.name} in`,
            icon: 'add',
            onPress: startAdd,
            disabledReason: canLog.allowed ? undefined : denial(canLog.reason).title,
            accessibilityHint: 'Opens the weigh-in form.',
          }}
          footer={
            <Text variant="caption" color="textTertiary" align="center">
              {`Recorded in ${unit === 'kg' ? 'kilograms' : 'pounds'} — you can switch any time.`}
            </Text>
          }
        />
      </Screen>
    );
  }

  /* ---- content ---------------------------------------------------------- */

  return (
    <Screen
      header={header}
      scroll
      refreshing={refreshing}
      onRefresh={() => {
        void refresh();
      }}
      contentContainerStyle={{ gap: t.spacing.lg, paddingBottom: t.spacing.xxl }}
      footer={
        <Button
          label={`Weigh ${pet.name} in`}
          onPress={startAdd}
          variant="primary"
          size="lg"
          fullWidth
          hero
          leftIcon="add"
          disabledReason={canLog.allowed ? undefined : denial(canLog.reason).title}
          accessibilityHint="Opens the weigh-in form."
        />
      }
    >
      <Animated.View entering={enter(0)} style={{ gap: t.spacing.md }}>
        <SegmentedControl
          segments={RANGES}
          value={range}
          onChange={setRange}
          accessibilityLabel="How far back the chart goes"
        />

        <WeightSummary
          pet={pet}
          entries={entries}
          windowDays={RANGE_DAYS[range]}
          windowLabel={RANGE_LABEL[range]}
        />

        <Touchable
          accessibilityRole="button"
          accessibilityLabel={`Switch to ${unit === 'kg' ? 'pounds' : 'kilograms'}`}
          accessibilityHint="Changes how weights are shown across Petal."
          haptic="none"
          onPress={toggleUnit}
          pressScale="small"
          style={{ alignSelf: 'center' }}
        >
          <Row gap="xs">
            <Icon name="swap-horizontal" size="xs" color="primaryText" />
            <Text variant="caption" color="primaryText">
              {`Showing ${unit === 'kg' ? 'kilograms' : 'pounds'} — switch to ${unit === 'kg' ? 'pounds' : 'kilograms'}`}
            </Text>
          </Row>
        </Touchable>
      </Animated.View>

      <Animated.View entering={enter(1)}>
        <SectionHeader
          title="Every weigh-in"
          subtitle={`${plural(entries.length, 'reading')} on file. Swipe a row to remove it.`}
          icon="list-outline"
          iconColor="textTertiary"
          first
        />
      </Animated.View>

      <Animated.View layout={LinearTransition.duration(t.motion.duration.base)} style={{ gap: t.spacing.sm }}>
        {ledger.map((entry, index) => {
          // `ledger` is newest-first, so the chronologically earlier reading is
          // the next one along — that's what a delta compares against.
          const earlier = ledger[index + 1];
          const loggedBy =
            entry.recordedBy === userId ? 'you' : (nameById.get(entry.recordedBy) ?? null);

          return (
            <Animated.View key={entry.id} entering={enter(index + 2)}>
              <WeightRow
                entry={entry}
                earlier={earlier}
                loggedBy={loggedBy}
                onPress={
                  canLog.allowed ? () => openRecord(entry.id) : () => canLog.explain(explainWith)
                }
                onDelete={() => removeEntry(entry)}
                deleteDisabledReason={canLog.allowed ? undefined : denial(canLog.reason).title}
              />
            </Animated.View>
          );
        })}
      </Animated.View>
    </Screen>
  );
}

/* ------------------------------------------------------------------- row */

type WeightRowProps = {
  entry: WeightEntry;
  /** The reading before this one, chronologically. Drives the delta. */
  earlier: WeightEntry | undefined;
  loggedBy: string | null;
  onPress: () => void;
  onDelete: () => void;
  deleteDisabledReason?: string;
};

function WeightRow({ entry, earlier, loggedBy, onPress, onDelete, deleteDisabledReason }: WeightRowProps) {
  const t = useTheme();
  const unit = usePreferences((s) => s.weightUnit);

  const delta = earlier ? entry.kg - earlier.kg : null;
  const deltaLabel = delta === null ? null : formatWeightDelta(delta, { unit });
  // `formatWeightDelta` already owns the "is this scale noise" threshold, so we
  // read its answer rather than keeping a second copy of the number here.
  const flat = deltaLabel === 'No change';
  const rising = (delta ?? 0) > 0;

  const meta = [
    friendlyDate(entry.recordedAt),
    formatClock(entry.recordedAt),
    loggedBy ? `logged by ${loggedBy}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  return (
    <SwipeRow
      background={t.color.surface}
      radius="lg"
      right={[
        {
          key: 'delete',
          label: 'Remove',
          icon: 'trash-outline',
          tone: 'danger',
          fullSwipe: true,
          onPress: onDelete,
          disabledReason: deleteDisabledReason,
        },
      ]}
    >
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={`${formatWeight(entry.kg, { unit })}, ${meta}${deltaLabel ? `, ${deltaLabel} since the reading before` : ''}`}
        accessibilityHint={deleteDisabledReason ?? 'Opens this weigh-in.'}
        disabledReason={deleteDisabledReason}
        haptic="tap"
        onPress={onPress}
        pressScale="large"
        style={{
          borderRadius: t.radius.lg,
          borderWidth: t.borderWidth.hairline,
          borderColor: t.color.border,
          paddingVertical: t.spacing.md,
          paddingHorizontal: t.spacing.base,
        }}
      >
        <Row gap="md">
          <Column style={{ minWidth: t.spacing.giant }} gap="hair">
            <Row align="end" gap="xxs">
              <Text variant="metricSmall" tabular numberOfLines={1}>
                {formatWeight(entry.kg, { unit, withUnit: false })}
              </Text>
              <Text variant="caption" color="textTertiary" style={{ marginBottom: t.spacing.hair }}>
                {weightUnitLabel(unit)}
              </Text>
            </Row>
          </Column>

          <Column flex gap="hair">
            <Text variant="subheadStrong" numberOfLines={1}>
              {friendlyDate(entry.recordedAt)}
            </Text>
            <Text variant="caption" color="textTertiary" numberOfLines={1}>
              {loggedBy ? `${formatClock(entry.recordedAt)} · logged by ${loggedBy}` : formatClock(entry.recordedAt)}
            </Text>
            {entry.note ? (
              <Text variant="footnote" color="textSecondary" numberOfLines={2}>
                {entry.note}
              </Text>
            ) : null}
          </Column>

          {deltaLabel ? (
            <Row
              gap="xxs"
              style={{
                paddingVertical: t.spacing.hair,
                paddingHorizontal: t.spacing.sm,
                borderRadius: t.radius.pill,
                backgroundColor: t.color.surfaceAlt,
              }}
            >
              <Icon
                name={flat ? 'remove' : rising ? 'arrow-up' : 'arrow-down'}
                size="xs"
                color="textSecondary"
              />
              <Text variant="caption" color="textSecondary" tabular numberOfLines={1}>
                {deltaLabel}
              </Text>
            </Row>
          ) : (
            <View style={{ width: t.spacing.xs }} />
          )}
        </Row>
      </Touchable>
    </SwipeRow>
  );
}
