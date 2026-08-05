/**
 * Vet visits — the history, on a rail.
 *
 * A visit list is read backwards: the most recent thing that happened is nearly
 * always the thing you came for. So the rail runs newest-first with the now
 * marker at the top, and years fall out as headers down the side — which is how
 * people actually navigate this ("that was the year of the hip thing").
 *
 * The band above it exists because two questions get asked of this screen
 * without opening a single visit: how long since the last one, and how much has
 * this year cost. Both are one line, so neither should need a tap.
 *
 * `vetvisit.edit` is grantable, so writing up and deleting a visit are shown
 * disabled-and-explainable to a sitter rather than hidden.
 */

import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { useDeleteVetVisit, useVetVisits } from '@/data/queries/useHealth';
import type { VetVisit } from '@/data/types';
import { VET_VISIT_TYPE_META, VetVisitCard } from '@/features/health/VetVisitCard';
import { usePetScope } from '@/features/pets/PetScope';
import { relativeTime, toDate } from '@/lib/date';
import { toHref } from '@/lib/deeplinks';
import { formatCurrency, joinWithAnd, plural, possessive } from '@/lib/format';
import { DENIAL_COPY, type DenialReason } from '@/rbac/permissions';
import { useNow, usePermission } from '@/rbac/usePermission';
import { useTheme } from '@/theme';
import {
  Button,
  ConfirmSheet,
  EmptyState,
  ErrorState,
  IconButton,
  Row,
  Screen,
  ScreenHeader,
  StatTile,
  Text,
  Timeline,
  toast,
  useSheet,
  type TimelineEntry,
} from '@/ui';
import { EmptyAppointments, PermissionLocked } from '@/ui/illustrations';
import { SkeletonGroup } from '@/ui/Skeleton';
import { ListRowSkeleton, TimelineSkeleton } from '@/ui/skeletons/ContentSkeletons';

/* ---------------------------------------------------------------- constants */

const STAGGER_CAP = 8;

/* ------------------------------------------------------------------ helpers */

function denial(reason: DenialReason | null): { title: string; body: string } {
  return DENIAL_COPY[reason ?? 'not-granted'];
}

/** Totals per currency — a household that travels can hold two of them. */
function spendByCurrency(visits: readonly VetVisit[]): string[] {
  const totals = new Map<string, number>();
  for (const visit of visits) {
    if (visit.costMinor === null) continue;
    totals.set(visit.currency, (totals.get(visit.currency) ?? 0) + visit.costMinor);
  }
  return [...totals.entries()].map(([currency, minor]) =>
    formatCurrency(minor, currency, { compactZeros: true }),
  );
}

/* ---------------------------------------------------------------- component */

