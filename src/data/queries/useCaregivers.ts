/**
 * Caregivers — memberships, invites and the audit trail.
 *
 * This is the RBAC surface, so two things are handled with more care than a
 * normal list:
 *
 *  · **Accepting an invite changes what the actor can do.** The session's
 *    memberships are the input to every permission verdict in the app, so
 *    `useAcceptInvite` refreshes them before anything else and lets the pet
 *    list refetch off the back of it. Skip that and the caregiver lands on a
 *    pet they can see but not touch.
 *  · **Revoking is optimistic but never destructive.** The row stays and flips
 *    to `revoked`, exactly as the adapter does it, because the activity trail
 *    has to stay attributable to a person who once had access.
 *
 * The activity log paginates by cursor, so it is an infinite query — a busy
 * household generates hundreds of events and a caregiver scrolling back through
 * a fortnight shouldn't wait for all of them.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';

import { adapter } from '@/data';
import type { InviteInput, MembershipPatch, Page } from '@/data/adapter';
import {
  captureQueries,
  invalidateAll,
  restoreQueries,
  showErrorToast,
  STALE,
} from '@/data/QueryProvider';
import { queryKeys } from '@/data/queryKeys';
import type { ActivityEvent, ID, Invite, MembershipWithUser } from '@/data/types';
import { useActor, useSession } from '@/stores/session';

/* -------------------------------------------------------------------- types */

export type CreateInviteInput = Omit<InviteInput, 'petId'>;
export type UpdateMembershipInput = { membershipId: ID; patch: MembershipPatch };

const ACTIVITY_PAGE_SIZE = 30;

const flattenActivity = (data: InfiniteData<Page<ActivityEvent>, string | null>): ActivityEvent[] =>
  data.pages.flatMap((page) => page.items);

/* --------------------------------------------------------------- memberships */

/** Everyone linked to this pet, owner first. Needs `caregiver.view`. */
export function usePetCaregivers(petId: ID | null | undefined) {
  const { ctx, ready } = useActor();
  const id = petId ?? '';

  return useQuery({
    queryKey: queryKeys.memberships.forPet(id),
    queryFn: () => adapter.listMemberships(ctx, id),
    enabled: ready && id !== '',
    staleTime: STALE.medium,
  });
}

/**
 * Every membership the actor holds, in every state. The session store already
 * carries the live copy; this query is the *screen's* view of it — sorted,
 * lapsed windows resolved — for "Pets you help with".
 */
export function useMyMemberships() {
  const { ctx, ready, userId } = useActor();

  return useQuery({
    queryKey: queryKeys.myMemberships.forUser(userId),
    queryFn: () => adapter.listMyMemberships(ctx),
    enabled: ready,
    staleTime: STALE.medium,
  });
}

export function useUpdateMembership(petId: ID) {
  const { ctx } = useActor();
  const client = useQueryClient();
  const key = queryKeys.memberships.forPet(petId);

  return useMutation({
    mutationFn: ({ membershipId, patch }: UpdateMembershipInput) =>
      adapter.updateMembership(ctx, petId, membershipId, patch),
    onMutate: async ({ membershipId, patch }) => {
      await client.cancelQueries({ queryKey: key });
      const snapshot = captureQueries(client, [key]);
      client.setQueryData<MembershipWithUser[]>(key, (rows) =>
        rows?.map((row) => (row.id === membershipId ? { ...row, ...patch } : row)),
      );
      return { snapshot };
    },
    onError: (error, _input, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'caregivers.updateMembership' });
    },
    onSettled: () => {
      invalidateAll(client, [queryKeys.caregivers.forPet(petId), queryKeys.activity.forPet(petId)]);
    },
  });
}

/** Access is switched off, not deleted — the trail has to stay attributable. */
export function useRevokeMembership(petId: ID) {
  const { ctx } = useActor();
  const client = useQueryClient();
  const key = queryKeys.memberships.forPet(petId);

  return useMutation({
    mutationFn: (membershipId: ID) => adapter.revokeMembership(ctx, petId, membershipId),
    onMutate: async (membershipId) => {
      await client.cancelQueries({ queryKey: key });
      const snapshot = captureQueries(client, [key]);
      client.setQueryData<MembershipWithUser[]>(key, (rows) =>
        rows?.map((row) => (row.id === membershipId ? { ...row, status: 'revoked' } : row)),
      );
      return { snapshot };
    },
    onError: (error, _membershipId, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'caregivers.revokeMembership' });
    },
    onSettled: () => {
      invalidateAll(client, [queryKeys.caregivers.forPet(petId), queryKeys.activity.forPet(petId)]);
    },
  });
}

