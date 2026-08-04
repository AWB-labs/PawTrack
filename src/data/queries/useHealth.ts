/**
 * Health — weight, vaccinations, vet visits and documents.
 *
 * One file because they are one screen: the health tab reads all four and a
 * single vet trip touches three of them. Splitting them would only mean four
 * imports and four chances to invalidate the wrong prefix.
 *
 * What is optimistic here, and what deliberately isn't:
 *
 *  · **Weights are.** Stepping a dial and watching the chart move is the whole
 *    interaction; a spinner between the two breaks it. The denormalised
 *    `pet.currentWeightKg` is patched at the same time so the header and the
 *    pet grid agree instantly.
 *  · **Deletes are.** A row that lingers after "Remove" reads as a failure.
 *  · **Form saves aren't.** A vaccination record is a considered edit behind a
 *    Save button — honest latency with a disabled button beats a row that
 *    appears, then vanishes because the server disagreed.
 *  · **Uploads aren't.** There is a real file crossing a real network; the
 *    progress state is the truth.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { adapter } from '@/data';
import type { DocumentInput, VaccinationInput, VetVisitInput, WeightInput } from '@/data/adapter';
import {
  captureQueries,
  invalidateAll,
  restoreQueries,
  showErrorToast,
  STALE,
} from '@/data/QueryProvider';
import { careDerivedKeys, queryKeys } from '@/data/queryKeys';
import type { ID, Pet, PetDocument, Vaccination, VetVisit, WeightEntry } from '@/data/types';
import { newId } from '@/lib/id';
import { useActor } from '@/stores/session';

/* -------------------------------------------------------------------- types */

export type AddWeightInput = Omit<WeightInput, 'petId'>;
export type SaveVaccinationInput = Omit<VaccinationInput, 'petId'> & { id?: ID };
export type SaveVetVisitInput = Omit<VetVisitInput, 'petId'> & { id?: ID };
export type UploadDocumentInput = Omit<DocumentInput, 'petId'>;

/* ------------------------------------------------------------------ weight */

export function useWeights(petId: ID | null | undefined) {
  const { ctx, ready } = useActor();
  const id = petId ?? '';

  return useQuery({
    queryKey: queryKeys.weights.forPet(id),
    queryFn: () => adapter.listWeights(ctx, id),
    enabled: ready && id !== '',
    staleTime: STALE.medium,
  });
}

/** Latest first — the number the header shows. */
export function useLatestWeight(petId: ID | null | undefined): WeightEntry | null {
  const { data } = useWeights(petId);
  return data && data.length > 0 ? (data[data.length - 1] ?? null) : null;
}

export function useAddWeight(petId: ID) {
  const { ctx, userId } = useActor();
  const client = useQueryClient();

  const weightsKey = queryKeys.weights.forPet(petId);
  const detailKey = queryKeys.pets.detail(petId);
  const listKey = queryKeys.pets.list(userId);

  return useMutation({
    mutationFn: (input: AddWeightInput) => adapter.addWeight(ctx, { ...input, petId }),
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: weightsKey });
      const snapshot = captureQueries(client, [weightsKey, detailKey, listKey]);

      const entry: WeightEntry = {
        id: newId(),
        petId,
        kg: input.kg,
        recordedAt: input.recordedAt ?? new Date().toISOString(),
        recordedBy: userId,
        note: input.note ?? null,
      };

      const existing = client.getQueryData<WeightEntry[]>(weightsKey);
      if (existing) {
        client.setQueryData<WeightEntry[]>(
          weightsKey,
          [...existing, entry].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt)),
        );
      }

      // Only the newest reading is the pet's current weight — back-filling an
      // old vet visit must not rewrite the header.
      const previous = existing?.at(-1);
      const isLatest = !previous || Date.parse(entry.recordedAt) >= Date.parse(previous.recordedAt);
      if (isLatest) {
        client.setQueryData<Pet | null>(detailKey, (pet) =>
          pet ? { ...pet, currentWeightKg: entry.kg } : pet,
        );
        client.setQueryData<Pet[]>(listKey, (pets) =>
          pets?.map((pet) => (pet.id === petId ? { ...pet, currentWeightKg: entry.kg } : pet)),
        );
      }

      return { snapshot };
    },
    onError: (error, _input, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'health.addWeight' });
    },
    onSettled: () => {
      invalidateAll(client, [weightsKey, detailKey, queryKeys.pets.lists(), ...careDerivedKeys(petId)]);
    },
  });
}

export function useDeleteWeight(petId: ID) {
  const client = useQueryClient();
  const { ctx } = useActor();
  const weightsKey = queryKeys.weights.forPet(petId);

  return useMutation({
    mutationFn: (entryId: ID) => adapter.deleteWeight(ctx, petId, entryId),
    onMutate: async (entryId) => {
      await client.cancelQueries({ queryKey: weightsKey });
      const snapshot = captureQueries(client, [weightsKey]);
      client.setQueryData<WeightEntry[]>(weightsKey, (entries) =>
        entries?.filter((entry) => entry.id !== entryId),
      );
      return { snapshot };
    },
    onError: (error, _entryId, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'health.deleteWeight' });
    },
    onSettled: () => {
      invalidateAll(client, [weightsKey, queryKeys.pets.detail(petId), queryKeys.pets.lists()]);
    },
  });
}

/* ------------------------------------------------------------ vaccinations */

