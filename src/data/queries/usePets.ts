/**
 * Pets — the household.
 *
 * `usePets()` is the app's most-read query: the tab bar, the Today screen, the
 * community composer and the onboarding guard all depend on it, so its cache is
 * treated as the source every other pet read borrows from. `usePet()` seeds
 * itself from that list, which is why opening a pet from the grid shows a full
 * header immediately rather than a skeleton for a record we already hold.
 *
 * Creating a pet mints an owner membership server-side. The session's
 * memberships therefore have to be re-read on success — skip it and the RBAC
 * layer, quite correctly, denies every capability on the pet the user just made.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { adapter } from '@/data';
import type { PetInput, PetPatch } from '@/data/adapter';
import {
  captureQueries,
  invalidateAll,
  restoreQueries,
  showErrorToast,
  STALE,
} from '@/data/QueryProvider';
import { petScopedKeys, queryKeys } from '@/data/queryKeys';
import type { ID, Pet } from '@/data/types';
import { useActor, useSession } from '@/stores/session';

/* -------------------------------------------------------------------- reads */

/** Every pet the actor can open — owned first, then the ones they sit for. */
export function usePets() {
  const { ctx, ready } = useActor();

  return useQuery({
    queryKey: queryKeys.pets.list(ctx.userId),
    queryFn: () => adapter.listPets(ctx),
    enabled: ready,
    staleTime: STALE.medium,
  });
}

/** Id → pet, for screens that resolve names against a stream (feed, activity). */
export function usePetIndex(): Map<ID, Pet> {
  const { data } = usePets();
  return useMemo(() => new Map((data ?? []).map((pet) => [pet.id, pet])), [data]);
}

/**
 * One pet. Returns `null` — not an error — when the viewer has no membership,
 * which is what `PetScope` renders its "access was removed" branch from.
 */
export function usePet(petId: ID | null | undefined) {
  const { ctx, ready } = useActor();
  const client = useQueryClient();
  const id = petId ?? '';

  return useQuery({
    queryKey: queryKeys.pets.detail(id),
    queryFn: () => adapter.getPet(ctx, id),
    enabled: ready && id !== '',
    staleTime: STALE.medium,
    // The list already holds a complete record; showing it while the detail
    // request settles removes the only skeleton nobody needed.
    placeholderData: () =>
      client.getQueryData<Pet[]>(queryKeys.pets.list(ctx.userId))?.find((pet) => pet.id === id),
  });
}

/* ---------------------------------------------------------------- mutations */

export function useCreatePet() {
  const { ctx } = useActor();
  const client = useQueryClient();
  const refreshMemberships = useSession((s) => s.refreshMemberships);

  return useMutation({
    mutationFn: (input: PetInput) => adapter.createPet(ctx, input),
    onSuccess: async (pet) => {
      client.setQueryData(queryKeys.pets.detail(pet.id), pet);
      // The owner membership is brand new; without it every capability on this
      // pet evaluates to `no-membership`.
      await refreshMemberships();
    },
    onError: (error) => showErrorToast(error, { scope: 'pets.create' }),
    onSettled: () => {
      invalidateAll(client, [queryKeys.pets.root, queryKeys.care.root]);
    },
  });
}

/**
 * Profile edits apply straight away. Waiting 400 ms to see a renamed pet is the
 * kind of lag that makes an app feel like a form rather than a companion.
 */
export function useUpdatePet(petId: ID) {
  const { ctx, userId } = useActor();
  const client = useQueryClient();

  const detailKey = queryKeys.pets.detail(petId);
  const listKey = queryKeys.pets.list(userId);

  return useMutation({
    mutationFn: (patch: PetPatch) => adapter.updatePet(ctx, petId, patch),
    onMutate: async (patch) => {
      await client.cancelQueries({ queryKey: detailKey });
      await client.cancelQueries({ queryKey: listKey });
      const snapshot = captureQueries(client, [detailKey, listKey]);

      client.setQueryData<Pet | null>(detailKey, (pet) => (pet ? { ...pet, ...patch } : pet));
      client.setQueryData<Pet[]>(listKey, (pets) =>
        pets?.map((pet) => (pet.id === petId ? { ...pet, ...patch } : pet)),
      );

      return { snapshot };
    },
    onError: (error, _patch, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'pets.update' });
    },
    onSuccess: (pet) => client.setQueryData(detailKey, pet),
    onSettled: () => {
      invalidateAll(client, [detailKey, queryKeys.pets.lists(), queryKeys.care.root]);
    },
  });
}

/**
 * Deleting a pet takes its whole history with it, so the cache is cleared by
 * prefix rather than patched — there is nothing left to reconcile.
 */
export function useDeletePet() {
  const { ctx, userId } = useActor();
  const client = useQueryClient();
  const refreshMemberships = useSession((s) => s.refreshMemberships);

  return useMutation({
    mutationFn: (petId: ID) => adapter.deletePet(ctx, petId),
    onMutate: async (petId) => {
      const listKey = queryKeys.pets.list(userId);
      await client.cancelQueries({ queryKey: listKey });
      const snapshot = captureQueries(client, [listKey]);
      client.setQueryData<Pet[]>(listKey, (pets) => pets?.filter((pet) => pet.id !== petId));
      return { snapshot };
    },
    onError: (error, _petId, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'pets.delete' });
    },
    onSuccess: async (_result, petId) => {
      client.removeQueries({ queryKey: queryKeys.pets.detail(petId) });
      await refreshMemberships();
    },
    onSettled: (_result, _error, petId) => {
      invalidateAll(client, petScopedKeys(petId));
    },
  });
}
