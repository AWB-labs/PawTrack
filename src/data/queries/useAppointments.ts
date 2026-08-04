/**
 * Appointments.
 *
 * Two shapes of read, because there are two questions: "what's coming up for
 * this pet" (the pet's appointments tab) and "what's coming up at all" (the
 * Today header, where a household of three pets has one agenda).
 *
 * Status changes are optimistic — ticking "we went" from Today should feel like
 * ticking a box, not like filing a form. Everything else goes through the save
 * path, which sends the whole record because that is what the adapter's upsert
 * contract takes; `toAppointmentInput()` exists so no screen has to remember
 * which of the eighteen fields the server owns.
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { adapter } from '@/data';
import type { AppointmentInput } from '@/data/adapter';
import {
  captureQueries,
  invalidateAll,
  restoreQueries,
  showErrorToast,
  STALE,
} from '@/data/QueryProvider';
import { careDerivedKeys, queryKeys } from '@/data/queryKeys';
import type { Appointment, AppointmentStatus, ID } from '@/data/types';
import { useActor } from '@/stores/session';

/* -------------------------------------------------------------------- types */

export type SaveAppointmentInput = Omit<AppointmentInput, 'petId'> & { id?: ID };

export type AppointmentRange = { from?: string; to?: string };

/** Strip the server-owned fields so an edit round-trips cleanly. */
export function toAppointmentInput(appointment: Appointment): SaveAppointmentInput {
  return {
    id: appointment.id,
    at: appointment.at,
    durationMin: appointment.durationMin,
    type: appointment.type,
    reason: appointment.reason,
    clinic: appointment.clinic,
    clinicPhone: appointment.clinicPhone,
    clinicAddress: appointment.clinicAddress,
    vetName: appointment.vetName,
    status: appointment.status,
    notes: appointment.notes,
    reminderOffsets: appointment.reminderOffsets,
    linkedDocumentIds: appointment.linkedDocumentIds,
    linkedVaccinationIds: appointment.linkedVaccinationIds,
  };
}

/* -------------------------------------------------------------------- reads */

export function useAppointments(petId: ID | null | undefined, range?: AppointmentRange) {
  const { ctx, ready } = useActor();
  const id = petId ?? '';

  return useQuery({
    queryKey: queryKeys.appointments.list(id, range),
    queryFn: () => adapter.listAppointments(ctx, id, range),
    enabled: ready && id !== '',
    staleTime: STALE.short,
    // Sliding the month picker keeps the previous month on screen rather than
    // collapsing the list to a skeleton between two ranges.
    placeholderData: keepPreviousData,
  });
}

/** Cross-pet agenda. Cancelled and completed visits are already filtered out. */
export function useUpcomingAppointments(limit = 5) {
  const { ctx, ready } = useActor();

  return useQuery({
    queryKey: queryKeys.appointments.upcoming(limit),
    queryFn: () => adapter.listUpcomingAppointments(ctx, { limit }),
    enabled: ready,
    staleTime: STALE.short,
  });
}

/* ---------------------------------------------------------------- mutations */

export function useSaveAppointment(petId: ID) {
  const { ctx } = useActor();
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: SaveAppointmentInput) => adapter.upsertAppointment(ctx, { ...input, petId }),
    onError: (error) => showErrorToast(error, { scope: 'appointments.save' }),
    onSettled: () => {
      invalidateAll(client, [
        queryKeys.appointments.forPet(petId),
        queryKeys.appointments.upcoming(),
        ...careDerivedKeys(petId),
      ]);
    },
  });
}

/**
 * "We went" / "We didn't". Patched across every cached range for this pet so the
 * row settles the moment it's tapped.
 */
export function useUpdateAppointmentStatus(petId: ID) {
  const { ctx } = useActor();
  const client = useQueryClient();
  const petKey = queryKeys.appointments.forPet(petId);

  return useMutation({
    mutationFn: ({ appointment, status }: { appointment: Appointment; status: AppointmentStatus }) =>
      adapter.upsertAppointment(ctx, { ...toAppointmentInput(appointment), petId, status }),
    onMutate: async ({ appointment, status }) => {
      await client.cancelQueries({ queryKey: petKey });
      const snapshot = captureQueries(client, [
        petKey,
        queryKeys.appointments.root,
        queryKeys.care.root,
      ]);

      client.setQueriesData<Appointment[]>({ queryKey: queryKeys.appointments.root }, (rows) =>
        rows?.map((row) => (row.id === appointment.id ? { ...row, status } : row)),
      );

      return { snapshot };
    },
    onError: (error, _variables, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'appointments.status' });
    },
    onSettled: () => {
      invalidateAll(client, [
        queryKeys.appointments.forPet(petId),
        queryKeys.appointments.upcoming(),
        ...careDerivedKeys(petId),
      ]);
    },
  });
}

export function useDeleteAppointment(petId: ID) {
  const { ctx } = useActor();
  const client = useQueryClient();
  const petKey = queryKeys.appointments.forPet(petId);

  return useMutation({
    mutationFn: (appointmentId: ID) => adapter.deleteAppointment(ctx, petId, appointmentId),
    onMutate: async (appointmentId) => {
      await client.cancelQueries({ queryKey: petKey });
      const snapshot = captureQueries(client, [queryKeys.appointments.root]);
      client.setQueriesData<Appointment[]>({ queryKey: queryKeys.appointments.root }, (rows) =>
        rows?.filter((row) => row.id !== appointmentId),
      );
      return { snapshot };
    },
    onError: (error, _appointmentId, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'appointments.delete' });
    },
    onSettled: () => {
      invalidateAll(client, [
        queryKeys.appointments.forPet(petId),
        queryKeys.appointments.upcoming(),
        ...careDerivedKeys(petId),
      ]);
    },
  });
}
