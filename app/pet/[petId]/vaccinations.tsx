/**
 * Vaccinations — the schedule and the record.
 *
 * These are two genuinely different questions asked of the same rows, so the
 * screen offers two shapes rather than one compromise:
 *
 *   · **Schedule** puts everything on a rail with today drawn across it. It
 *     answers "what's owed, and when" in one downward glance.
 *   · **Due** and **Given** are stacks of full cards — vet, clinic, batch
 *     number — because that is what you read out to a receptionist or copy
 *     onto a boarding form.
 *
 * The overdue banner sits above all three and never scrolls away with the
 * filter, because a lapsed rabies shot is the single most consequential thing
 * this app can tell someone.
 *
 * `vaccination.edit` is grantable to a caregiver, so every write here is shown
 * *disabled and explainable* rather than hidden — that is how a sitter learns
 * what to ask the owner for.
 */

import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import Animated, { FadeIn, FadeInDown, LinearTransition } from 'react-native-reanimated';

import { useVaccinations } from '@/data/queries/useHealth';
import type { Vaccination } from '@/data/types';
import { VaccinationCard, vaccinationStatus } from '@/features/health/VaccinationCard';
import { VaccinationTimeline } from '@/features/health/VaccinationTimeline';
import { usePetScope } from '@/features/pets/PetScope';
import { toHref } from '@/lib/deeplinks';
import { plural, possessive } from '@/lib/format';
import { DENIAL_COPY, type DenialReason } from '@/rbac/permissions';
import { useNow, usePermission } from '@/rbac/usePermission';
import { useTheme } from '@/theme';
import {
  Banner,
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  Screen,
  ScreenHeader,
  SectionHeader,
  SegmentedControl,
  Text,
  type Segment,
} from '@/ui';
import { EmptyVaccinations, PermissionLocked } from '@/ui/illustrations';
import { SkeletonGroup } from '@/ui/Skeleton';
import { ListRowSkeleton, TimelineSkeleton } from '@/ui/skeletons/ContentSkeletons';

/* -------------------------------------------------------------------- types */

type ViewValue = 'schedule' | 'due' | 'given';

/* ---------------------------------------------------------------- constants */

const VIEWS: Segment<ViewValue>[] = [
  { value: 'schedule', label: 'Schedule', icon: 'git-commit-outline' },
  { value: 'due', label: 'Due', icon: 'alert-circle-outline' },
  { value: 'given', label: 'Given', icon: 'checkmark-done-outline' },
];

const STAGGER_CAP = 8;

/* ------------------------------------------------------------------ helpers */

function denial(reason: DenialReason | null): { title: string; body: string } {
  return DENIAL_COPY[reason ?? 'not-granted'];
}

/* ---------------------------------------------------------------- component */

