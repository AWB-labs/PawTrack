/**
 * Medicine — today's doses first, then the prescriptions behind them.
 *
 * The order is the argument. Nobody opens this screen to browse a list of
 * medicines; they open it because something is due. So the day's slots sit at
 * the top with a real "give" control on each, and everything else — adherence,
 * packs, finished courses — is what you scroll to afterwards.
 *
 * Three things this screen is careful about:
 *
 *   · **An early dose costs a hold, not a tap.** A slot that isn't due yet gets
 *     the press-and-hold confirmation, because the failure mode here is a double
 *     dose, not a missed one.
 *   · **`medicine.edit` is owner-only, `medicine.log` is not.** Editing and
 *     refilling are therefore *absent* for a sitter rather than greyed out —
 *     a lock they can never open is a threat, not an explanation — while the
 *     dose buttons stay fully live.
 *   · **Finished courses are kept, collapsed.** A completed course is history a
 *     vet may ask about; deleting it from the screen would be tidier and worse.
 */

import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';

import { useCareTasks } from '@/data/queries/useCareTasks';
import { usePetCaregivers } from '@/data/queries/useCaregivers';
import {
  ADHERENCE_WINDOW_DAYS,
  useAdherence,
  useLogDose,
  useMedicines,
  useTodayDoses,
  useUndoDose,
} from '@/data/queries/useMedicine';
import type { CareTask, ID, Medicine, MedicineLog } from '@/data/types';
import { AdherencePanel } from '@/features/medicine/AdherencePanel';
import {
  dosesPerDay,
  isCourseFinished,
  MEDICINE_FORM_META,
  MedicineCard,
} from '@/features/medicine/MedicineCard';
import { DoseButton, type DoseButtonState } from '@/features/medicine/DoseButton';
import { RefillCard } from '@/features/medicine/RefillCard';
import { usePetScope } from '@/features/pets/PetScope';
import { formatClock, HOUR_MS, nextOccurrences, toDate } from '@/lib/date';
import { toHref } from '@/lib/deeplinks';
import { joinWithAnd, plural, possessive } from '@/lib/format';
import { DENIAL_COPY, type DenialReason } from '@/rbac/permissions';
import { useNow, usePermission } from '@/rbac/usePermission';
import { useCurrentUser } from '@/stores/session';
import { useTheme } from '@/theme';
import {
  Banner,
  Button,
  Chip,
  Column,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  ProgressBar,
  Row,
  Screen,
  ScreenHeader,
  SectionHeader,
  Surface,
  Text,
  toast,
  Touchable,
} from '@/ui';
import { EmptyMedicine, PermissionLocked } from '@/ui/illustrations';
import { SkeletonGroup } from '@/ui/Skeleton';
import { ChartSkeleton, TaskRowSkeleton } from '@/ui/skeletons/ContentSkeletons';

/* ---------------------------------------------------------------- constants */

/** Doses left at or below which the pack is worth mentioning out loud. */
const REFILL_THRESHOLD = 5;

/** Frequencies whose next slot we can honestly project from times-of-day alone. */
const PROJECTABLE = new Set<Medicine['frequency']>([
  'daily',
  'twiceDaily',
  'threeTimesDaily',
]);

/* ------------------------------------------------------------------ helpers */

function denial(reason: DenialReason | null): { title: string; body: string } {
  return DENIAL_COPY[reason ?? 'not-granted'];
}

/**
 * An overdue slot is still `pending` — late is not the same as gone, and the
 * whole point of the screen is that you can catch up. Only a log settles it.
 */
const doseState = (task: CareTask): DoseButtonState =>
  task.state === 'done' ? 'given' : task.state === 'skipped' ? 'skipped' : 'pending';

