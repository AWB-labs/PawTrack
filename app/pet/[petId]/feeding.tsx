/**
 * Feeding — today's meals, the history behind them, and the timetable itself.
 *
 * This screen is where Petal's permission model is easiest to *see*, and it is
 * built to show it rather than to hide it. A sitter with `feeding.log` gets the
 * full-fat logging experience — swipe, tap, quick-log, undo — while every
 * control that edits the timetable stays visible, dimmed, and explains itself on
 * tap. Two capabilities, two completely different affordances, one screen.
 *
 * The other decisions worth naming:
 *
 *   · **Today is a swipe, not a form.** Right to feed, left to skip, tap for the
 *     sheet when the portion wasn't the usual one. The most repeated action in
 *     the app should cost a thumb-flick.
 *   · **The last meal of the day is a moment.** When logging clears the board,
 *     the confetti fires once. Rarely enough to stay a treat.
 *   · **Deleting a mealtime names what goes with it.** A schedule is small, but
 *     the reminders attached to it aren't, and "this cannot be undone" is a
 *     sentence nobody reads.
 */

import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';

import { useCareTasks } from '@/data/queries/useCareTasks';
import { usePetCaregivers } from '@/data/queries/useCaregivers';
import {
  useDeleteFeedingSchedule,
  useFeedingLogs,
  useFeedingSchedules,
  useLogFeeding,
  useSaveFeedingSchedule,
  useUndoFeedingLog,
} from '@/data/queries/useFeeding';
import type { CareTask, FeedingSchedule, ID } from '@/data/types';
import { FeedingHistory } from '@/features/feeding/FeedingHistory';
import { FeedingScheduleCard, type MealStatus } from '@/features/feeding/FeedingScheduleCard';
import { LogMealSheet } from '@/features/feeding/LogMealSheet';
import { usePetScope } from '@/features/pets/PetScope';
import { compareTimeOfDay, formatTimeOfDay, isSameLocalDay } from '@/lib/date';
import { toHref } from '@/lib/deeplinks';
import { formatPortion, plural, possessive } from '@/lib/format';
import { DENIAL_COPY, type DenialReason } from '@/rbac/permissions';
import { usePermission } from '@/rbac/usePermission';
import { useCurrentUser } from '@/stores/session';
import { useTheme } from '@/theme';
import {
  Banner,
  Button,
  Column,
  confetti,
  ConfirmSheet,
  EmptyState,
  ErrorState,
  IconButton,
  ProgressBar,
  Row,
  Screen,
  ScreenHeader,
  SectionHeader,
  Surface,
  SwipeRow,
  Text,
  toast,
  useSheet,
  type SwipeAction,
} from '@/ui';
import { EmptyFeeding, PermissionLocked } from '@/ui/illustrations';
import { SkeletonGroup } from '@/ui/Skeleton';
import { ChartSkeleton, TaskRowSkeleton } from '@/ui/skeletons/ContentSkeletons';

/* ---------------------------------------------------------------- constants */

/** Enough history for the week chart plus a fortnight of grouped days. */
const LOG_LIMIT = 120;

/* ------------------------------------------------------------------ helpers */

/** Authored denial copy, never a raw reason code. */
function denial(reason: DenialReason | null): { title: string; body: string } {
  return DENIAL_COPY[reason ?? 'not-granted'];
}

/** Where a schedule stands today, from the derived task stream. */
function statusFor(schedule: FeedingSchedule, task: CareTask | undefined): MealStatus {
  if (!schedule.active) return 'paused';
  if (!task) return 'restDay';
  switch (task.state) {
    case 'done':
      return 'done';
    case 'skipped':
      return 'skipped';
    case 'due':
      return 'due';
    case 'overdue':
      return 'overdue';
    case 'upcoming':
    default:
      return 'upcoming';
  }
}

/* ---------------------------------------------------------------- component */

