/**
 * Feeding — schedules and the meals actually given.
 *
 * Logging a meal is the single most-repeated action in Petal, usually with a
 * thumb, often one-handed, sometimes with a dog already climbing the counter.
 * It has to land instantly, so `useLogFeeding` writes three caches optimistically
 * before the adapter is even called:
 *
 *   1. the pet's feeding logs (every cached filter variant of them),
 *   2. **today's care-task stream**, so the tick and the "3 of 7" counter move
 *      together — the task list is derived server-side, so nothing else would
 *      update it until a refetch landed,
 *   3. nothing else — the community feed and the health records have no opinion
 *      about dinner, and refetching them would be the flicker we're avoiding.
 *
 * Undo is the same trick in reverse, which is what makes the toast's Undo
 * button feel like it un-happened rather than like a second request.
 */

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { adapter } from '@/data';
import type { FeedingLogInput, FeedingScheduleInput } from '@/data/adapter';
import {
  captureQueries,
  invalidateAll,
  restoreQueries,
  showErrorToast,
  STALE,
} from '@/data/QueryProvider';
import { careDerivedKeys, queryKeys } from '@/data/queryKeys';
import type { CareTask, FeedingLog, FeedingSchedule, ID, TaskState, Timestamp } from '@/data/types';
import { isSameLocalDay, startOfLocalDayISO } from '@/lib/date';
import { newId } from '@/lib/id';
import { useActor } from '@/stores/session';

/* -------------------------------------------------------------------- types */

export type LogFeedingInput = Omit<FeedingLogInput, 'petId'>;
export type SaveFeedingScheduleInput = Omit<FeedingScheduleInput, 'petId'> & { id?: ID };
export type UndoFeedingInput = {
  logId: ID;
  /** Lets the optimistic pass find the slot to re-open on the Today screen. */
  scheduleId?: ID | null;
  at?: Timestamp;
};

/** Mirrors the adapter's grace window: a slot stays "due" for 90 minutes. */
const GRACE_MS = 90 * 60_000;

function pendingState(at: Timestamp): TaskState {
  const slot = Date.parse(at);
  if (Number.isNaN(slot)) return 'due';
  const now = Date.now();
  if (slot > now) return 'upcoming';
  return now - slot <= GRACE_MS ? 'due' : 'overdue';
}

/**
 * Patch every cached day of the task stream. Filtered variants (one pet, one
 * date) each have their own key, so this walks the whole `care` prefix rather
 * than guessing which ones are mounted.
 */
function patchFeedingTasks(
  client: QueryClient,
  petId: ID,
  scheduleId: ID | null,
  at: Timestamp,
  patch: (task: CareTask) => CareTask,
): void {
  client.setQueriesData<CareTask[]>({ queryKey: queryKeys.careTasks.root }, (tasks) =>
    tasks?.map((task) =>
      task.kind === 'feeding' &&
      task.petId === petId &&
      task.meta.scheduleId === scheduleId &&
      isSameLocalDay(task.at, at)
        ? patch(task)
        : task,
    ),
  );
}

/* -------------------------------------------------------------------- reads */

export function useFeedingSchedules(petId: ID | null | undefined) {
  const { ctx, ready } = useActor();
  const id = petId ?? '';

  return useQuery({
    queryKey: queryKeys.feedingSchedules.forPet(id),
    queryFn: () => adapter.listFeedingSchedules(ctx, id),
    enabled: ready && id !== '',
    staleTime: STALE.medium,
  });
}

export function useFeedingLogs(
  petId: ID | null | undefined,
  opts?: { since?: string; limit?: number },
) {
  const { ctx, ready } = useActor();
  const id = petId ?? '';

  return useQuery({
    queryKey: queryKeys.feedingLogs.list(id, opts),
    queryFn: () => adapter.listFeedingLogs(ctx, id, opts),
    enabled: ready && id !== '',
    staleTime: STALE.short,
  });
}

/** Today's meals, for the pet header's "fed twice so far" line. */
export function useTodayFeedingLogs(petId: ID | null | undefined) {
  // Stable for the whole day, so the key doesn't churn between renders.
  return useFeedingLogs(petId, { since: startOfLocalDayISO() });
}