/** Hand-logged doses are never exact, so match the slot within the hour. */
function findDoseLog(
  logs: readonly MedicineLog[],
  medicineId: ID,
  slot: string,
): MedicineLog | undefined {
  const target = Date.parse(slot);
  let best: MedicineLog | undefined;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const log of logs) {
    if (log.medicineId !== medicineId) continue;
    const delta = Math.abs(Date.parse(log.scheduledFor) - target);
    if (delta <= HOUR_MS && delta < bestDelta) {
      best = log;
      bestDelta = delta;
    }
  }
  return best;
}

/**
 * The next slot still to come. Today's derived tasks are the truth where they
 * exist; beyond that we only project for the frequencies a times-of-day list can
 * honestly describe — guessing at a monthly injection would be worse than
 * saying nothing.
 */
function nextDoseFor(medicine: Medicine, tasks: readonly CareTask[], now: Date): Date | null {
  const pending = tasks
    .filter(
      (task) =>
        task.sourceId === medicine.id && task.state !== 'done' && task.state !== 'skipped',
    )
    .map((task) => toDate(task.at))
    .filter((date): date is Date => date !== null)
    .sort((a, b) => a.getTime() - b.getTime());

  if (pending[0]) return pending[0];
  if (!PROJECTABLE.has(medicine.frequency) || medicine.timesOfDay.length === 0) return null;
  return nextOccurrences(medicine.timesOfDay, null, now)[0] ?? null;
}

/* ---------------------------------------------------------------- component */

