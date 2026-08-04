/**
 * Community — feed, posts, comments and groups.
 *
 * The feed is a cursor-paged infinite query, flattened by `select` so screens
 * render a plain array and never think about pages. Optimistic writes work on
 * the *unflattened* cache underneath, which is why a like survives a page
 * boundary and doesn't reorder anything.
 *
 * Likes and joins are the two interactions people repeat fastest, so both are
 * fully optimistic across every cached view of the same row — the feed, the
 * post screen and a group's own feed can all be mounted at once, and a heart
 * that fills in one place and not the other is worse than no animation at all.
 *
 * Posting is *not* optimistic. There are usually images crossing the network,
 * and a post that appears instantly then disappears on a failed upload is a
 * small betrayal; the composer keeps its progress state and the feed refetches.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';

import { adapter } from '@/data';
import type { FeedScope, Page, PostInput } from '@/data/adapter';
import {
  captureQueries,
  invalidateAll,
  restoreQueries,
  showErrorToast,
  STALE,
} from '@/data/QueryProvider';
import { queryKeys } from '@/data/queryKeys';
import type { CommentWithAuthor, Group, ID, PostWithAuthor } from '@/data/types';
import { newId } from '@/lib/id';
import { useActor, useCurrentUser } from '@/stores/session';

/* -------------------------------------------------------------------- types */

export type CreatePostInput = PostInput;

const FEED_PAGE_SIZE = 10;

type FeedCache = InfiniteData<Page<PostWithAuthor>, string | null>;

const flattenFeed = (data: FeedCache): PostWithAuthor[] => data.pages.flatMap((page) => page.items);

/** Apply a patch to one post everywhere it is currently cached. */
function patchPostEverywhere(
  client: QueryClient,
  postId: ID,
  patch: (post: PostWithAuthor) => PostWithAuthor,
): void {
  client.setQueriesData<FeedCache>({ queryKey: queryKeys.feed.root }, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((post) => (post.id === postId ? patch(post) : post)),
          })),
        }
      : data,
  );

  client.setQueryData<PostWithAuthor | null>(queryKeys.post.detail(postId), (post) =>
    post ? patch(post) : post,
  );
}

function removePostEverywhere(client: QueryClient, postId: ID): void {
  client.setQueriesData<FeedCache>({ queryKey: queryKeys.feed.root }, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.filter((post) => post.id !== postId),
          })),
        }
      : data,
  );
}

function patchGroupEverywhere(client: QueryClient, groupId: ID, patch: (group: Group) => Group): void {
  client.setQueryData<Group[]>(queryKeys.groups.list(), (groups) =>
    groups?.map((group) => (group.id === groupId ? patch(group) : group)),
  );
  client.setQueryData<Group | null>(queryKeys.groups.detail(groupId), (group) =>
    group ? patch(group) : group,
  );
}

/* --------------------------------------------------------------------- feed */

export function useFeed(scope?: FeedScope, pageSize = FEED_PAGE_SIZE) {
  const { ctx, ready } = useActor();

  return useInfiniteQuery({
    queryKey: queryKeys.feed.scoped(scope),
    queryFn: ({ pageParam }) =>
      adapter.listFeed(ctx, { limit: pageSize, cursor: pageParam ?? undefined, scope }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: ready,
    staleTime: STALE.short,
    select: flattenFeed,
  });
}

export function usePost(postId: ID | null | undefined) {
  const { ctx, ready } = useActor();
  const client = useQueryClient();
  const id = postId ?? '';

  return useQuery({
    queryKey: queryKeys.post.detail(id),
    queryFn: () => adapter.getPost(ctx, id),
    enabled: ready && id !== '',
    staleTime: STALE.short,
    // Tapping a post from the feed opens on the post we already hold.
    placeholderData: () => {
      const cached = client.getQueriesData<FeedCache>({ queryKey: queryKeys.feed.root });
      for (const [, data] of cached) {
        const hit = data?.pages.flatMap((page) => page.items).find((post) => post.id === id);
        if (hit) return hit;
      }
      return undefined;
    },
  });
}

export function useCreatePost() {
  const { ctx } = useActor();
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: CreatePostInput) => adapter.createPost(ctx, input),
    onError: (error) => showErrorToast(error, { scope: 'community.createPost' }),
    onSettled: () => invalidateAll(client, [queryKeys.feed.root, queryKeys.groups.root]),
  });
}

export function useDeletePost() {
  const { ctx } = useActor();
  const client = useQueryClient();

  return useMutation({
    mutationFn: (postId: ID) => adapter.deletePost(ctx, postId),
    onMutate: async (postId) => {
      await client.cancelQueries({ queryKey: queryKeys.feed.root });
      const snapshot = captureQueries(client, [queryKeys.feed.root]);
      removePostEverywhere(client, postId);
      return { snapshot };
    },
    onError: (error, _postId, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'community.deletePost' });
    },
    onSuccess: (_result, postId) => client.removeQueries({ queryKey: queryKeys.post.detail(postId) }),
    onSettled: () => invalidateAll(client, [queryKeys.feed.root, queryKeys.groups.root]),
  });
}

