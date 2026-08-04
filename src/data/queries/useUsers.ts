/**
 * Users — profiles and the account actions that aren't sign-in.
 *
 * Profile reads are effectively reference data: a display name and an avatar,
 * fetched because a post or an activity line mentioned someone. They get a long
 * stale time and no refetch-on-mount storm.
 *
 * The profile *edit* is optimistic and, unusually for this layer, also writes to
 * the session store — the avatar in the header comes from the session, not from
 * a query, so an edit that only patched the cache would leave the user staring
 * at their old photo until the next sign-in.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { adapter } from '@/data';
import {
  captureQueries,
  invalidateAll,
  restoreQueries,
  showErrorToast,
  STALE,
} from '@/data/QueryProvider';
import { queryKeys } from '@/data/queryKeys';
import type { ID, User } from '@/data/types';
import { useActor, useSession } from '@/stores/session';

/* -------------------------------------------------------------------- types */

export type ProfilePatch = Partial<Pick<User, 'displayName' | 'avatarUrl' | 'bio'>>;

/* -------------------------------------------------------------------- reads */

export function useUser(userId: ID | null | undefined) {
  const { ctx, ready } = useActor();
  const id = userId ?? '';

  return useQuery({
    queryKey: queryKeys.users.detail(id),
    queryFn: () => adapter.getUser(ctx, id),
    enabled: ready && id !== '',
    staleTime: STALE.long,
  });
}

/* ---------------------------------------------------------------- mutations */

export function useUpdateProfile() {
  const { ctx, userId } = useActor();
  const client = useQueryClient();
  const currentUser = useSession((s) => s.user);
  const setUser = useSession((s) => s.setUser);

  const key = queryKeys.users.detail(userId);

  return useMutation({
    mutationFn: (patch: ProfilePatch) => adapter.updateProfile(ctx, patch),
    onMutate: async (patch) => {
      await client.cancelQueries({ queryKey: key });
      const snapshot = captureQueries(client, [key]);
      const previousUser = currentUser;

      client.setQueryData<User | null>(key, (user) => (user ? { ...user, ...patch } : user));
      if (previousUser) setUser({ ...previousUser, ...patch });

      return { snapshot, previousUser };
    },
    onError: (error, _patch, context) => {
      restoreQueries(client, context?.snapshot);
      if (context?.previousUser) setUser(context.previousUser);
      showErrorToast(error, { scope: 'users.updateProfile' });
    },
    onSuccess: (user) => {
      client.setQueryData(key, user);
      setUser(user);
    },
    onSettled: () => {
      // Names and avatars are denormalised onto posts and comments.
      invalidateAll(client, [key, queryKeys.community.root]);
    },
  });
}

/**
 * Always resolves the same way whether or not the address is registered —
 * telling a stranger which emails have accounts is an account-enumeration
 * oracle, and the copy on the screen says "if we know that address" for exactly
 * that reason.
 */
export function useRequestPasswordReset() {
  return useMutation({
    mutationFn: (email: string) => adapter.requestPasswordReset(email.trim()),
    onError: (error) => showErrorToast(error, { scope: 'users.requestPasswordReset' }),
  });
}