/* ------------------------------------------------------------------ invites */

export function useInvites(petId: ID | null | undefined) {
  const { ctx, ready } = useActor();
  const id = petId ?? '';

  return useQuery({
    queryKey: queryKeys.invites.forPet(id),
    queryFn: () => adapter.listInvites(ctx, id),
    enabled: ready && id !== '',
    staleTime: STALE.short,
  });
}

export function useCreateInvite(petId: ID) {
  const { ctx } = useActor();
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateInviteInput) => adapter.createInvite(ctx, { ...input, petId }),
    onError: (error) => showErrorToast(error, { scope: 'caregivers.createInvite' }),
    onSettled: () => {
      invalidateAll(client, [queryKeys.caregivers.forPet(petId), queryKeys.activity.forPet(petId)]);
    },
  });
}

export function useRevokeInvite(petId: ID) {
  const { ctx } = useActor();
  const client = useQueryClient();
  const key = queryKeys.invites.forPet(petId);

  return useMutation({
    mutationFn: (inviteId: ID) => adapter.revokeInvite(ctx, petId, inviteId),
    onMutate: async (inviteId) => {
      await client.cancelQueries({ queryKey: key });
      const snapshot = captureQueries(client, [key]);
      client.setQueryData<Invite[]>(key, (rows) =>
        rows?.map((row) => (row.id === inviteId ? { ...row, status: 'revoked' } : row)),
      );
      return { snapshot };
    },
    onError: (error, _inviteId, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'caregivers.revokeInvite' });
    },
    onSettled: () => invalidateAll(client, [key]),
  });
}

/**
 * Reads an invite before it is accepted, for the preview screen. Deliberately
 * *not* gated on being signed in: a deep link has to resolve to "Priya wants
 * you to help with Buddy" before we ask anyone to make an account.
 */
export function useInvitePreview(code: string | null | undefined) {
  const trimmed = (code ?? '').trim();

  return useQuery({
    queryKey: queryKeys.invites.byCode(trimmed),
    queryFn: () => adapter.peekInvite(trimmed),
    enabled: trimmed.length > 0,
    staleTime: STALE.short,
    // A mistyped code is an answer, not a failure to retry into.
    retry: false,
  });
}

export function useAcceptInvite() {
  const { ctx, userId } = useActor();
  const client = useQueryClient();
  const refreshMemberships = useSession((s) => s.refreshMemberships);

  return useMutation({
    mutationFn: (code: string) => adapter.acceptInvite(ctx, code.trim()),
    onSuccess: async (membership) => {
      // Permissions first: every query below this depends on the new grant set.
      await refreshMemberships();
      invalidateAll(client, [
        queryKeys.pets.root,
        queryKeys.myMemberships.forUser(userId),
        queryKeys.caregivers.forPet(membership.petId),
        queryKeys.care.root,
      ]);
    },
    onError: (error) => showErrorToast(error, { scope: 'caregivers.acceptInvite' }),
  });
}

/* ----------------------------------------------------------------- activity */

/** One pet's audit trail, newest first, paged by cursor. */
export function usePetActivity(petId: ID | null | undefined, pageSize = ACTIVITY_PAGE_SIZE) {
  const { ctx, ready } = useActor();
  const id = petId ?? '';

  return useInfiniteQuery({
    queryKey: queryKeys.activity.forPet(id),
    queryFn: ({ pageParam }) =>
      adapter.listActivity(ctx, id, { limit: pageSize, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: ready && id !== '',
    staleTime: STALE.short,
    select: flattenActivity,
  });
}

/** Everything caregivers did across the pets this user owns — the owner's digest. */
export function useCaregiverActivity(limit = 40) {
  const { ctx, ready, userId } = useActor();

  return useQuery({
    queryKey: queryKeys.activity.byCaregivers(userId, limit),
    queryFn: () => adapter.listCaregiverActivity(ctx, { limit }),
    enabled: ready,
    staleTime: STALE.short,
  });
}