/** The double-tap. Instant, or it isn't worth having. */
export function useToggleLike() {
  const { ctx } = useActor();
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ postId, liked }: { postId: ID; liked: boolean }) =>
      adapter.toggleLike(ctx, postId, liked),
    onMutate: async ({ postId, liked }) => {
      await client.cancelQueries({ queryKey: queryKeys.feed.root });
      await client.cancelQueries({ queryKey: queryKeys.post.detail(postId) });
      const snapshot = captureQueries(client, [queryKeys.feed.root, queryKeys.post.detail(postId)]);

      patchPostEverywhere(client, postId, (post) => ({
        ...post,
        likedByMe: liked,
        likeCount: Math.max(0, post.likeCount + (liked ? 1 : -1)),
      }));

      return { snapshot };
    },
    onError: (error, _variables, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'community.toggleLike' });
    },
    // No invalidate on settle: the server's count is already what we computed,
    // and refetching the feed would scroll-jump under the user's thumb. The
    // next natural refetch reconciles it.
    onSuccess: (post) =>
      patchPostEverywhere(client, post.id, (cached) => ({
        ...cached,
        likeCount: post.likeCount,
        likedByMe: post.likedByMe,
      })),
  });
}

/* ----------------------------------------------------------------- comments */

export function useComments(postId: ID | null | undefined) {
  const { ctx, ready } = useActor();
  const id = postId ?? '';

  return useQuery({
    queryKey: queryKeys.comments.forPost(id),
    queryFn: () => adapter.listComments(ctx, id),
    enabled: ready && id !== '',
    staleTime: STALE.short,
  });
}

/**
 * A comment appears the instant it's sent — the keyboard is still up and the
 * thread should already show it, the same way every messaging app behaves.
 */
export function useAddComment(postId: ID) {
  const { ctx } = useActor();
  const client = useQueryClient();
  const user = useCurrentUser();
  const key = queryKeys.comments.forPost(postId);

  return useMutation({
    mutationFn: (body: string) => adapter.addComment(ctx, postId, body.trim()),
    onMutate: async (body) => {
      await client.cancelQueries({ queryKey: key });
      const snapshot = captureQueries(client, [key, queryKeys.feed.root, queryKeys.post.detail(postId)]);

      if (user) {
        const optimistic: CommentWithAuthor = {
          id: newId(),
          postId,
          authorId: user.id,
          body: body.trim(),
          likeCount: 0,
          likedByMe: false,
          createdAt: new Date().toISOString(),
          author: user,
        };
        client.setQueryData<CommentWithAuthor[]>(key, (comments) => [...(comments ?? []), optimistic]);
        patchPostEverywhere(client, postId, (post) => ({
          ...post,
          commentCount: post.commentCount + 1,
        }));
      }

      return { snapshot };
    },
    onError: (error, _body, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'community.addComment' });
    },
    onSettled: () => invalidateAll(client, [key, queryKeys.post.detail(postId)]),
  });
}

export function useDeleteComment(postId: ID) {
  const { ctx } = useActor();
  const client = useQueryClient();
  const key = queryKeys.comments.forPost(postId);

  return useMutation({
    mutationFn: (commentId: ID) => adapter.deleteComment(ctx, postId, commentId),
    onMutate: async (commentId) => {
      await client.cancelQueries({ queryKey: key });
      const snapshot = captureQueries(client, [key, queryKeys.feed.root, queryKeys.post.detail(postId)]);

      client.setQueryData<CommentWithAuthor[]>(key, (comments) =>
        comments?.filter((comment) => comment.id !== commentId),
      );
      patchPostEverywhere(client, postId, (post) => ({
        ...post,
        commentCount: Math.max(0, post.commentCount - 1),
      }));

      return { snapshot };
    },
    onError: (error, _commentId, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'community.deleteComment' });
    },
    onSettled: () => invalidateAll(client, [key, queryKeys.post.detail(postId)]),
  });
}

/* ------------------------------------------------------------------- groups */

/** Reference data — refetching a breed group's description hourly is plenty. */
export function useGroups() {
  const { ctx, ready } = useActor();

  return useQuery({
    queryKey: queryKeys.groups.list(),
    queryFn: () => adapter.listGroups(ctx),
    enabled: ready,
    staleTime: STALE.long,
  });
}

export function useGroup(groupId: ID | null | undefined) {
  const { ctx, ready } = useActor();
  const client = useQueryClient();
  const id = groupId ?? '';

  return useQuery({
    queryKey: queryKeys.groups.detail(id),
    queryFn: () => adapter.getGroup(ctx, id),
    enabled: ready && id !== '',
    staleTime: STALE.long,
    placeholderData: () =>
      client.getQueryData<Group[]>(queryKeys.groups.list())?.find((group) => group.id === id),
  });
}

export function useToggleGroupMembership() {
  const { ctx } = useActor();
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ groupId, joined }: { groupId: ID; joined: boolean }) =>
      adapter.toggleGroupMembership(ctx, groupId, joined),
    onMutate: async ({ groupId, joined }) => {
      await client.cancelQueries({ queryKey: queryKeys.groups.root });
      const snapshot = captureQueries(client, [queryKeys.groups.root]);

      patchGroupEverywhere(client, groupId, (group) => ({
        ...group,
        joined,
        memberCount: Math.max(0, group.memberCount + (joined ? 1 : -1)),
      }));

      return { snapshot };
    },
    onError: (error, _variables, context) => {
      restoreQueries(client, context?.snapshot);
      showErrorToast(error, { scope: 'community.toggleGroup' });
    },
    onSuccess: (group) => patchGroupEverywhere(client, group.id, () => group),
    onSettled: () => invalidateAll(client, [queryKeys.feed.root]),
  });
}
