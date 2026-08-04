/**
 * Medicine — prescriptions, doses and adherence.
 *
 * Same instant-feedback rule as feeding, with two extras that matter clinically:
 *
 *  · **The pack count moves with the dose.** `remainingDoses` drives the refill
 *    nudge, so it is decremented optimistically and put back on undo. A count
 *    that lags by a request is a count nobody trusts.
 *  · **Adherence is never patched, only invalidated.** The ring is a real
 *    calculation over expected slots and gaps — guessing at it optimistically
 *    would be the one place in this app where a number could be wrong about
 *    medication. It refetches instead; the ring animating a beat later is fine.
 */

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { adapter } from '@/data';
import type { MedicineInput, MedicineLogInput } from '@/data/adapter';
import {
  captureQueries,
  invalidateAll,
  restoreQueries,
  showErrorToast,
  STALE,
} from '@/data/QueryProvider';
import { careDerivedKeys, queryKeys } from '@/data/queryKeys';
import type {
  CareTask,
  DateOnly,
  DoseStatus,
  ID,
  Medicine,
  MedicineLog,
  TaskState,
  Timestamp,
} from '@/data/types';
import { startOfLocalDayISO } from '@/lib/date';
import { newId } from '@/lib/id';
import { useActor } from '@/stores/session';

/* -------------------------------------------------------------------- types */

export type LogDoseInput = Omit<MedicineLogInput, 'petId'>;
export type SaveMedicineInput = Omit<MedicineInput, 'petId'> & { id?: ID };
export type UndoDoseInput = { logId: ID; medicineId: ID; scheduledFor: Timestamp; status: DoseStatus };
export type RecordRefillInput = { medicineId: ID; doses: number; refillAt: DateOnly | null };

/** Default adherence window — long enough to show a habit, short enough to feel current. */
export const ADHERENCE_WINDOW_DAYS = 30;

const GRACE_MS = 90 * 60_000;

function pendingState(at: Timestamp): TaskState {
  const slot = Date.parse(at);
  if (Number.isNaN(slot)) return 'due';
  const now = Date.now();
  if (slot > now) return 'upcoming';
  return now - slot <= GRACE_MS ? 'due' : 'overdue';
}

const stateForDose = (status: DoseStatus): TaskState =>
  status === 'given' ? 'done' : status === 'skipped' ? 'skipped' : 'overdue';

/** Task ids carry the slot, so a twice-daily medicine ticks one dose, not both. */
function patchDoseTasks(
  client: QueryClient,
  petId: ID,
  medicineId: ID,
  scheduledFor: Timestamp,
  patch: (task: CareTask) => CareTask,
): void {
  client.setQueriesData<CareTask[]>({ queryKey: queryKeys.careTasks.root }, (tasks) =>
    tasks?.map((task) =>
      task.kind === 'medicine' &&
      task.petId === petId &&
      task.sourceId === medicineId &&
      task.at === scheduledFor
        ? patch(task)
        : task,
    ),
  );
}

function patchRemainingDoses(client: QueryClient, petId: ID, medicineId: ID, delta: number): void {
  client.setQueryData<Medicine[]>(queryKeys.medicines.forPet(petId), (rows) =>
    rows?.map((row) =>
      row.id === medicineId && row.remainingDoses !== null
        ? { ...row, remainingDoses: Math.max(0, row.remainingDoses + delta) }
        : row,
    ),
  );
}

/* -------------------------------------------------------------------- reads */

export function useMedicines(petId: ID | null | undefined) {
  const { ctx, ready } = useActor();
  const id = petId ?? '';

  return useQuery({
    queryKey: queryKeys.medicines.forPet(id),
    queryFn: () => adapter.listMedicines(ctx, id),
    enabled: ready && id !== '',
    staleTime: STALE.medium,
  });
}

/** One medicine, served from the same cache entry as the list. */
export function useMedicine(petId: ID | null | undefined, medicineId: ID | null | undefined) {
  const { ctx, ready } = useActor();
  const id = petId ?? '';
  const select = useCallback(
    (rows: Medicine[]) => rows.find((medicine) => medicine.id === medicineId) ?? null,
    [medicineId],
  );

  return useQuery({
    queryKey: queryKeys.medicines.forPet(id),
    queryFn: () => adapter.listMedicines(ctx, id),
    enabled: ready && id !== '',
    staleTime: STALE.medium,
    select,
  });
}

export function useMedicineLogs(
  petId: ID | null | undefined,
  opts?: { since?: string; limit?: number },
) {
  const { ctx, ready } = useActor();
  const id = petId ?? '';

  return useQuery({
    queryKey: queryKeys.medicineLogs.list(id, opts),
    queryFn: () => adapter.listMedicineLogs(ctx, id, opts),
    enabled: ready && id !== '',
    staleTime: STALE.short,
  });
}

export function useTodayDoses(petId: ID | null | undefined) {
  return useMedicineLogs(petId, { since: startOfLocalDayISO() });
}

/** The ring and the sparkline on the medicine detail screen. */
export function useAdherence(
  petId: ID | null | undefined,
  medicineId: ID | null | undefined,
  windowDays: number = ADHERENCE_WINDOW_DAYS,
) {
  const { ctx, ready } = useActor();
  const pet = petId ?? '';
  const medicine = medicineId ?? '';

  return useQuery({
    queryKey: queryKeys.adherence.forMedicine(pet, medicine, windowDays),
    queryFn: () => adapter.getAdherence(ctx, pet, medicine, windowDays),
    enabled: ready && pet !== '' && medicine !== '',
    staleTime: STALE.short,
  });
}

