/**
 * Safety — reporting, blocking, and the agreement stamp.
 *
 * Everything here has the same unusual property: the *point* of the mutation is
 * that something disappears, and it has to disappear before the network does
 * anything. Somebody who has just flagged a threat, or blocked the person
 * making it, should not be looking at either one while a request is in flight.
 *
 * So all three write paths patch the cache first and reconcile after:
 *
 *   · **Reporting** drops that one post everywhere it is cached, and closes the
 *     post screen if you were standing on it. The server hides it too — on the
 *     first report for the severe categories, the second otherwise — but the
 *     reporter's copy goes immediately either way.
 *   · **Blocking** drops every post and comment by that account from every
 *     cached feed, in the same tick. It then refetches, because a block is
 *     symmetric and the *server's* answer differs from ours in one direction we
 *     can't compute locally: their replies inside threads we haven't loaded.
 *   · **Accepting the terms** writes straight into the session store, because
 *     the router's legal gate reads from there and would otherwise keep the
 *     agreement screen mounted over the app it just unlocked.
 *
 * Failure restores the snapshot, the same way likes do. A block that silently
 * didn't take is the one failure mode worth being loud about, so the error
 * toast for it is deliberately not suppressed.
 */

import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { adapter } from '@/data';
import type { BlockInput, ReportInput } from '@/data/adapter';
import {
  captureQueries,
  invalidateAll,
  restoreQueries,
  showErrorToast,
  STALE,
} from '@/data/QueryProvider';
import { queryKeys } from '@/data/queryKeys';
import type { BlockedAccount, CommentWithAuthor, ContentReport, ID } from '@/data/types';
import { TERMS_VERSION } from '@/features/legal/agreement';
import { usePreferences } from '@/stores/preferences';
import { useActor, useCurrentUser, useSession } from '@/stores/session';

/* ------------------------------------------------------------------ helpers */

/**
 * Drop rows from every cached feed page and every cached comment thread.
 *
 * Written as one predicate over both shapes rather than two functions, because
 * a block has to take effect in both at once — a feed that has forgotten
 * somebody while the open comment thread still shows them is worse than not
 * having blocked them at all.
 */
function purge(client: QueryClient, drop: (row: { id: ID; authorId: ID }) => boolean): void {
  client.setQueriesData<{ pages: { items: { id: ID; authorId: ID }[] }[] }>(
    { queryKey: queryKeys.feed.root },
    (data) =>
      data
        ? {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              items: page.items.filter((item) => !drop(item)),
            })),
          }
        : data,
  );

  client.setQueriesData<CommentWithAuthor[]>({ queryKey: queryKeys.comments.root }, (comments) =>
    comments?.filter((comment) => !drop(comment)),
  );
}

/* ------------------------------------------------------------------ reading */

export function useBlockedAccounts() {
  const { ctx, ready } = useActor();

  return useQuery({
    queryKey: queryKeys.blocks.forUser(ctx.userId),
    queryFn: () => adapter.listBlockedAccounts(ctx),
    enabled: ready,
    staleTime: STALE.medium,
  });
}

export function useMyReports() {
  const { ctx, ready } = useActor();

  return useQuery({
    queryKey: queryKeys.reports.forUser(ctx.userId),
    queryFn: () => adapter.listMyReports(ctx),
    enabled: ready,
    staleTime: STALE.medium,
  });
}

/* ------------------------------------------------------------------ writing */

/**
 * Flag something.
 *
 * The optimistic half is a removal, not an edit, so there is nothing to reverse
 * on the screen if the server disagrees — and the server rarely does, because
 * the only rejections are "you already reported this" (which we treat as
 * success, since it is) and "that's your own post" (which the UI never offers).
 */
export function useReportContent() {
  const { ctx } = useActor();
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: ReportInput) => adapter.reportContent(ctx, input),
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: queryKeys.feed.root });
      const snapshot = captureQueries(client, [queryKeys.feed.root, queryKeys.comments.root]);

      purge(client, (row) =>
        input.targetKind === 'user' ? row.authorId === input.targetId : row.id === input.targetId,
      );

      if (input.targetKind === 'post') {
        client.setQueryData(queryKeys.post.detail(input.targetId), null);
      }

      return { snapshot };
    },
    onError: (error, _input, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'safety.report' });
    },
    onSettled: (_report: ContentReport | undefined) =>
      invalidateAll(client, [queryKeys.feed.root, queryKeys.comments.root, queryKeys.safety.root]),
  });
}

/**
 * Block somebody.
 *
 * `blockUser` files the report on its way through when the block came from a
 * post or a comment — the UI does not fire two mutations, because two mutations
 * means two chances to half-succeed.
 */