export default function FeedingScreen() {
  const t = useTheme();
  const router = useRouter();
  const scope = usePetScope();
  const petId = scope.petId;
  const pet = scope.pet;
  const me = useCurrentUser();

  const petName = pet?.name ?? 'your pet';

  /* ---- permissions ------------------------------------------------------ */

  const canView = usePermission('feeding.view', petId);
  const canLog = usePermission('feeding.log', petId);
  const canEdit = usePermission('feeding.schedule.edit', petId);

  const explainWith = useMemo(() => ({ petName }), [petName]);
  const logReason = canLog.allowed ? undefined : denial(canLog.reason).title;
  const editReason = canEdit.allowed ? undefined : denial(canEdit.reason).title;

  /* ---- data ------------------------------------------------------------- */

  const gate = canView.allowed ? petId : null;
  const schedulesQuery = useFeedingSchedules(gate);
  const logsQuery = useFeedingLogs(gate, { limit: LOG_LIMIT });
  const tasksQuery = useCareTasks({ petId });
  const caregiversQuery = usePetCaregivers(scope.capabilities.has('caregiver.view') ? petId : null);

  const logMeal = useLogFeeding(petId);
  const undoMeal = useUndoFeedingLog(petId);
  const saveSchedule = useSaveFeedingSchedule(petId);
  const deleteSchedule = useDeleteFeedingSchedule(petId);

  const [refreshing, setRefreshing] = useState(false);
  const [sheetSchedule, setSheetSchedule] = useState<FeedingSchedule | null>(null);
  const [doomed, setDoomed] = useState<FeedingSchedule | null>(null);

  const logSheet = useSheet();
  const deleteSheet = useSheet();

  /* ---- derived ---------------------------------------------------------- */

  const schedules = useMemo(
    () => [...(schedulesQuery.data ?? [])].sort((a, b) => compareTimeOfDay(a.time, b.time)),
    [schedulesQuery.data],
  );
  const logs = useMemo(() => logsQuery.data ?? [], [logsQuery.data]);

  const feedingTasks = useMemo(
    () => (tasksQuery.data ?? []).filter((task) => task.kind === 'feeding' && task.petId === petId),
    [petId, tasksQuery.data],
  );

  const taskByScheduleId = useMemo(() => {
    const map = new Map<ID, CareTask>();
    for (const task of feedingTasks) {
      const scheduleId = task.meta.scheduleId;
      if (typeof scheduleId === 'string') map.set(scheduleId, task);
    }
    return map;
  }, [feedingTasks]);

  const today = useMemo(
    () =>
      schedules
        .filter((schedule) => taskByScheduleId.has(schedule.id))
        .map((schedule) => ({ schedule, task: taskByScheduleId.get(schedule.id) })),
    [schedules, taskByScheduleId],
  );

  const progress = useMemo(() => {
    const done = feedingTasks.filter(
      (task) => task.state === 'done' || task.state === 'skipped',
    ).length;
    return { done, total: feedingTasks.length };
  }, [feedingTasks]);

  const nameFor = useCallback(
    (userId: ID) => {
      if (me && userId === me.id) return 'you';
      const row = (caregiversQuery.data ?? []).find((member) => member.userId === userId);
      return row?.user.displayName ?? null;
    },
    [caregiversQuery.data, me],
  );

  /* ---- actions ---------------------------------------------------------- */

  const celebrateIfCleared = useCallback(
    (justFinished: ID) => {
      const outstanding = feedingTasks.filter(
        (task) =>
          task.meta.scheduleId !== justFinished &&
          task.state !== 'done' &&
          task.state !== 'skipped',
      );
      if (outstanding.length === 0 && feedingTasks.length > 1) confetti.fire();
    },
    [feedingTasks],
  );

  const quickLog = useCallback(
    async (schedule: FeedingSchedule, skipped: boolean) => {
      if (!canLog.allowed) {
        canLog.explain(explainWith);
        return;
      }
      try {
        const log = await logMeal.mutateAsync({
          scheduleId: schedule.id,
          foodName: schedule.foodName,
          portion: skipped ? 0 : schedule.portion,
          unit: schedule.unit,
          skipped,
          note: null,
        });

        toast.undo(
          skipped
            ? `${petName} skipped ${schedule.label.toLowerCase()}`
            : `${schedule.label} logged for ${petName} 🐾`,
          () => undoMeal.mutate({ logId: log.id, scheduleId: log.scheduleId, at: log.at }),
          {
            description: skipped
              ? 'Kept on the record — appetite is the thing a vet asks about.'
              : `${formatPortion(schedule.portion, schedule.unit)} of ${schedule.foodName}`,
            haptic: false,
          },
        );
        if (!skipped) celebrateIfCleared(schedule.id);
      } catch {
        // The mutation rolls its caches back and raises its own toast.
      }
    },
    [canLog, celebrateIfCleared, explainWith, logMeal, petName, undoMeal],
  );

  /**
   * The task stream is derived and carries no log id, so undo works back from
   * the logs we already hold — today's entry for this schedule.
   */
  const undoFor = useCallback(
    (schedule: FeedingSchedule) => {
      const log = logs.find(
        (row) => row.scheduleId === schedule.id && isSameLocalDay(row.at, new Date()),
      );
      if (!log) return undefined;
      return () => undoMeal.mutate({ logId: log.id, scheduleId: log.scheduleId, at: log.at });
    },
    [logs, undoMeal],
  );

  const openLogSheet = useCallback(
    (schedule: FeedingSchedule | null) => {
      if (!canLog.allowed) {
        canLog.explain(explainWith);
        return;
      }
      setSheetSchedule(schedule);
      logSheet.open();
    },
    [canLog, explainWith, logSheet],
  );

  const openEditor = useCallback(
    (schedule?: FeedingSchedule) => {
      if (!canEdit.allowed) {
        canEdit.explain(explainWith);
        return;
      }
      router.push(
        toHref(
          schedule
            ? `/record/feeding-schedule?petId=${petId}&id=${schedule.id}`
            : `/record/feeding-schedule?petId=${petId}`,
        ),
      );
    },
    [canEdit, explainWith, petId, router],
  );

  const toggleActive = useCallback(
    (schedule: FeedingSchedule, active: boolean) => {
      saveSchedule.mutate({
        id: schedule.id,
        label: schedule.label,
        time: schedule.time,
        foodName: schedule.foodName,
        portion: schedule.portion,
        unit: schedule.unit,
        daysOfWeek: schedule.daysOfWeek,
        remindersOn: schedule.remindersOn,
        active,
        notes: schedule.notes,
      });
      toast.info(
        active
          ? `${schedule.label} is back on ${possessive(petName)} timetable`
          : `${schedule.label} paused`,
        {
          description: active
            ? `Reminders resume at ${formatTimeOfDay(schedule.time)}.`
            : 'It stays on file — flick it back on whenever you like.',
          haptic: false,
        },
      );
    },
    [petName, saveSchedule],
  );

  const confirmDelete = useCallback((schedule: FeedingSchedule) => {
    setDoomed(schedule);
    deleteSheet.open();
  }, [deleteSheet]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([schedulesQuery.refetch(), logsQuery.refetch(), tasksQuery.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }, [logsQuery, schedulesQuery, tasksQuery]);

  const swipeActionsFor = useCallback(
    (schedule: FeedingSchedule, status: MealStatus): { left: SwipeAction[]; right: SwipeAction[] } => {
      const settled = status === 'done' || status === 'skipped';
      if (settled) return { left: [], right: [] };
      return {
        left: [
          {
            key: 'fed',
            label: 'Fed',
            icon: 'checkmark',
            tone: 'success',
            fullSwipe: true,
            onPress: () => void quickLog(schedule, false),
            disabledReason: logReason,
          },
        ],
        right: [
          {
            key: 'skip',
            label: 'Skip',
            icon: 'remove',
            tone: 'warning',
            onPress: () => void quickLog(schedule, true),
            disabledReason: logReason,
          },
        ],
      };
    },
    [logReason, quickLog],
  );

  /* ---- gates ------------------------------------------------------------ */

  if (scope.isForbidden) {
    return (
      <Screen center header={<ScreenHeader title="Feeding" large={false} />}>
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
      <Screen center header={<ScreenHeader title="Feeding" large={false} />}>
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
      title="Feeding"
      subtitle={pet ? `${possessive(pet.name)} timetable` : undefined}
      actions={
        canEdit.allowed ? (
          <IconButton
            icon="add"
            accessibilityLabel="Add a mealtime"
            accessibilityHint={`Creates a new scheduled meal for ${petName}.`}
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
            tone={progress.done >= progress.total ? 'success' : 'accent'}
            gradient={progress.done >= progress.total}
            size="sm"
            label={
              progress.done >= progress.total
                ? `${petName} has eaten everything on today's list 🎉`
                : `${progress.total - progress.done} left to go today`
            }
            trailingLabel={`${progress.done}/${progress.total}`}
            accessibilityLabel={`${progress.done} of ${progress.total} meals done today for ${petName}`}
          />
        ) : undefined
      }
    />
  );

  /* ---- loading & error -------------------------------------------------- */

  if (schedulesQuery.isPending) {
    return (
      <Screen header={header} scroll>
        <SkeletonGroup label={`Loading ${possessive(petName)} mealtimes`} gap="xl">
          <TaskRowSkeleton count={3} />
          <ChartSkeleton bars={7} />
        </SkeletonGroup>
      </Screen>
    );
  }

  if (schedulesQuery.isError) {
    return (
      <Screen header={header} center>
        <ErrorState
          error={schedulesQuery.error}
          title="We couldn’t open the timetable"
          body={`${possessive(petName)} mealtimes are safe — the app just couldn’t fetch them this time.`}
          onRetry={() => schedulesQuery.refetch()}
        />
      </Screen>
    );
  }

  /* ---- content ---------------------------------------------------------- */

  const empty = schedules.length === 0;

  return (
    <Screen
      header={header}
      scroll
      refreshing={refreshing}
      onRefresh={() => {
        void refresh();
      }}
      contentContainerStyle={{ gap: t.spacing.lg, paddingBottom: t.spacing.giant }}
    >
      {scope.isCaregiver && canLog.allowed && !canEdit.allowed ? (
        <Banner
          tone="info"
          icon="restaurant-outline"
          title="You can log every meal here"
          message={`Changing ${possessive(petName)} timetable stays with the owner — ask them if a time or a portion needs to move.`}
        />
      ) : null}

      {empty ? (
        <EmptyState
          illustration={<EmptyFeeding size={t.spacing.colossal * 2.4} />}
          headline={`${petName} doesn’t have a mealtime yet`}
          body="Add one and Furry Tracker will nudge you at the right time, keep the portions straight, and build an appetite record your vet will thank you for."
          action={{
            label: 'Set up the first meal',
            icon: 'add-circle-outline',
            onPress: () => openEditor(),
            disabledReason: editReason,
          }}
          secondaryAction={
            canLog.allowed
              ? { label: 'Just log a meal for now', icon: 'restaurant-outline', onPress: () => openLogSheet(null) }
              : undefined
          }
        />
      ) : (
        <>
          <Column gap="md">
            <SectionHeader
              title="Today"
              subtitle={
                today.length === 0
                  ? `Nothing scheduled for ${petName} today — a rest day.`
                  : `${plural(today.length, 'meal')} on the list.`
              }
              icon="sunny-outline"
              iconColor="accentText"
              first
            />

            {today.length === 0 ? (
              <Surface variant="surfaceAlt" radius="xl" padding="base" border>
                <Text variant="footnote" color="textSecondary">
                  Every mealtime on {possessive(petName)} timetable falls on another day this week.
                  You can still log an extra meal below.
                </Text>
              </Surface>
            ) : (
              <Animated.View layout={LinearTransition.duration(t.motion.duration.base)} style={{ gap: t.spacing.md }}>
                {today.map(({ schedule, task }, index) => {
                  const status = statusFor(schedule, task);
                  const actions = swipeActionsFor(schedule, status);
                  const loggedBy = task?.completedBy ? nameFor(task.completedBy) : null;

                  return (
                    <SwipeRow
                      key={schedule.id}
                      left={actions.left}
                      right={actions.right}
                      radius="xxl"
                      background={t.color.surface}
                    >
                      <FeedingScheduleCard
                        schedule={schedule}
                        petName={petName}
                        status={status}
                        loggedBy={loggedBy}
                        loggedAt={task?.completedAt ?? null}
                        index={index}
                        onPress={() => openLogSheet(schedule)}
                        onLog={() => void quickLog(schedule, false)}
                        logLabel={status === 'upcoming' ? 'Log early' : 'Log it'}
                        onUndo={undoFor(schedule)}
                        logDisabledReason={logReason}
                      />
                    </SwipeRow>
                  );
                })}
              </Animated.View>
            )}

            <Button
              label="Log an extra meal"
              onPress={() => openLogSheet(null)}
              variant="tonal"
              size="md"
              fullWidth
              leftIcon="add-circle-outline"
              disabledReason={logReason}
              accessibilityHint={`Records a meal for ${petName} outside the timetable.`}
            />

            <Animated.View entering={FadeIn.duration(t.motion.duration.base)}>
              <Text variant="caption" color="textTertiary" align="center">
                Swipe a meal right to feed, left to skip.
              </Text>
            </Animated.View>
          </Column>

          <Column gap="md">
            <SectionHeader
              title="Appetite"
              subtitle={`What ${petName} has actually been eating.`}
              icon="stats-chart-outline"
              iconColor="primaryText"
            />
            <FeedingHistory
              petName={petName}
              logs={logs}
              schedules={schedules}
              isPending={logsQuery.isPending}
              error={logsQuery.isError ? logsQuery.error : undefined}
              onRetry={() => logsQuery.refetch()}
              onLogFirst={() => openLogSheet(null)}
              logDisabledReason={logReason}
              resolveName={nameFor}
            />
          </Column>

          <Column gap="md">
            <SectionHeader
              title="The timetable"
              subtitle={
                canEdit.allowed
                  ? 'Times, portions and which days each meal runs.'
                  : `Set by ${possessive(petName)} owner. You can log against it, but not change it.`
              }
              icon="calendar-outline"
              iconColor="textTertiary"
              actionLabel="Add"
              onAction={canEdit.allowed ? () => openEditor() : undefined}
              actionDisabledReason={editReason}
            />

            <Animated.View layout={LinearTransition.duration(t.motion.duration.base)} style={{ gap: t.spacing.md }}>
              {schedules.map((schedule, index) => (
                <FeedingScheduleCard
                  key={schedule.id}
                  schedule={schedule}
                  petName={petName}
                  status={schedule.active ? 'upcoming' : 'paused'}
                  index={index}
                  onEdit={() => openEditor(schedule)}
                  onDelete={() => {
                    if (!canEdit.allowed) {
                      canEdit.explain(explainWith);
                      return;
                    }
                    confirmDelete(schedule);
                  }}
                  onToggleActive={(active) => {
                    if (!canEdit.allowed) {
                      canEdit.explain(explainWith);
                      return;
                    }
                    toggleActive(schedule, active);
                  }}
                  editDisabledReason={editReason}
                />
              ))}
            </Animated.View>
          </Column>
        </>
      )}

      <LogMealSheet
        controller={logSheet}
        petId={petId}
        petName={petName}
        schedule={sheetSchedule}
        onLogged={(_log, outcome) => {
          if (outcome === 'fed' && sheetSchedule) celebrateIfCleared(sheetSchedule.id);
        }}
      />

      <ConfirmSheet
        controller={deleteSheet}
        title={doomed ? `Delete ${doomed.label.toLowerCase()}?` : 'Delete this mealtime?'}
        body={
          doomed
            ? `${formatTimeOfDay(doomed.time)}, ${formatPortion(doomed.portion, doomed.unit)} of ${doomed.foodName}. Meals already logged stay on ${possessive(petName)} record — only the schedule and its reminder go.`
            : undefined
        }
        confirmLabel="Delete it"
        cancelLabel="Keep it"
        icon="trash-outline"
        onConfirm={() => {
          if (!doomed) return;
          deleteSchedule.mutate(doomed.id);
          toast.success(`${doomed.label} removed`, {
            description: `${possessive(petName)} other mealtimes are untouched.`,
            haptic: false,
          });
          setDoomed(null);
        }}
        onCancel={() => setDoomed(null)}
      >
        {doomed?.remindersOn ? (
          <Surface variant="surfaceAlt" radius="lg" padding="base" border>
            <Row gap="sm">
              <Text variant="footnote" color="textSecondary" style={{ flex: 1 }}>
                The {formatTimeOfDay(doomed.time)} reminder goes with it.
              </Text>
            </Row>
          </Surface>
        ) : null}
      </ConfirmSheet>
    </Screen>
  );
}