/* ---------------------------------------------------------------- mutations */

export function useLogDose(petId: ID) {
  const { ctx, userId } = useActor();
  const client = useQueryClient();
  const logsKey = queryKeys.medicineLogs.forPet(petId);

  return useMutation({
    mutationFn: (input: LogDoseInput) => adapter.logDose(ctx, { ...input, petId }),
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: logsKey });
      await client.cancelQueries({ queryKey: queryKeys.careTasks.root });
      const snapshot = captureQueries(client, [
        logsKey,
        queryKeys.medicines.forPet(petId),
        queryKeys.care.root,
      ]);

      const optimistic: MedicineLog = {
        id: newId(),
        petId,
        medicineId: input.medicineId,
        scheduledFor: input.scheduledFor,
        at: input.status === 'given' ? (input.at ?? new Date().toISOString()) : (input.at ?? null),
        status: input.status,
        dosage: input.dosage ?? null,
        loggedBy: userId,
        note: input.note ?? null,
      };

      client.setQueriesData<MedicineLog[]>({ queryKey: logsKey }, (logs) =>
        logs ? [optimistic, ...logs] : logs,
      );

      patchDoseTasks(client, petId, input.medicineId, input.scheduledFor, (task) => ({
        ...task,
        state: stateForDose(input.status),
        completedBy: userId,
        completedAt: optimistic.at,
      }));

      if (input.status === 'given') patchRemainingDoses(client, petId, input.medicineId, -1);

      return { snapshot };
    },
    onError: (error, _input, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'medicine.logDose' });
    },
    onSettled: (_result, _error, input) => {
      invalidateAll(client, [
        logsKey,
        queryKeys.medicines.forPet(petId),
        queryKeys.adherence.forMedicine(petId, input.medicineId, ADHERENCE_WINDOW_DAYS),
        queryKeys.adherence.forPet(petId),
        ...careDerivedKeys(petId),
      ]);
    },
  });
}

export function useUndoDose(petId: ID) {
  const { ctx } = useActor();
  const client = useQueryClient();
  const logsKey = queryKeys.medicineLogs.forPet(petId);

  return useMutation({
    mutationFn: (input: UndoDoseInput) => adapter.undoDose(ctx, petId, input.logId),
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: logsKey });
      await client.cancelQueries({ queryKey: queryKeys.careTasks.root });
      const snapshot = captureQueries(client, [
        logsKey,
        queryKeys.medicines.forPet(petId),
        queryKeys.care.root,
      ]);

      client.setQueriesData<MedicineLog[]>({ queryKey: logsKey }, (logs) =>
        logs?.filter((log) => log.id !== input.logId),
      );

      patchDoseTasks(client, petId, input.medicineId, input.scheduledFor, (task) => ({
        ...task,
        state: pendingState(task.at),
        completedBy: null,
        completedAt: null,
      }));

      // A dose that never happened goes back in the packet.
      if (input.status === 'given') patchRemainingDoses(client, petId, input.medicineId, 1);

      return { snapshot };
    },
    onError: (error, _input, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'medicine.undoDose' });
    },
    onSettled: (_result, _error, input) => {
      invalidateAll(client, [
        logsKey,
        queryKeys.medicines.forPet(petId),
        queryKeys.adherence.forMedicine(petId, input.medicineId, ADHERENCE_WINDOW_DAYS),
        queryKeys.adherence.forPet(petId),
        ...careDerivedKeys(petId),
      ]);
    },
  });
}

export function useSaveMedicine(petId: ID) {
  const { ctx } = useActor();
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: SaveMedicineInput) => adapter.upsertMedicine(ctx, { ...input, petId }),
    onError: (error) => showErrorToast(error, { scope: 'medicine.save' }),
    onSettled: () => {
      invalidateAll(client, [queryKeys.medicine.forPet(petId), ...careDerivedKeys(petId)]);
    },
  });
}

export function useDeleteMedicine(petId: ID) {
  const { ctx } = useActor();
  const client = useQueryClient();
  const key = queryKeys.medicines.forPet(petId);

  return useMutation({
    mutationFn: (medicineId: ID) => adapter.deleteMedicine(ctx, petId, medicineId),
    onMutate: async (medicineId) => {
      await client.cancelQueries({ queryKey: key });
      const snapshot = captureQueries(client, [key]);
      client.setQueryData<Medicine[]>(key, (rows) => rows?.filter((row) => row.id !== medicineId));
      return { snapshot };
    },
    onError: (error, _medicineId, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'medicine.delete' });
    },
    onSettled: () => {
      invalidateAll(client, [queryKeys.medicine.forPet(petId), ...careDerivedKeys(petId)]);
    },
  });
}

/** Replaces the pack — the count is set, not added to. */
export function useRecordRefill(petId: ID) {
  const { ctx } = useActor();
  const client = useQueryClient();
  const key = queryKeys.medicines.forPet(petId);

  return useMutation({
    mutationFn: (input: RecordRefillInput) =>
      adapter.recordRefill(ctx, petId, input.medicineId, input.doses, input.refillAt),
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: key });
      const snapshot = captureQueries(client, [key]);
      client.setQueryData<Medicine[]>(key, (rows) =>
        rows?.map((row) =>
          row.id === input.medicineId
            ? { ...row, remainingDoses: input.doses, refillAt: input.refillAt }
            : row,
        ),
      );
      return { snapshot };
    },
    onError: (error, _input, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'medicine.refill' });
    },
    onSettled: () => invalidateAll(client, [key]),
  });
}