export default function MedicineScreen() {
  const t = useTheme();
  const router = useRouter();
  const scope = usePetScope();
  const petId = scope.petId;
  const pet = scope.pet;
  const me = useCurrentUser();
  const now = useNow();

  const petName = pet?.name ?? 'your pet';

  /* ---- permissions ------------------------------------------------------ */

  const canView = usePermission('medicine.view', petId);
  const canLog = usePermission('medicine.log', petId);
  const canEdit = usePermission('medicine.edit', petId);

  const explainWith = useMemo(() => ({ petName }), [petName]);
  const logReason = canLog.allowed ? undefined : denial(canLog.reason).title;

  /* ---- data ------------------------------------------------------------- */

  const gate = canView.allowed ? petId : null;
  const medicinesQuery = useMedicines(gate);
  const dosesQuery = useTodayDoses(gate);
  const tasksQuery = useCareTasks({ petId });
  const caregiversQuery = usePetCaregivers(scope.capabilities.has('caregiver.view') ? petId : null);

  const logDose = useLogDose(petId);
  const undoDose = useUndoDose(petId);

  const [refreshing, setRefreshing] = useState(false);
  const [showFinished, setShowFinished] = useState(false);
  const [focusId, setFocusId] = useState<ID | null>(null);

  /* ---- derived ---------------------------------------------------------- */

  const medicines = useMemo(() => medicinesQuery.data ?? [], [medicinesQuery.data]);
  const todayLogs = useMemo(() => dosesQuery.data ?? [], [dosesQuery.data]);

  const byId = useMemo(() => new Map(medicines.map((row) => [row.id, row])), [medicines]);

  const active = useMemo(
    () => medicines.filter((row) => row.active && !isCourseFinished(row, now)),
    [medicines, now],
  );
  const finished = useMemo(
    () => medicines.filter((row) => !row.active || isCourseFinished(row, now)),
    [medicines, now],
  );

  const doseTasks = useMemo(
    () =>
      (tasksQuery.data ?? [])
        .filter((task) => task.kind === 'medicine' && task.petId === petId)
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
    [petId, tasksQuery.data],
  );

  const progress = useMemo(() => {
    const done = doseTasks.filter((task) => task.state === 'done' || task.state === 'skipped').length;
    return { done, total: doseTasks.length };
  }, [doseTasks]);

  const lowStock = useMemo(
    () =>
      active.filter((row) => row.remainingDoses !== null && row.remainingDoses <= REFILL_THRESHOLD),
    [active],
  );

  const focus = useMemo(
    () => active.find((row) => row.id === focusId) ?? active[0] ?? null,
    [active, focusId],
  );

  const nameFor = useCallback(
    (userId: ID) => {
      if (me && userId === me.id) return 'you';
      const row = (caregiversQuery.data ?? []).find((member) => member.userId === userId);
      return row?.user.displayName ?? 'a caregiver';
    },
    [caregiversQuery.data, me],
  );

  /* ---- actions ---------------------------------------------------------- */

  const give = useCallback(
    (task: CareTask, medicine: Medicine) => {
      if (!canLog.allowed) {
        canLog.explain(explainWith);
        return;
      }
      logDose.mutate({
        medicineId: medicine.id,
        scheduledFor: task.at,
        status: 'given',
        dosage: medicine.dosage,
      });
    },
    [canLog, explainWith, logDose],
  );

  const skip = useCallback(
    (task: CareTask, medicine: Medicine) => {
      if (!canLog.allowed) {
        canLog.explain(explainWith);
        return;
      }
      logDose.mutate({
        medicineId: medicine.id,
        scheduledFor: task.at,
        status: 'skipped',
        dosage: medicine.dosage,
      });
      toast.info(`${medicine.name} marked as skipped`, {
        description: `A skipped dose is worth recording — ${possessive(petName)} vet will want to know.`,
        icon: 'remove-circle-outline',
        haptic: false,
      });
    },
    [canLog, explainWith, logDose, petName],
  );

  const undo = useCallback(
    (task: CareTask, medicine: Medicine) => {
      const log = findDoseLog(todayLogs, medicine.id, task.at);
      if (!log) {
        toast.warning('That dose has already settled', {
          description: 'Pull to refresh and it will be back in step.',
          haptic: false,
        });
        return;
      }
      undoDose.mutate({
        logId: log.id,
        medicineId: medicine.id,
        scheduledFor: log.scheduledFor,
        status: log.status,
      });
    },
    [todayLogs, undoDose],
  );

  const openEditor = useCallback(
    (medicine?: Medicine) => {
      router.push(
        toHref(
          medicine
            ? `/record/medicine?petId=${petId}&id=${medicine.id}`
            : `/record/medicine?petId=${petId}`,
        ),
      );
    },
    [petId, router],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([medicinesQuery.refetch(), dosesQuery.refetch(), tasksQuery.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }, [dosesQuery, medicinesQuery, tasksQuery]);

  /* ---- gates ------------------------------------------------------------ */

  if (scope.isForbidden) {
    return (
      <Screen center header={<ScreenHeader title="Medicine" large={false} />}>
        <EmptyState
          tone="warning"
          illustration={<PermissionLocked size={t.spacing.colossal * 3} />}
          headline="This pet isn’t shared with you"
          body="Your access may have ended, or the invite was never accepted. The owner can send a fresh one whenever you need it."
          action={{ label: 'Back to your pets', icon: 'arrow-back', onPress: () => router.replace(toHref('/pets')) }}
        />
      </Screen>
    );
  }

  if (!canView.allowed) {
    const copy = denial(canView.reason);
    return (
      <Screen center header={<ScreenHeader title="Medicine" large={false} />}>
        <EmptyState
          tone="neutral"
          illustration={<PermissionLocked size={t.spacing.colossal * 3} />}
          headline={copy.title}
          body={copy.body}
          action={{
            label: 'What can I do here?',
            icon: 'help-circle-outline',
            onPress: () => canView.explain(explainWith),
          }}
        />
      </Screen>
    );
  }

  /* ---- chrome ----------------------------------------------------------- */

  const header = (
    <ScreenHeader
      title="Medicine"
      subtitle={pet ? `${possessive(pet.name)} prescriptions` : undefined}
      actions={
        canEdit.allowed ? (
          <IconButton
            icon="add"
            accessibilityLabel="Add a medicine"
            accessibilityHint={`Adds a prescription for ${petName}.`}
            variant="tonal"
            tone="primary"
            onPress={() => openEditor()}
          />
        ) : null
      }
      accessory={
        progress.total > 0 ? (
          <ProgressBar
            value={progress.done / progress.total}
            tone={progress.done >= progress.total ? 'success' : 'primary'}
            gradient={progress.done >= progress.total}
            size="sm"
            label={
              progress.done >= progress.total
                ? `Every dose is in for today 💚`
                : `${progress.total - progress.done} still to give today`
            }
            trailingLabel={`${progress.done}/${progress.total}`}
            accessibilityLabel={`${progress.done} of ${progress.total} doses given today for ${petName}`}
          />
        ) : undefined
      }
    />
  );

  if (medicinesQuery.isPending) {
    return (
      <Screen header={header} scroll>
        <SkeletonGroup label={`Loading ${possessive(petName)} medicines`} gap="xl">
          <TaskRowSkeleton count={3} />
          <ChartSkeleton bars={7} />
        </SkeletonGroup>
      </Screen>
    );
  }

  if (medicinesQuery.isError) {
    return (
      <Screen header={header} center>
        <ErrorState
          error={medicinesQuery.error}
          title="We couldn’t open the medicine list"
          body={`Every dose you've logged is safe — the prescriptions just didn't come back this time.`}
          onRetry={() => medicinesQuery.refetch()}
        />
      </Screen>
    );
  }

  if (medicines.length === 0) {
    return (
      <Screen header={header} center>
        <EmptyState
          illustration={<EmptyMedicine size={t.spacing.colossal * 2.4} />}
          headline={`${petName} isn’t on any medication`}
          body={
            canEdit.allowed
              ? 'If that changes, add the prescription here and Furry Tracker will handle the dose times, the reminders and the refill nudge.'
              : `Nothing has been prescribed for ${petName}. If that changes, the owner will add it here.`
          }
          action={
            canEdit.allowed
              ? { label: 'Add a medicine', icon: 'add-circle-outline', onPress: () => openEditor() }
              : undefined
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
      contentContainerStyle={{ gap: t.spacing.xl, paddingBottom: t.spacing.giant }}
    >
      {lowStock.length > 0 ? (
        <Banner
          tone="warning"
          icon="bandage-outline"
          title={`${joinWithAnd(lowStock.map((row) => row.name))} running low`}
          message={
            canEdit.allowed
              ? 'Record a refill below once the new pack is in, and the count starts again.'
              : `Worth mentioning to ${possessive(petName)} owner — only they can update the pack.`
          }
        />
      ) : null}

      <Column gap="md">
        <SectionHeader
          title="Today"
          subtitle={
            doseTasks.length === 0
              ? `Nothing scheduled for ${petName} today.`
              : `${plural(doseTasks.length, 'dose')} on the list.`
          }
          icon="time-outline"
          iconColor="primaryText"
          first
        />

        {doseTasks.length === 0 ? (
          <Surface variant="surfaceAlt" radius="xl" padding="base" border>
            <Text variant="footnote" color="textSecondary">
              No doses fall today. {possessive(petName)} next one shows up here the moment it does.
            </Text>
          </Surface>
        ) : (
          <Surface variant="surface" elevation={1} radius="xxl" padding="base" style={{ gap: t.spacing.base }}>
            {doseTasks.map((task, index) => {
              const medicine = byId.get(task.sourceId);
              if (!medicine) return null;
              const state = doseState(task);
              const log = findDoseLog(todayLogs, medicine.id, task.at);

              return (
                <Animated.View
                  key={task.id}
                  layout={LinearTransition.duration(t.motion.duration.base)}
                  entering={
                    t.reduceMotion
                      ? FadeIn.duration(t.motion.duration.base)
                      : FadeIn.duration(t.motion.duration.slow)
                          .delay(Math.min(index, 8) * t.motion.stagger.base)
                          .easing(t.motion.easing.decelerate)
                  }
                  style={{ gap: t.spacing.sm }}
                >
                  {index > 0 ? (
                    <View
                      style={{ height: t.borderWidth.hairline, backgroundColor: t.color.divider }}
                    />
                  ) : null}

                  <Row gap="md" align="center" style={{ paddingTop: index > 0 ? t.spacing.sm : 0 }}>
                    <Text
                      variant="title3"
                      tabular
                      numberOfLines={1}
                      style={{ width: t.spacing.giant + t.spacing.sm }}
                    >
                      {formatClock(task.at)}
                    </Text>
                    <Column flex gap="hair">
                      <Text variant="headline" numberOfLines={1}>
                        {medicine.name}
                      </Text>
                      <Row gap="xxs">
                        <Icon name={MEDICINE_FORM_META[medicine.form].icon} size="xs" color="textTertiary" />
                        <Text variant="caption" color="textTertiary" numberOfLines={1}>
                          {medicine.dosage}
                          {medicine.withFood ? ' · with food' : ''}
                        </Text>
                      </Row>
                    </Column>
                  </Row>

                  <Row gap="sm" align="center">
                    <DoseButton
                      state={state}
                      hint={medicine.withFood ? 'With food' : undefined}
                      doneLabel={
                        log?.at
                          ? `Given ${formatClock(log.at)} by ${nameFor(log.loggedBy)}`
                          : state === 'skipped'
                            ? 'Skipped'
                            : undefined
                      }
                      // A dose that isn't due yet is the one worth slowing down.
                      hold={task.state === 'upcoming'}
                      emphasis={task.state === 'due' || task.state === 'overdue' ? 'high' : 'quiet'}
                      onGive={() => give(task, medicine)}
                      onUndo={canLog.allowed ? () => undo(task, medicine) : undefined}
                      disabledReason={logReason}
                      accessibilityLabel={`Give ${medicine.name}, ${medicine.dosage}, due ${formatClock(task.at)}`}
                      style={{ flex: 1 }}
                    />
                    {state === 'pending' ? (
                      <IconButton
                        icon="remove-circle-outline"
                        accessibilityLabel={`Skip ${medicine.name}`}
                        accessibilityHint="Records the dose as deliberately skipped."
                        variant="tonal"
                        tone="neutral"
                        onPress={() => skip(task, medicine)}
                        disabledReason={logReason}
                      />
                    ) : null}
                  </Row>
                </Animated.View>
              );
            })}
          </Surface>
        )}
      </Column>

      {active.length > 0 ? (
        <Column gap="md">
          <SectionHeader
            title="On the go"
            subtitle={`${plural(active.length, 'course')} ${petName} is on right now.`}
            icon="medkit-outline"
            iconColor="primaryText"
          />
          {active.map((medicine, index) => (
            <ActiveMedicine
              key={medicine.id}
              petId={petId}
              petName={petName}
              medicine={medicine}
              tasks={doseTasks}
              index={index}
              now={now}
              canEdit={canEdit.allowed}
              onEdit={() => openEditor(medicine)}
            />
          ))}
        </Column>
      ) : null}

      {focus ? (
        <Column gap="md">
          <SectionHeader
            title="Sticking to it"
            subtitle={`How ${possessive(petName)} doses have actually gone.`}
            icon="pulse-outline"
            iconColor="accentText"
          />
          {active.length > 1 ? (
            <Row gap="sm" wrap>
              {active.map((medicine) => (
                <Chip
                  key={medicine.id}
                  label={medicine.name}
                  selected={medicine.id === focus.id}
                  onPress={() => setFocusId(medicine.id)}
                  size="sm"
                  accessibilityHint={`Shows adherence for ${medicine.name}.`}
                />
              ))}
            </Row>
          ) : null}
          <AdherencePanel petId={petId} petName={petName} medicine={focus} />
        </Column>
      ) : null}

      {canEdit.allowed && active.some((row) => row.remainingDoses !== null) ? (
        <Column gap="md">
          <SectionHeader
            title="Packs & refills"
            subtitle="How long what you have will last."
            icon="bandage-outline"
            iconColor="textTertiary"
          />
          {active
            .filter((row) => row.remainingDoses !== null)
            .map((medicine) => (
              <RefillCard key={medicine.id} petId={petId} petName={petName} medicine={medicine} />
            ))}
        </Column>
      ) : null}

      {finished.length > 0 ? (
        <Column gap="md">
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={`Finished and paused, ${plural(finished.length, 'medicine')}`}
            accessibilityHint={showFinished ? 'Collapses the list.' : 'Shows the full list.'}
            accessibilityState={{ expanded: showFinished }}
            haptic="tap"
            onPress={() => setShowFinished((current) => !current)}
            pressScale="large"
          >
            <Surface variant="surfaceAlt" radius="xl" padding="base" border>
              <Row gap="md">
                <Icon name="archive-outline" size="md" color="textSecondary" />
                <Column flex gap="hair">
                  <Text variant="headline" color="textSecondary">
                    Finished & paused
                  </Text>
                  <Text variant="caption" color="textTertiary">
                    {plural(finished.length, 'course')} kept on file for the vet.
                  </Text>
                </Column>
                <Icon name={showFinished ? 'chevron-up' : 'chevron-down'} size="sm" color="textTertiary" />
              </Row>
            </Surface>
          </Touchable>

          {showFinished ? (
            <Animated.View
              entering={FadeIn.duration(t.motion.duration.base)}
              layout={LinearTransition.duration(t.motion.duration.base)}
              style={{ gap: t.spacing.md }}
            >
              {finished.map((medicine, index) => (
                <MedicineCard
                  key={medicine.id}
                  medicine={medicine}
                  petName={petName}
                  index={index}
                  onEdit={canEdit.allowed ? () => openEditor(medicine) : undefined}
                />
              ))}
            </Animated.View>
          ) : null}
        </Column>
      ) : null}

      {canEdit.allowed ? (
        <Button
          label="Add another medicine"
          onPress={() => openEditor()}
          variant="tonal"
          size="md"
          fullWidth
          leftIcon="add-circle-outline"
          accessibilityHint={`Adds a prescription for ${petName}.`}
        />
      ) : null}
    </Screen>
  );
}

/* --------------------------------------------------------- active medicine */

type ActiveMedicineProps = {
  petId: ID;
  petName: string;
  medicine: Medicine;
  tasks: readonly CareTask[];
  index: number;
  now: Date;
  canEdit: boolean;
  onEdit: () => void;
};

/**
 * One card per live course. The adherence query lives here rather than in the
 * screen so each card owns its own ring — React Query dedupes the fetches, and
 * a list of three medicines is three cheap reads, not a waterfall.
 */
function ActiveMedicine({
  petId,
  petName,
  medicine,
  tasks,
  index,
  now,
  canEdit,
  onEdit,
}: ActiveMedicineProps) {
  const adherence = useAdherence(petId, medicine.id, ADHERENCE_WINDOW_DAYS);

  const mine = useMemo(() => tasks.filter((task) => task.sourceId === medicine.id), [medicine.id, tasks]);
  const today = useMemo(
    () => ({
      given: mine.filter((task) => task.state === 'done').length,
      expected: mine.length,
    }),
    [mine],
  );

  const nextDoseAt = useMemo(() => nextDoseFor(medicine, mine, now), [medicine, mine, now]);
  const perDay = dosesPerDay(medicine.frequency);

  return (
    <MedicineCard
      medicine={medicine}
      petName={petName}
      adherence={adherence.data?.rate ?? null}
      today={today}
      nextDoseAt={nextDoseAt}
      refillThreshold={Math.max(REFILL_THRESHOLD, Math.ceil(perDay * 3))}
      index={index}
      onEdit={canEdit ? onEdit : undefined}
    />
  );
}
