/**
 * The pet profile — the hub every other pet screen hangs off.
 *
 * It is deliberately *not* a menu. A list of seven grey rows saying "Feeding",
 * "Medicine", "Health" tells you nothing you didn't already know; each card here
 * carries the one fact you opened the app to find — when the next meal is, how
 * many doses are left, whether a vaccination has gone past due — so most visits
 * end without a second tap.
 *
 * Three things the screen is careful about:
 *
 *   · **Reads are gated as hard as writes.** The adapter asserts a capability on
 *     every list call, so a section the viewer can't see isn't fetched at all —
 *     passing `null` for the pet id is what disables the query. A sitter without
 *     `medicine.view` never generates a permission error just by arriving.
 *   · **Owner-only actions are absent, not disabled.** Edit, invite and delete
 *     are things a caregiver can never be granted, so showing them greyed out
 *     would read as a threat rather than an explanation. Everything a sitter
 *     *could* have been granted stays visible, dimmed, and explains itself.
 *   · **Deleting names what is lost.** The confirm sheet counts the real rows —
 *     weigh-ins, vaccinations, people — because "this cannot be undone" is a
 *     sentence nobody reads.
 */

import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { useCareTasks } from '@/data/queries/useCareTasks';
import { usePetActivity, usePetCaregivers } from '@/data/queries/useCaregivers';
import { useFeedingSchedules } from '@/data/queries/useFeeding';
import { useVaccinations, useVetVisits, useWeights } from '@/data/queries/useHealth';
import { useMedicineLogs, useMedicines } from '@/data/queries/useMedicine';
import { useDeletePet, usePet } from '@/data/queries/usePets';
import { useUser } from '@/data/queries/useUsers';
import { SPECIES_META, type CareTask, type Pet } from '@/data/types';
import type { PetStatusChip } from '@/features/pets/PetCard';
import { PetHero, PetHeroBar, type PetHeroAction } from '@/features/pets/PetHero';
import { usePetScope } from '@/features/pets/PetScope';
import { PetStatRow } from '@/features/pets/PetStatRow';
import { DAY_MS, dueLabel, formatTimeOfDay, friendlyDate, relativeTime } from '@/lib/date';
import { toHref } from '@/lib/deeplinks';
import { joinWithAnd, plural, possessive } from '@/lib/format';
import { AccessSummaryCard } from '@/rbac/AccessSummaryCard';
import { DENIAL_COPY, type Capability, type DenialReason } from '@/rbac/permissions';
import { useNow, usePermission } from '@/rbac/usePermission';
import { useTheme } from '@/theme';
import {
  AvatarStack,
  Badge,
  Button,
  Card,
  Column,
  ConfirmSheet,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  ListRow,
  ProgressBar,
  Row,
  Screen,
  SectionHeader,
  Surface,
  Text,
  toast,
  useSheet,
  type AvatarStackItem,
  type BadgeTone,
  type IconName,
  type ListRowIconTone,
} from '@/ui';
import { PermissionLocked } from '@/ui/illustrations';
import { SkeletonGroup } from '@/ui/Skeleton';
import {
  ChartSkeleton,
  ListRowSkeleton,
  ProfileHeaderSkeleton,
} from '@/ui/skeletons/ContentSkeletons';

/* ---------------------------------------------------------------- constants */

/** Window the "doses given" figure is calculated over. */
const ADHERENCE_DAYS = 30;

/** A vaccination further out than this isn't news yet. */
const VACCINATION_HORIZON_DAYS = 60;

/** Doses left before the refill nudge appears on the medicine card. */
const REFILL_THRESHOLD = 5;

const STAGGER_CAP = 8;

/* ------------------------------------------------------------------ helpers */

/** Authored denial copy, never a raw reason code. */
function denial(reason: DenialReason | null): { title: string; body: string } {
  return DENIAL_COPY[reason ?? 'not-granted'];
}

/* ---------------------------------------------------------------- component */