/* ---------------------------------------------------------------- mutations */

export function useLogFeeding(petId: ID) {
  const { ctx, userId } = useActor();
  const client = useQueryClient();

  const logsKey = queryKeys.feedingLogs.forPet(petId);

  return useMutation({
    mutationFn: (input: LogFeedingInput) => adapter.logFeeding(ctx, { ...input, petId }),
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: logsKey });
      await client.cancelQueries({ queryKey: queryKeys.careTasks.root });
      const snapshot = captureQueries(client, [logsKey, queryKeys.care.root]);

      const at = input.at ?? new Date().toISOString();
      const scheduleId = input.scheduleId ?? null;
      const optimistic: FeedingLog = {
        id: newId(),
        petId,
        scheduleId,
        at,
        foodName: input.foodName,
        portion: input.portion,
        unit: input.unit,
        skipped: input.skipped === true,
        loggedBy: userId,
        note: input.note ?? null,
      };

      client.setQueriesData<FeedingLog[]>({ queryKey: logsKey }, (logs) =>
        logs ? [optimistic, ...logs] : logs,
      );

      patchFeedingTasks(client, petId, scheduleId, at, (task) => ({
        ...task,
        state: optimistic.skipped ? 'skipped' : 'done',
        completedBy: userId,
        completedAt: at,
      }));

      return { snapshot };
    },
    onError: (error, _input, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'feeding.log' });
    },
    onSettled: () => {
      invalidateAll(client, [logsKey, ...careDerivedKeys(petId)]);
    },
  });
}

/** The Undo half of the meal toast. */
export function useUndoFeedingLog(petId: ID) {
  const { ctx } = useActor();
  const client = useQueryClient();
  const logsKey = queryKeys.feedingLogs.forPet(petId);

  return useMutation({
    mutationFn: (input: UndoFeedingInput) => adapter.undoFeedingLog(ctx, petId, input.logId),
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: logsKey });
      await client.cancelQueries({ queryKey: queryKeys.careTasks.root });
      const snapshot = captureQueries(client, [logsKey, queryKeys.care.root]);

      client.setQueriesData<FeedingLog[]>({ queryKey: logsKey }, (logs) =>
        logs?.filter((log) => log.id !== input.logId),
      );

      if (input.at) {
        patchFeedingTasks(client, petId, input.scheduleId ?? null, input.at, (task) => ({
          ...task,
          state: pendingState(task.at),
          completedBy: null,
          completedAt: null,
        }));
      }

      return { snapshot };
    },
    onError: (error, _input, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'feeding.undo' });
    },
    onSettled: () => {
      invalidateAll(client, [logsKey, ...careDerivedKeys(petId)]);
    },
  });
}

export function useSaveFeedingSchedule(petId: ID) {
  const { ctx } = useActor();
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: SaveFeedingScheduleInput) =>
      adapter.upsertFeedingSchedule(ctx, { ...input, petId }),
    onError: (error) => showErrorToast(error, { scope: 'feeding.saveSchedule' }),
    onSettled: () => {
      invalidateAll(client, [queryKeys.feeding.forPet(petId), ...careDerivedKeys(petId)]);
    },
  });
}

export function useDeleteFeedingSchedule(petId: ID) {
  const { ctx } = useActor();
  const client = useQueryClient();
  const key = queryKeys.feedingSchedules.forPet(petId);

  return useMutation({
    mutationFn: (id: ID) => adapter.deleteFeedingSchedule(ctx, petId, id),
    onMutate: async (id) => {
      await client.cancelQueries({ queryKey: key });
      const snapshot = captureQueries(client, [key]);
      client.setQueryData<FeedingSchedule[]>(key, (rows) => rows?.filter((row) => row.id !== id));
      return { snapshot };
    },
    onError: (error, _id, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'feeding.deleteSchedule' });
    },
    onSettled: () => {
      invalidateAll(client, [queryKeys.feeding.forPet(petId), ...careDerivedKeys(petId)]);
    },
  });
}