export function useBlockUser() {
  const { ctx } = useActor();
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: BlockInput) => adapter.blockUser(ctx, input),
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: queryKeys.feed.root });
      const snapshot = captureQueries(client, [queryKeys.feed.root, queryKeys.comments.root]);

      purge(client, (row) => row.authorId === input.userId);

      return { snapshot };
    },
    onError: (error, _input, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'safety.block' });
    },
    onSuccess: (account: BlockedAccount) =>
      client.setQueryData<BlockedAccount[]>(queryKeys.blocks.forUser(ctx.userId), (list) =>
        list && !list.some((row) => row.userId === account.userId) ? [account, ...list] : list,
      ),
    onSettled: () =>
      invalidateAll(client, [queryKeys.feed.root, queryKeys.comments.root, queryKeys.safety.root]),
  });
}

/**
 * Unblock. The feed refills on the next fetch rather than optimistically —
 * letting somebody back in is not urgent the way keeping them out was, and
 * re-inserting rows into a scrolled list would jump the page under a thumb.
 */
export function useUnblockUser() {
  const { ctx } = useActor();
  const client = useQueryClient();

  return useMutation({
    mutationFn: (userId: ID) => adapter.unblockUser(ctx, userId),
    onMutate: async (userId) => {
      await client.cancelQueries({ queryKey: queryKeys.blocks.forUser(ctx.userId) });
      const snapshot = captureQueries(client, [queryKeys.blocks.forUser(ctx.userId)]);

      client.setQueryData<BlockedAccount[]>(queryKeys.blocks.forUser(ctx.userId), (list) =>
        list?.filter((row) => row.userId !== userId),
      );

      return { snapshot };
    },
    onError: (error, _userId, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'safety.unblock' });
    },
    onSettled: () =>
      invalidateAll(client, [queryKeys.feed.root, queryKeys.comments.root, queryKeys.safety.root]),
  });
}

/* -------------------------------------------------------------------- legal */

/**
 * Record agreement to the current terms.
 *
 * Writes through to the session store on success, because the router's legal
 * branch is guarded on `user.termsVersion` — without that line the gate would
 * stay mounted until the next session refresh, which is exactly the moment a
 * person is least willing to believe the button worked.
 */
export function useAcceptTerms() {
  const { ctx } = useActor();
  const client = useQueryClient();
  const setUser = useSession((s) => s.setUser);

  return useMutation({
    mutationFn: (version: number = TERMS_VERSION) => adapter.acceptTerms(ctx, version),
    onSuccess: (user) => {
      setUser(user);
      void invalidateAll(client, [queryKeys.session.root]);
    },
    onError: (error) => showErrorToast(error, { scope: 'legal.acceptTerms' }),
  });
}

/* --------------------------------------------------------- the agreement gate */

/** Has this *account* agreed to the version currently shipping? */
function accountIsCurrent(user: { termsVersion: number | null } | null): boolean {
  return user !== null && (user.termsVersion ?? 0) >= TERMS_VERSION;
}

/**
 * `true` while the gate should be up.
 *
 * Two conditions, not one. The account being behind is the thing that matters —
 * it is what `petal_has_agreed()` checks before letting anything reach the feed.
 * But somebody who has *just* ticked the box on the sign-up form has agreed;
 * their account is only behind because the profile write hasn't happened yet,
 * and showing them the same rules a second time thirty seconds later reads as a
 * bug rather than as diligence. So a device holding current consent suppresses
 * the gate, and `useSyncTermsAcceptance` carries that consent to the account.
 */
export function useNeedsAgreement(): boolean {
  const user = useCurrentUser();
  const deviceVersion = usePreferences((s) => s.acceptedTermsVersion);
  if (!user) return false;
  return !accountIsCurrent(user) && deviceVersion < TERMS_VERSION;
}

/**
 * Write this device's agreement onto the account behind it.
 *
 * Mounted once, in the root navigator. It is the other half of the suppression
 * above: without it a fresh sign-up would sail past the gate with a profile that
 * has never agreed to anything, and the first post would be refused by RLS with
 * nothing on screen explaining why.
 *
 * Guarded by a ref rather than by `isPending` because the mutation resolving
 * updates the session user, which re-runs this effect — and an unguarded version
 * would stamp the profile twice for every sign-up.
 */
export function useSyncTermsAcceptance(): void {
  const user = useCurrentUser();
  const deviceVersion = usePreferences((s) => s.acceptedTermsVersion);
  const accept = useAcceptTerms();
  const stampedFor = useRef<ID | null>(null);

  const owed = user !== null && !accountIsCurrent(user) && deviceVersion >= TERMS_VERSION;

  useEffect(() => {
    if (!owed || !user) return;
    if (stampedFor.current === user.id) return;
    stampedFor.current = user.id;
    accept.mutate(TERMS_VERSION);
  }, [accept, owed, user]);
}