export default function VaccinationsScreen() {
  const t = useTheme();
  const router = useRouter();
  const scope = usePetScope();
  const petId = scope.petId;
  const pet = scope.pet;
  const now = useNow();

  const canView = usePermission('vaccination.view', petId);
  const canEdit = usePermission('vaccination.edit', petId);

  const vaccinationsQuery = useVaccinations(canView.allowed ? petId : null);

  const [view, setView] = useState<ViewValue>('schedule');
  const [refreshing, setRefreshing] = useState(false);

  const rows = useMemo(() => vaccinationsQuery.data ?? [], [vaccinationsQuery.data]);

  /* ---- buckets ---------------------------------------------------------- */

  const { due, given, overdue } = useMemo(() => {
    const dueRows: Vaccination[] = [];
    const givenRows: Vaccination[] = [];
    const overdueRows: Vaccination[] = [];

    for (const row of rows) {
      const status = vaccinationStatus(row, now);
      if (status === 'overdue') overdueRows.push(row);
      if (status === 'overdue' || status === 'dueSoon' || status === 'scheduled') dueRows.push(row);
      else givenRows.push(row);
    }

    dueRows.sort((a, b) => Date.parse(a.dueAt ?? '') - Date.parse(b.dueAt ?? ''));
    givenRows.sort(
      (a, b) => Date.parse(b.administeredAt ?? '') - Date.parse(a.administeredAt ?? ''),
    );
    overdueRows.sort((a, b) => Date.parse(a.dueAt ?? '') - Date.parse(b.dueAt ?? ''));

    return { due: dueRows, given: givenRows, overdue: overdueRows };
  }, [now, rows]);

  /* ---- actions ---------------------------------------------------------- */

  const explainWith = useMemo(() => ({ petName: pet?.name ?? null }), [pet?.name]);

  const openRecord = useCallback(
    (id?: string) => {
      router.push(toHref(`/record/vaccination?petId=${petId}${id ? `&id=${id}` : ''}`));
    },
    [petId, router],
  );

  const edit = useCallback(
    (vaccination?: Vaccination) => {
      if (canEdit.allowed) openRecord(vaccination?.id);
      else canEdit.explain(explainWith);
    },
    [canEdit, explainWith, openRecord],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await vaccinationsQuery.refetch();
    } finally {
      setRefreshing(false);
    }
  }, [vaccinationsQuery]);

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

  const editDisabledReason = canEdit.allowed ? undefined : denial(canEdit.reason).title;

  /* ---- chrome ----------------------------------------------------------- */

  const header = (
    <ScreenHeader
      title="Vaccinations"
      subtitle={pet ? `What ${pet.name} has had, and what's coming round again` : undefined}
      actions={
        <IconButton
          icon="add"
          accessibilityLabel="Add a vaccination"
          accessibilityHint={pet ? `Records a shot for ${pet.name}.` : undefined}
          variant="tonal"
          tone="primary"
          disabledReason={editDisabledReason}
          onPress={() => edit()}
        />
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
          headline="Vaccinations aren’t part of your access"
          body={denial(canView.reason).body}
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

  if (vaccinationsQuery.isPending || !pet) {
    return (
      <Screen header={header} scroll>
        <SkeletonGroup label="Loading the vaccination record" gap="xl">
          <ListRowSkeleton count={1} avatar={false} />
          <TimelineSkeleton items={5} />
        </SkeletonGroup>
      </Screen>
    );
  }

  if (vaccinationsQuery.isError) {
    return (
      <Screen header={header} center>
        <ErrorState
          error={vaccinationsQuery.error}
          title="We couldn’t open the vaccination record"
          body={`${possessive(pet.name)} history is safe — the app just couldn't fetch it this time.`}
          onRetry={() => vaccinationsQuery.refetch()}
        />
      </Screen>
    );
  }

  if (rows.length === 0) {
    return (
      <Screen header={header} center>
        <EmptyState
          illustration={<EmptyVaccinations size={t.spacing.colossal * 3} />}
          headline={`No vaccinations on file for ${pet.name} yet`}
          body={`Add the first one — even an old one — and we'll work out when the next is due and keep an eye on it for you.`}
          action={{
            label: 'Add a vaccination',
            icon: 'add',
            onPress: () => edit(),
            disabledReason: editDisabledReason,
            accessibilityHint: 'Opens the vaccination form.',
          }}
          footer={
            <Text variant="caption" color="textTertiary" align="center">
              Core shots are the ones every vet expects. We’ll mark them for you.
            </Text>
          }
        />
      </Screen>
    );
  }

  /* ---- content ---------------------------------------------------------- */

  const cards = view === 'due' ? due : given;

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
          label="Add a vaccination"
          onPress={() => edit()}
          variant="primary"
          size="lg"
          fullWidth
          hero
          leftIcon="add"
          disabledReason={editDisabledReason}
          accessibilityHint={`Records a shot for ${pet.name}.`}
        />
      }
    >
      {overdue.length > 0 ? (
        <Animated.View entering={enter(0)}>
          <Banner
            tone="danger"
            emphasis="loud"
            icon="alert-circle"
            title={
              overdue.length === 1
                ? `${overdue[0]?.name ?? 'A vaccination'} has gone past its date`
                : `${plural(overdue.length, 'vaccination')} have gone past their date`
            }
            message={`Book ${pet.name} in when you can — most practices will fit a lapsed booster in the same week.`}
            action={{
              label: canEdit.allowed ? 'Update the record' : 'Why can’t I update this?',
              icon: canEdit.allowed ? 'create-outline' : 'help-circle-outline',
              onPress: () => edit(overdue[0]),
            }}
          />
        </Animated.View>
      ) : null}

      <Animated.View entering={enter(1)}>
        <SegmentedControl
          segments={VIEWS}
          value={view}
          onChange={setView}
          accessibilityLabel="How to view the vaccination record"
        />
      </Animated.View>

      <Animated.View
        entering={enter(2)}
        layout={LinearTransition.duration(t.motion.duration.base)}
        style={{ gap: t.spacing.md }}
      >
        {view === 'schedule' ? (
          <VaccinationTimeline
            vaccinations={rows}
            now={now}
            petName={pet.name}
            onSelect={(vaccination) => edit(vaccination)}
            disabledReason={editDisabledReason}
            onAdd={() => edit()}
            addDisabledReason={editDisabledReason}
          />
        ) : (
          <>
            <SectionHeader
              title={view === 'due' ? 'Owed right now' : 'Already given'}
              subtitle={
                view === 'due'
                  ? 'Overdue first, then whatever comes round next.'
                  : 'Most recent first — the list a boarding kennel asks for.'
              }
              count={cards.length}
              countTone={view === 'due' && overdue.length > 0 ? 'danger' : 'neutral'}
              icon={view === 'due' ? 'time-outline' : 'checkmark-done-outline'}
              iconColor={view === 'due' ? 'onWarningSoft' : 'primaryText'}
              first
            />

            {cards.length === 0 ? (
              <EmptyState
                variant="compact"
                frame
                icon={view === 'due' ? 'checkmark-circle-outline' : 'documents-outline'}
                tone={view === 'due' ? 'primary' : 'neutral'}
                headline={
                  view === 'due'
                    ? `${pet.name} is completely up to date`
                    : 'Nothing has been given yet'
                }
                body={
                  view === 'due'
                    ? 'Not a single booster owed. We’ll nudge you a month before the next one comes round.'
                    : `Once you record a shot ${pet.name} has already had, it'll live here for good.`
                }
              />
            ) : (
              cards.map((vaccination, index) => (
                <Animated.View key={vaccination.id} entering={enter(index + 3)}>
                  <VaccinationCard
                    vaccination={vaccination}
                    petName={pet.name}
                    now={now}
                    onPress={() => edit(vaccination)}
                    disabledReason={editDisabledReason}
                  />
                </Animated.View>
              ))
            )}
          </>
        )}
      </Animated.View>
    </Screen>
  );
}