export default function VetVisitsScreen() {
  const t = useTheme();
  const router = useRouter();
  const scope = usePetScope();
  const petId = scope.petId;
  const pet = scope.pet;
  const now = useNow();

  const canView = usePermission('vetvisit.view', petId);
  const canEdit = usePermission('vetvisit.edit', petId);

  const visitsQuery = useVetVisits(canView.allowed ? petId : null);
  const deleteVisit = useDeleteVetVisit(petId);

  const [pendingDelete, setPendingDelete] = useState<VetVisit | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const deleteSheet = useSheet();

  const visits = useMemo(() => {
    const rows = [...(visitsQuery.data ?? [])];
    rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return rows;
  }, [visitsQuery.data]);

  /* ---- the band --------------------------------------------------------- */

  const thisYear = now.getFullYear();
  const yearVisits = useMemo(
    () => visits.filter((visit) => toDate(visit.at)?.getFullYear() === thisYear),
    [thisYear, visits],
  );
  const yearSpend = useMemo(() => spendByCurrency(yearVisits), [yearVisits]);
  const latest = visits[0];

  /* ---- actions ---------------------------------------------------------- */

  const explainWith = useMemo(() => ({ petName: pet?.name ?? null }), [pet?.name]);

  const openRecord = useCallback(
    (id?: string) => {
      router.push(toHref(`/record/vet-visit?petId=${petId}${id ? `&id=${id}` : ''}`));
    },
    [petId, router],
  );

  const edit = useCallback(
    (visit?: VetVisit) => {
      if (canEdit.allowed) openRecord(visit?.id);
      else canEdit.explain(explainWith);
    },
    [canEdit, explainWith, openRecord],
  );

  const askDelete = useCallback(
    (visit: VetVisit) => {
      if (!canEdit.allowed) {
        canEdit.explain(explainWith);
        return;
      }
      setPendingDelete(visit);
      deleteSheet.open();
    },
    [canEdit, deleteSheet, explainWith],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await visitsQuery.refetch();
    } finally {
      setRefreshing(false);
    }
  }, [visitsQuery]);

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

  /* ---- the rail --------------------------------------------------------- */

  const entries = useMemo<TimelineEntry[]>(() => {
    // Seeded with the newest visit's year so the first row carries no header —
    // the now marker directly above it is already that group's heading.
    let lastYear = toDate(visits[0]?.at)?.getFullYear() ?? thisYear;
    return visits.map((visit, index) => {
      const year = toDate(visit.at)?.getFullYear() ?? thisYear;
      const newYear = index > 0 && year !== lastYear;
      lastYear = year;
      const meta = VET_VISIT_TYPE_META[visit.type];

      return {
        id: visit.id,
        title: visit.reason,
        icon: meta.icon,
        tone: meta.tone,
        state: 'done',
        dayLabel: newYear ? String(year) : undefined,
        // The card owns its own press target; a second one on the row would
        // fight it and swallow the long-press.
        content: (
          <VetVisitCard
            visit={visit}
            now={now}
            onPress={() => edit(visit)}
            onLongPress={() => askDelete(visit)}
            disabledReason={editDisabledReason}
          />
        ),
      };
    });
  }, [askDelete, edit, editDisabledReason, now, thisYear, visits]);

  /* ---- chrome ----------------------------------------------------------- */

  const header = (
    <ScreenHeader
      title="Vet visits"
      subtitle={pet ? `Everything ${pet.name} has been seen for` : undefined}
      actions={
        <IconButton
          icon="add"
          accessibilityLabel="Write up a visit"
          accessibilityHint={pet ? `Records a vet visit for ${pet.name}.` : undefined}
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
          headline="Vet visits aren’t part of your access"
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

  if (visitsQuery.isPending || !pet) {
    return (
      <Screen header={header} scroll>
        <SkeletonGroup label="Loading the visit history" gap="xl">
          <ListRowSkeleton count={1} avatar={false} />
          <TimelineSkeleton items={4} />
        </SkeletonGroup>
      </Screen>
    );
  }

  if (visitsQuery.isError) {
    return (
      <Screen header={header} center>
        <ErrorState
          error={visitsQuery.error}
          title="We couldn’t open the visit history"
          body={`${possessive(pet.name)} write-ups are safe — the app just couldn't fetch them this time.`}
          onRetry={() => visitsQuery.refetch()}
        />
      </Screen>
    );
  }

  if (visits.length === 0) {
    return (
      <Screen header={header} center>
        <EmptyState
          illustration={<EmptyAppointments size={t.spacing.colossal * 3} />}
          headline={`No visits written up for ${pet.name} yet`}
          body="Write one up after the next appointment — the diagnosis, what it cost, the paperwork. In a year you'll be very glad it's here."
          action={{
            label: 'Write up a visit',
            icon: 'create-outline',
            onPress: () => edit(),
            disabledReason: editDisabledReason,
            accessibilityHint: 'Opens the visit form.',
          }}
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
          label="Write up a visit"
          onPress={() => edit()}
          variant="primary"
          size="lg"
          fullWidth
          hero
          leftIcon="create-outline"
          disabledReason={editDisabledReason}
          accessibilityHint={`Records a vet visit for ${pet.name}.`}
        />
      }
    >
      <Animated.View entering={enter(0)}>
        <Row gap="md" align="stretch">
          <StatTile
            label="Visits on file"
            value={visits.length}
            icon="medkit-outline"
            size="sm"
            caption={latest ? `Last one ${relativeTime(latest.at)}` : undefined}
          />
          <StatTile
            label={`Spent in ${thisYear}`}
            value={yearSpend.length > 0 ? joinWithAnd(yearSpend) : '—'}
            icon="wallet-outline"
            iconColor="accentText"
            size="sm"
            caption={
              yearVisits.length > 0
                ? `across ${plural(yearVisits.length, 'visit')}`
                : 'Nothing yet this year'
            }
          />
        </Row>
      </Animated.View>

      <Animated.View entering={enter(1)}>
        <Text variant="footnote" color="textSecondary">
          Newest first. Long-press a visit to remove it.
        </Text>
      </Animated.View>

      <Animated.View entering={enter(2)}>
        <Timeline entries={entries} nowIndex={0} nowLabel="Today" />
      </Animated.View>

      <ConfirmSheet
        controller={deleteSheet}
        title="Remove this write-up?"
        body={
          pendingDelete
            ? `“${pendingDelete.reason}” and everything recorded with it — diagnosis, treatment, cost — goes with it.`
            : undefined
        }
        confirmLabel="Remove the visit"
        cancelLabel="Keep it"
        icon="trash-outline"
        onConfirm={async () => {
          if (!pendingDelete) return;
          await deleteVisit.mutateAsync(pendingDelete.id);
          toast.success('Visit removed', {
            description: `It's gone from ${possessive(pet.name)} history.`,
          });
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </Screen>
  );
}