export default function PetProfileScreen() {
  const t = useTheme();
  const router = useRouter();
  const scope = usePetScope();
  const petId = scope.petId;

  const petQuery = usePet(petId);
  const pet = scope.pet ?? petQuery.data ?? null;

  const can = scope.capabilities;
  const owner = useUser(pet?.ownerId);
  const ownerName = owner.data?.displayName ?? null;

  const deletePet = useDeletePet();
  const deleteSheet = useSheet();
  const [refreshing, setRefreshing] = useState(false);

  /* ---- permissions ------------------------------------------------------ */

  const logMeal = usePermission('feeding.log', petId);
  const logDose = usePermission('medicine.log', petId);
  const logWeight = usePermission('weight.log', petId);

  const seeWeight = usePermission('weight.view', petId);
  const seeMedicine = usePermission('medicine.view', petId);

  /* ---- reads, each disabled unless its capability is held --------------- */

  const gated = useCallback(
    (capability: Capability) => (can.has(capability) ? petId : null),
    [can, petId],
  );

  const since = useMemo(() => new Date(Date.now() - ADHERENCE_DAYS * DAY_MS).toISOString(), []);

  const tasksQuery = useCareTasks({ petId });
  const schedulesQuery = useFeedingSchedules(gated('feeding.view'));
  const medicinesQuery = useMedicines(seeMedicine.allowed ? petId : null);
  const doseLogsQuery = useMedicineLogs(seeMedicine.allowed ? petId : null, { since });
  const weightsQuery = useWeights(seeWeight.allowed ? petId : null);
  const vaccinationsQuery = useVaccinations(gated('vaccination.view'));
  const vetVisitsQuery = useVetVisits(gated('vetvisit.view'));
  const caregiversQuery = usePetCaregivers(gated('caregiver.view'));
  const activityQuery = usePetActivity(gated('activity.view'));

  /* ---- derived ---------------------------------------------------------- */

  // The shared 30s clock, so "overdue" flips on its own rather than at the next
  // navigation — the same clock every permission verdict on this screen reads.
  const now = useNow().getTime();
  const tasks = useMemo<readonly CareTask[]>(() => tasksQuery.data ?? [], [tasksQuery.data]);

  const today = useMemo(() => {
    let done = 0;
    let overdue = 0;
    for (const task of tasks) {
      if (task.state === 'done' || task.state === 'skipped') done += 1;
      if (task.state === 'overdue') overdue += 1;
    }
    return { total: tasks.length, done, overdue };
  }, [tasks]);

  const schedules = useMemo(() => schedulesQuery.data ?? [], [schedulesQuery.data]);
  const medicines = useMemo(() => medicinesQuery.data ?? [], [medicinesQuery.data]);
  const weights = weightsQuery.data ?? [];
  const vaccinations = useMemo(() => vaccinationsQuery.data ?? [], [vaccinationsQuery.data]);
  const vetVisits = vetVisitsQuery.data ?? [];
  const caregivers = useMemo(() => caregiversQuery.data ?? [], [caregiversQuery.data]);
  const activity = activityQuery.data ?? [];

  const adherence = useMemo(() => {
    const rows = doseLogsQuery.data ?? [];
    if (rows.length === 0) return null;
    const given = rows.filter((row) => row.status === 'given').length;
    return given / rows.length;
  }, [doseLogsQuery.data]);

  const activeMedicines = useMemo(() => medicines.filter((row) => row.active), [medicines]);

  const lowStock = useMemo(
    () =>
      activeMedicines.find(
        (row) => row.remainingDoses !== null && row.remainingDoses <= REFILL_THRESHOLD,
      ) ?? null,
    [activeMedicines],
  );

  const dueVaccination = useMemo(() => {
    const dated = vaccinations.filter((row) => row.dueAt !== null);
    const overdue = dated
      .filter((row) => Date.parse(row.dueAt ?? '') < now)
      .sort((a, b) => Date.parse(a.dueAt ?? '') - Date.parse(b.dueAt ?? ''))[0];
    if (overdue) return { row: overdue, overdue: true };
    const soon = dated
      .filter((row) => {
        const delta = Date.parse(row.dueAt ?? '') - now;
        return delta >= 0 && delta <= VACCINATION_HORIZON_DAYS * DAY_MS;
      })
      .sort((a, b) => Date.parse(a.dueAt ?? '') - Date.parse(b.dueAt ?? ''))[0];
    return soon ? { row: soon, overdue: false } : null;
  }, [now, vaccinations]);

  /** The next meal, whether that's a live task today or just the schedule. */
  const nextMeal = useMemo<CareTask | { time: string; label: string } | null>(() => {
    const upcoming = tasks
      .filter(
        (task) => task.kind === 'feeding' && (task.state === 'due' || task.state === 'upcoming'),
      )
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
    if (upcoming) return upcoming;
    const first = schedules
      .filter((row) => row.active)
      .sort((a, b) => a.time.localeCompare(b.time))[0];
    return first ? { time: first.time, label: first.label } : null;
  }, [schedules, tasks]);

  const flags = useMemo<PetStatusChip[]>(() => {
    if (!pet) return [];
    const chips: PetStatusChip[] = [];
    if (pet.allergies.length > 0) {
      chips.push({
        id: 'allergies',
        label: `No ${joinWithAnd(pet.allergies).toLowerCase()}`,
        icon: 'warning-outline',
        tone: 'warning',
      });
    }
    for (const condition of pet.conditions) {
      chips.push({
        id: `condition-${condition}`,
        label: condition,
        icon: 'pulse-outline',
        tone: 'info',
      });
    }
    return chips;
  }, [pet]);

  const caregiverAvatars = useMemo<AvatarStackItem[]>(
    () =>
      caregivers.map((row) => ({
        id: row.id,
        name: row.user.displayName,
        uri: row.user.avatarUrl,
        ring: row.role === 'owner',
      })),
    [caregivers],
  );

  /* ---- actions ---------------------------------------------------------- */

  const open = useCallback((path: string) => router.push(toHref(path)), [router]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([petQuery.refetch(), tasksQuery.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }, [petQuery, tasksQuery]);

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

  /* ---- states ----------------------------------------------------------- */

  if (scope.isForbidden) {
    return (
      <Screen center>
        <EmptyState
          tone="warning"
          illustration={<PermissionLocked size={t.spacing.colossal * 3} />}
          headline="This pet isn’t shared with you"
          body="Your access may have ended, or the invite was never accepted. The owner can send a fresh one whenever you need it."
          action={{
            label: 'Back to your pets',
            icon: 'arrow-back',
            // A revoked link is usually opened cold, so there may be nothing to
            // go back to — replace rather than pop.
            onPress: () => router.replace(toHref('/pets')),
          }}
        />
      </Screen>
    );
  }

  if (!pet) {
    if (petQuery.isError) {
      return (
        <Screen center>
          <ErrorState
            error={petQuery.error}
            title="We couldn’t open this profile"
            body="Their records are safe — the app just couldn’t fetch them this time."
            onRetry={() => petQuery.refetch()}
          />
        </Screen>
      );
    }

    return (
      <Screen scroll padded={false}>
        <SkeletonGroup label="Loading this pet" gap="xl" style={{ paddingHorizontal: t.gutter }}>
          <ProfileHeaderSkeleton />
          <ChartSkeleton bars={5} />
          <ListRowSkeleton count={4} avatar={false} />
        </SkeletonGroup>
      </Screen>
    );
  }

  /* ---- chrome ----------------------------------------------------------- */

  const header = (
    <PetHeroBar
      pet={pet}
      onBack={() => router.back()}
      actions={
        scope.isOwner ? (
          <>
            <IconButton
              icon="person-add-outline"
              accessibilityLabel="Invite someone to help"
              accessibilityHint={`Shares ${pet.name} with a sitter.`}
              variant="glass"
              tone="neutral"
              onPress={() => open(`/pet/${petId}/invite`)}
            />
            <IconButton
              icon="pencil"
              accessibilityLabel="Edit profile"
              accessibilityHint={`Opens ${possessive(pet.name)} details.`}
              variant="glass"
              tone="neutral"
              onPress={() => open(`/pet/${petId}/edit`)}
            />
          </>
        ) : null
      }
    />
  );

  const explainWith = { petName: pet.name, ownerName };

  const quickActions: PetHeroAction[] = [
    {
      id: 'meal',
      label: 'Log a meal',
      icon: 'restaurant-outline',
      tone: 'accent',
      onPress: logMeal.allowed
        ? () => open(`/pet/${petId}/feeding`)
        : () => logMeal.explain(explainWith),
      disabledReason: logMeal.allowed ? undefined : denial(logMeal.reason).title,
    },
    {
      id: 'dose',
      label: 'Give medicine',
      icon: 'medical-outline',
      tone: 'primary',
      onPress: logDose.allowed
        ? () => open(`/pet/${petId}/medicine`)
        : () => logDose.explain(explainWith),
      disabledReason: logDose.allowed ? undefined : denial(logDose.reason).title,
    },
    {
      id: 'weight',
      label: 'Weigh in',
      icon: 'fitness-outline',
      tone: 'success',
      onPress: logWeight.allowed
        ? () => open(`/record/weight?petId=${petId}`)
        : () => logWeight.explain(explainWith),
      disabledReason: logWeight.allowed ? undefined : denial(logWeight.reason).title,
    },
  ];

  /* ---- section summaries ------------------------------------------------ */

  const feedingSummary = (() => {
    if (nextMeal && 'kind' in nextMeal) {
      return nextMeal.state === 'due'
        ? `${nextMeal.title} is due now`
        : `Next up: ${nextMeal.title}, ${nextMeal.subtitle}`;
    }
    if (nextMeal) return `${nextMeal.label} at ${formatTimeOfDay(nextMeal.time)}`;
    return `No mealtimes set for ${pet.name} yet`;
  })();

  const medicineSummary = activeMedicines.length === 0
    ? 'Nothing prescribed right now'
    : lowStock
      ? `${lowStock.name} — ${plural(lowStock.remainingDoses ?? 0, 'dose')} left in the pack`
      : joinWithAnd(activeMedicines.slice(0, 2).map((row) => row.name));

  const weightSummary = (() => {
    const latest = weights[weights.length - 1];
    if (!latest) return 'No weigh-ins yet — the first one starts the chart';
    return `Last weighed ${relativeTime(latest.recordedAt)}`;
  })();

  const vaccinationSummary = (() => {
    if (vaccinations.length === 0) return `Nothing on file for ${pet.name} yet`;
    if (dueVaccination) return `${dueVaccination.row.name} ${dueLabel(dueVaccination.row.dueAt ?? '')}`;
    return `${plural(vaccinations.length, 'record')} — all up to date`;
  })();

  const vetSummary = (() => {
    const latest = vetVisits[0];
    if (!latest) return 'No visits written up yet';
    return `${latest.reason} · ${friendlyDate(latest.at)}`;
  })();

  /* ---- content ---------------------------------------------------------- */

  return (
    <Screen
      header={header}
      scroll
      padded={false}
      refreshing={refreshing}
      onRefresh={() => {
        void refresh();
      }}
      contentContainerStyle={{ gap: t.spacing.lg, paddingBottom: t.spacing.giant }}
    >
      <PetHero
        pet={pet}
        membership={scope.membership}
        flags={flags}
        actions={quickActions}
        onPhotoPress={scope.isOwner ? () => open(`/pet/${petId}/edit`) : undefined}
      />

      <PetStatRow
        pet={pet}
        weights={weights}
        adherence={adherence}
        loading={seeWeight.allowed && weightsQuery.isPending}
        onPressWeight={
          seeWeight.allowed
            ? () => open(`/pet/${petId}/weight`)
            : () => seeWeight.explain(explainWith)
        }
        onPressAge={scope.isOwner ? () => open(`/pet/${petId}/edit`) : undefined}
        onPressMedicine={
          seeMedicine.allowed
            ? () => open(`/pet/${petId}/medicine`)
            : () => seeMedicine.explain(explainWith)
        }
        weightDisabledReason={seeWeight.allowed ? undefined : denial(seeWeight.reason).title}
        medicineDisabledReason={seeMedicine.allowed ? undefined : denial(seeMedicine.reason).title}
      />

      <View style={{ paddingHorizontal: t.gutter, gap: t.spacing.lg }}>
        {scope.isCaregiver ? (
          <Animated.View entering={enter(0)}>
            <AccessSummaryCard
              petId={petId}
              petName={pet.name}
              ownerName={ownerName}
              species={pet.species}
            />
          </Animated.View>
        ) : null}

        {today.total > 0 ? (
          <Animated.View entering={enter(1)}>
            <TodayBand
              petName={pet.name}
              done={today.done}
              total={today.total}
              overdue={today.overdue}
            />
          </Animated.View>
        ) : null}

        <Animated.View entering={enter(2)} style={{ gap: t.spacing.md }}>
          <SectionHeader
            title="Everyday care"
            subtitle={`The two things ${pet.name} needs from you most days.`}
            icon="sunny-outline"
            iconColor="accentText"
            first
          />

          <SectionCard
            capability="feeding.view"
            petId={petId}
            explainWith={explainWith}
            title="Feeding"
            summary={feedingSummary}
            icon="restaurant-outline"
            tone="accent"
            value={schedules.length > 0 ? plural(schedules.length, 'meal') : undefined}
            loading={schedulesQuery.isPending}
            onPress={() => open(`/pet/${petId}/feeding`)}
            accessibilityHint={`Opens ${possessive(pet.name)} feeding schedule.`}
          />

          <SectionCard
            capability="medicine.view"
            petId={petId}
            explainWith={explainWith}
            title="Medicine"
            summary={medicineSummary}
            icon="medical-outline"
            tone="primary"
            value={activeMedicines.length > 0 ? plural(activeMedicines.length, 'active') : undefined}
            badge={lowStock ? { label: 'Refill soon', tone: 'warning' } : undefined}
            loading={medicinesQuery.isPending}
            onPress={() => open(`/pet/${petId}/medicine`)}
            accessibilityHint={`Opens ${possessive(pet.name)} medicines.`}
          />
        </Animated.View>

        <Animated.View entering={enter(3)} style={{ gap: t.spacing.md }}>
          <SectionHeader
            title="Health record"
            subtitle="The paperwork your vet asks for, kept where you can find it."
            icon="heart-outline"
            iconColor="primaryText"
          />

          <SectionCard
            capability="weight.view"
            petId={petId}
            explainWith={explainWith}
            title="Weight & growth"
            summary={weightSummary}
            icon="fitness-outline"
            tone="success"
            value={weights.length > 0 ? plural(weights.length, 'entry', 'entries') : undefined}
            loading={weightsQuery.isPending}
            onPress={() => open(`/pet/${petId}/weight`)}
            accessibilityHint="Opens the weight chart."
          />

          <SectionCard
            capability="vaccination.view"
            petId={petId}
            explainWith={explainWith}
            title="Vaccinations"
            summary={vaccinationSummary}
            icon="shield-checkmark-outline"
            tone={dueVaccination?.overdue ? 'danger' : 'info'}
            badge={
              dueVaccination
                ? {
                    label: dueVaccination.overdue ? 'Overdue' : 'Due soon',
                    tone: dueVaccination.overdue ? 'danger' : 'warning',
                  }
                : undefined
            }
            loading={vaccinationsQuery.isPending}
            onPress={() => open(`/pet/${petId}/vaccinations`)}
            accessibilityHint="Opens the vaccination record."
          />

          <SectionCard
            capability="vetvisit.view"
            petId={petId}
            explainWith={explainWith}
            title="Vet visits"
            summary={vetSummary}
            icon="medkit-outline"
            tone="info"
            value={vetVisits.length > 0 ? plural(vetVisits.length, 'visit') : undefined}
            loading={vetVisitsQuery.isPending}
            onPress={() => open(`/pet/${petId}/vet-visits`)}
            accessibilityHint="Opens the vet visit history."
          />
        </Animated.View>

        {scope.isOwner ? (
          <Animated.View entering={enter(4)} style={{ gap: t.spacing.md }}>
            <SectionHeader
              title="People & history"
              subtitle={`Who can help with ${pet.name}, and everything that's been logged.`}
              icon="people-outline"
              iconColor="accentText"
            />

            <CaregiverCard
              count={caregivers.length}
              avatars={caregiverAvatars}
              loading={caregiversQuery.isPending}
              petName={pet.name}
              onOpen={() => open(`/pet/${petId}/caregivers`)}
              onInvite={() => open(`/pet/${petId}/invite`)}
            />

            <SectionCard
              capability="activity.view"
              petId={petId}
              explainWith={explainWith}
              title="Activity"
              summary={
                activity[0]
                  ? `${activity[0].summary} · ${relativeTime(activity[0].at)}`
                  : 'Nothing logged yet — it starts with the first meal'
              }
              icon="time-outline"
              tone="neutral"
              loading={activityQuery.isPending}
              onPress={() => open(`/pet/${petId}/activity`)}
              accessibilityHint="Opens the full activity log."
            />
          </Animated.View>
        ) : null}

        {scope.isOwner ? (
          <Animated.View entering={enter(5)} style={{ gap: t.spacing.sm }}>
            <SectionHeader title="Manage" variant="overline" />

            <Surface variant="surface" elevation={1} radius="xl" paddingX="base">
              <ListRow
                icon="create-outline"
                title="Edit profile"
                subtitle="Name, breed, birthday, allergies and the microchip"
                onPress={() => open(`/pet/${petId}/edit`)}
                divider
              />
              <ListRow
                icon="person-add-outline"
                iconTone="accent"
                title="Invite a caregiver"
                subtitle="Share exactly what you choose, for exactly as long as you choose"
                onPress={() => open(`/pet/${petId}/invite`)}
                divider
              />
              <ListRow
                icon="trash-outline"
                destructive
                title={`Delete ${pet.name}`}
                subtitle="Removes their whole record — there is no undo"
                chevron={false}
                onPress={() => deleteSheet.open()}
              />
            </Surface>
          </Animated.View>
        ) : null}
      </View>

      <ConfirmSheet
        controller={deleteSheet}
        title={`Delete ${pet.name}?`}
        body={`This removes ${possessive(pet.name)} whole record from Furry Tracker — for you and for everyone you've shared them with. Nothing is archived, and there is no undo.`}
        confirmLabel={`Yes, delete ${pet.name}`}
        cancelLabel={`Keep ${pet.name}`}
        icon="trash-outline"
        onConfirm={async () => {
          await deletePet.mutateAsync(petId);
          toast.success(`${pet.name} has been removed`, {
            description: 'Everything logged for them has gone with it.',
          });
          router.replace(toHref('/pets'));
        }}
      >
        <DeletionManifest
          pet={pet}
          weights={weights.length}
          vaccinations={vaccinations.length}
          vetVisits={vetVisits.length}
          people={Math.max(0, caregivers.length - 1)}
        />
      </ConfirmSheet>
    </Screen>
  );
}

/* ------------------------------------------------------------- today band */

type TodayBandProps = {
  petName: string;
  done: number;
  total: number;
  overdue: number;
};

/**
 * One line of "where are we today", above the record. Deliberately not tappable:
 * this screen is the *file*, the Today tab is the *day*, and a card that jumped
 * you out of the pet you just opened would be a trap.
 */
function TodayBand({ petName, done, total, overdue }: TodayBandProps) {
  const t = useTheme();
  const complete = done >= total;

  const line = complete
    ? `${petName} is all set for today 🎉`
    : overdue > 0
      ? `${plural(overdue, 'thing')} overdue for ${petName}`
      : `${total - done} left to do for ${petName}`;

  return (
    <Surface
      variant="surface"
      elevation={1}
      radius="xxl"
      padding="base"
      style={{ gap: t.spacing.md }}
    >
      <Row gap="md" align="start">
        <Column flex gap="hair">
          <Text variant="headline" numberOfLines={2}>
            {line}
          </Text>
          <Text variant="caption" color="textTertiary" tabular>
            {`${done} of ${total} done`}
          </Text>
        </Column>
        <Icon
          name={complete ? 'checkmark-circle' : overdue > 0 ? 'alert-circle' : 'time-outline'}
          size="md"
          color={complete ? 'success' : overdue > 0 ? 'warning' : 'textTertiary'}
        />
      </Row>
      <ProgressBar
        value={total === 0 ? 1 : done / total}
        tone={overdue > 0 ? 'warning' : complete ? 'success' : 'primary'}
        gradient={complete}
        accessibilityLabel={`${done} of ${total} tasks done today for ${petName}`}
      />
    </Surface>
  );
}

/* ----------------------------------------------------------- section card */

type SectionCardProps = {
  /** What the viewer needs to open this. Gates the card and writes its copy. */
  capability: Capability;
  petId: string;
  explainWith: { petName: string; ownerName: string | null };
  title: string;
  summary: string;
  icon: IconName;
  tone: ListRowIconTone;
  value?: string;
  badge?: { label: string; tone: BadgeTone };
  loading?: boolean;
  onPress: () => void;
  accessibilityHint: string;
};

/**
 * A section of the record, with the one fact worth knowing before you open it.
 *
 * When the viewer lacks the capability the card stays — dimmed, locked, and
 * carrying the real reason — because that is how a sitter learns what to ask
 * the owner for. Ungranted is not the same as forbidden.
 */
function SectionCard({
  capability,
  petId,
  explainWith,
  title,
  summary,
  icon,
  tone,
  value,
  badge,
  loading = false,
  onPress,
  accessibilityHint,
}: SectionCardProps) {
  const t = useTheme();
  const { allowed, reason, explain } = usePermission(capability, petId);
  const well = t.spacing.xxxl;

  const skin = (() => {
    switch (tone) {
      case 'accent':
        return { fill: t.color.accentSoft, ink: t.color.onAccentSoft };
      case 'success':
        return { fill: t.color.successSoft, ink: t.color.onSuccessSoft };
      case 'warning':
        return { fill: t.color.warningSoft, ink: t.color.onWarningSoft };
      case 'danger':
        return { fill: t.color.dangerSoft, ink: t.color.onDangerSoft };
      case 'info':
        return { fill: t.color.infoSoft, ink: t.color.onInfoSoft };
      case 'neutral':
        return { fill: t.color.surfaceAlt, ink: t.color.textSecondary };
      case 'primary':
      default:
        return { fill: t.color.primarySoft, ink: t.color.onPrimarySoft };
    }
  })();

  const copy = denial(reason);
  const line = !allowed ? copy.body : loading ? 'Just a moment…' : summary;

  return (
    <Card
      onPress={allowed ? onPress : () => explain(explainWith)}
      disabledReason={allowed ? undefined : copy.title}
      accessibilityLabel={`${title}. ${line}${value && allowed ? `. ${value}` : ''}`}
      accessibilityHint={allowed ? accessibilityHint : undefined}
      radius="xl"
      padding="base"
      elevation={1}
    >
      <Row gap="md">
        <View
          style={{
            width: well,
            height: well,
            borderRadius: t.radius.md,
            backgroundColor: allowed ? skin.fill : t.color.surfaceAlt,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon
            name={allowed ? icon : 'lock-closed-outline'}
            size="md"
            color={allowed ? skin.ink : t.color.textSecondary}
          />
        </View>

        <Column flex gap="hair">
          <Row gap="xs">
            <Text variant="headline" numberOfLines={1} style={{ flexShrink: 1 }}>
              {title}
            </Text>
            {badge && allowed ? <Badge label={badge.label} tone={badge.tone} size="sm" /> : null}
          </Row>
          <Text variant="footnote" color="textSecondary" numberOfLines={2}>
            {line}
          </Text>
        </Column>

        {value && allowed && !loading ? (
          <Text variant="caption" color="textTertiary" numberOfLines={1} tabular>
            {value}
          </Text>
        ) : null}

        <Icon name="chevron-forward" size="sm" color="textTertiary" />
      </Row>
    </Card>
  );
}

/* -------------------------------------------------------- caregiver card */

type CaregiverCardProps = {
  count: number;
  avatars: AvatarStackItem[];
  loading: boolean;
  petName: string;
  onOpen: () => void;
  onInvite: () => void;
};

function CaregiverCard({ count, avatars, loading, petName, onOpen, onInvite }: CaregiverCardProps) {
  const t = useTheme();
  const others = Math.max(0, count - 1);

  const summary = loading
    ? 'Just a moment…'
    : others === 0
      ? `Only you, for now. Sharing ${petName} takes about ten seconds.`
      : `${plural(others, 'person', 'people')} can help with ${petName}.`;

  return (
    <Card
      onPress={onOpen}
      accessibilityLabel={`Caregivers. ${summary}`}
      accessibilityHint="Opens the list of people who can help."
      radius="xl"
      padding="base"
      gap="md"
      elevation={1}
    >
      <Row gap="md">
        <View
          style={{
            width: t.spacing.xxxl,
            height: t.spacing.xxxl,
            borderRadius: t.radius.md,
            backgroundColor: t.color.accentSoft,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="people-outline" size="md" color="onAccentSoft" />
        </View>
        <Column flex gap="hair">
          <Text variant="headline">Caregivers</Text>
          <Text variant="footnote" color="textSecondary" numberOfLines={2}>
            {summary}
          </Text>
        </Column>
        <Icon name="chevron-forward" size="sm" color="textTertiary" />
      </Row>

      {avatars.length > 0 ? (
        <Row gap="md">
          <AvatarStack
            items={avatars}
            size="sm"
            max={5}
            animate={false}
            label={`${possessive(petName)} people`}
          />
          <View style={{ flex: 1 }} />
          <Button
            label="Invite"
            onPress={onInvite}
            variant="tonal"
            size="sm"
            leftIcon="person-add-outline"
            accessibilityHint={`Creates an invite link for ${petName}.`}
          />
        </Row>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------ deletion manifest */

type DeletionManifestProps = {
  pet: Pet;
  weights: number;
  vaccinations: number;
  vetVisits: number;
  people: number;
};

/**
 * The list of what actually disappears. Counting the rows is the difference
 * between a confirmation people read and one they tap through — "3 vaccination
 * records" is a fact; "this action is irreversible" is boilerplate.
 */
function DeletionManifest({
  pet,
  weights,
  vaccinations,
  vetVisits,
  people,
}: DeletionManifestProps) {
  const t = useTheme();

  const lines = [
    `${SPECIES_META[pet.species].emoji}  ${possessive(pet.name)} profile and photo`,
    weights > 0 ? `📈  ${plural(weights, 'weigh-in')}` : null,
    vaccinations > 0 ? `💉  ${plural(vaccinations, 'vaccination record')}` : null,
    vetVisits > 0 ? `🩺  ${plural(vetVisits, 'vet visit')}` : null,
    people > 0 ? `👥  access for ${plural(people, 'person', 'people')}` : null,
  ].filter((line): line is string => line !== null);

  return (
    <Surface variant="surfaceAlt" radius="lg" padding="base" border style={{ gap: t.spacing.xs }}>
      <Text variant="overline" color="onDangerSoft">
        What goes with them
      </Text>
      {lines.map((line) => (
        <Text key={line} variant="footnote" color="textSecondary">
          {line}
        </Text>
      ))}
    </Surface>
  );
}