export function useVaccinations(petId: ID | null | undefined) {
  const { ctx, ready } = useActor();
  const id = petId ?? '';

  return useQuery({
    queryKey: queryKeys.vaccinations.forPet(id),
    queryFn: () => adapter.listVaccinations(ctx, id),
    enabled: ready && id !== '',
    staleTime: STALE.medium,
  });
}

export function useSaveVaccination(petId: ID) {
  const { ctx } = useActor();
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: SaveVaccinationInput) => adapter.upsertVaccination(ctx, { ...input, petId }),
    onError: (error) => showErrorToast(error, { scope: 'health.saveVaccination' }),
    onSettled: () => {
      invalidateAll(client, [queryKeys.vaccinations.forPet(petId), ...careDerivedKeys(petId)]);
    },
  });
}

export function useDeleteVaccination(petId: ID) {
  const { ctx } = useActor();
  const client = useQueryClient();
  const key = queryKeys.vaccinations.forPet(petId);

  return useMutation({
    mutationFn: (id: ID) => adapter.deleteVaccination(ctx, petId, id),
    onMutate: async (id) => {
      await client.cancelQueries({ queryKey: key });
      const snapshot = captureQueries(client, [key]);
      client.setQueryData<Vaccination[]>(key, (rows) => rows?.filter((row) => row.id !== id));
      return { snapshot };
    },
    onError: (error, _id, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'health.deleteVaccination' });
    },
    onSettled: () => invalidateAll(client, [key, ...careDerivedKeys(petId)]),
  });
}

/* -------------------------------------------------------------- vet visits */

export function useVetVisits(petId: ID | null | undefined) {
  const { ctx, ready } = useActor();
  const id = petId ?? '';

  return useQuery({
    queryKey: queryKeys.vetVisits.forPet(id),
    queryFn: () => adapter.listVetVisits(ctx, id),
    enabled: ready && id !== '',
    staleTime: STALE.medium,
  });
}

export function useSaveVetVisit(petId: ID) {
  const { ctx } = useActor();
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: SaveVetVisitInput) => adapter.upsertVetVisit(ctx, { ...input, petId }),
    onError: (error) => showErrorToast(error, { scope: 'health.saveVetVisit' }),
    onSettled: () => {
      // A write-up usually carries a weight and a follow-up date with it.
      invalidateAll(client, [
        queryKeys.vetVisits.forPet(petId),
        queryKeys.weights.forPet(petId),
        queryKeys.appointments.forPet(petId),
        ...careDerivedKeys(petId),
      ]);
    },
  });
}

export function useDeleteVetVisit(petId: ID) {
  const { ctx } = useActor();
  const client = useQueryClient();
  const key = queryKeys.vetVisits.forPet(petId);

  return useMutation({
    mutationFn: (id: ID) => adapter.deleteVetVisit(ctx, petId, id),
    onMutate: async (id) => {
      await client.cancelQueries({ queryKey: key });
      const snapshot = captureQueries(client, [key]);
      client.setQueryData<VetVisit[]>(key, (rows) => rows?.filter((row) => row.id !== id));
      return { snapshot };
    },
    onError: (error, _id, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'health.deleteVetVisit' });
    },
    onSettled: () => invalidateAll(client, [key, ...careDerivedKeys(petId)]),
  });
}

/* --------------------------------------------------------------- documents */

export function useDocuments(petId: ID | null | undefined) {
  const { ctx, ready } = useActor();
  const id = petId ?? '';

  return useQuery({
    queryKey: queryKeys.documents.forPet(id),
    queryFn: () => adapter.listDocuments(ctx, id),
    enabled: ready && id !== '',
    staleTime: STALE.medium,
  });
}

/**
 * Signed, short-lived viewing URL. Cached just inside its own lifetime so
 * reopening a record doesn't re-sign, and re-signs before it can expire in the
 * user's hands.
 */
export function useDocumentUrl(petId: ID | null | undefined, documentId: ID | null | undefined) {
  const { ctx, ready } = useActor();
  const pet = petId ?? '';
  const id = documentId ?? '';

  return useQuery({
    queryKey: queryKeys.documents.url(pet, id),
    queryFn: () => adapter.resolveDocumentUrl(ctx, pet, id),
    enabled: ready && pet !== '' && id !== '',
    staleTime: STALE.signedUrl,
    gcTime: STALE.signedUrl,
  });
}

export function useUploadDocument(petId: ID) {
  const { ctx } = useActor();
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: UploadDocumentInput) => adapter.uploadDocument(ctx, { ...input, petId }),
    onError: (error) => showErrorToast(error, { scope: 'health.uploadDocument' }),
    onSettled: () => {
      invalidateAll(client, [queryKeys.documents.forPet(petId), ...careDerivedKeys(petId)]);
    },
  });
}

export function useDeleteDocument(petId: ID) {
  const { ctx } = useActor();
  const client = useQueryClient();
  const key = queryKeys.documents.forPet(petId);

  return useMutation({
    mutationFn: (id: ID) => adapter.deleteDocument(ctx, petId, id),
    onMutate: async (id) => {
      await client.cancelQueries({ queryKey: key });
      const snapshot = captureQueries(client, [key]);
      client.setQueryData<PetDocument[]>(key, (rows) => rows?.filter((row) => row.id !== id));
      return { snapshot };
    },
    onError: (error, _id, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'health.deleteDocument' });
    },
    onSettled: () => invalidateAll(client, [key]),
  });
}
