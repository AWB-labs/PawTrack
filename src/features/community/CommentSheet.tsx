/**
 * Petal — comments.
 *
 * One thread, two homes: it rises as a sheet from the feed and sits inline on
 * the post screen. So the state lives in a hook (`useCommentThread`) and the
 * two pieces of chrome — `CommentList` and `CommentBar` — are pure. The sheet
 * below is just the two of them wired to a `<Sheet>`.
 *
 * Three decisions worth defending:
 *
 *   · **Threads out of a flat table.** `Comment` has no `parentId`, so a reply
 *     is expressed the way people already write them: it opens with the name of
 *     the person being answered. `buildThread()` reads that back, nests the
 *     reply under that author's most recent top-level comment, and the row
 *     renders the address in brand ink rather than repeating it as prose. No
 *     schema change, real threads, and a reply still reads correctly anywhere
 *     the convention isn't understood.
 *   · **The send is optimistic, the like is too.** `useAddComment` patches the
 *     thread and the post's comment count on mutate, so the comment is on screen
 *     while the keyboard is still up. Liking a comment has no adapter endpoint
 *     yet, so that one is held in the query cache instead of a mutation — it
 *     survives moving between the sheet and the post screen and reconciles on
 *     the next refetch. When the endpoint lands, only the body of `toggleLike`
 *     changes.
 *   · **The list is a column, not a scroller.** Threads here are short, and a
 *     scroll view nested inside the sheet's scroll view (or the post screen's)
 *     is the classic way to break momentum on Android. The host owns scrolling.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import Animated, {
  FadeIn,
  FadeInDown,
  LinearTransition,
  ReduceMotion,
  useAnimatedKeyboard,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  type WithSpringConfig,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  useAddComment,
  useComments,
  useDeleteComment,
} from '@/data/queries/useCommunity';
import { queryKeys } from '@/data/queryKeys';
import type { CommentWithAuthor, ID } from '@/data/types';
import { relativeTime } from '@/lib/date';
import { formatCount, pluralWord, possessive } from '@/lib/format';
import haptics from '@/lib/haptics';
import { moderateText } from '@/lib/moderation';
import { useCurrentUser } from '@/stores/session';
import { spring, useTheme } from '@/theme';
import {
  Avatar,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  Sheet,
  SheetHeader,
  SwipeRow,
  Text,
  TextArea,
  Touchable,
  toast,
  type SheetController,
  type TextAreaHandle,
} from '@/ui';
import { EmptyComments } from '@/ui/illustrations';
import { ListRowSkeleton } from '@/ui/skeletons/ContentSkeletons';
import { useContentSafety } from './SafetySheets';

/* -------------------------------------------------------------------- types */

/** A reply, plus the name it opened with so the row can style the address. */
export type CommentReply = { comment: CommentWithAuthor; addressing: string };

export type CommentThreadNode = { comment: CommentWithAuthor; replies: CommentReply[] };

export type CommentThreadState = {
  nodes: CommentThreadNode[];
  /** Every comment, replies included. */
  count: number;
  pending: boolean;
  error: unknown;
  refetch: () => void;
  draft: string;
  setDraft: (value: string) => void;
  replyingTo: CommentWithAuthor | null;
  startReply: (comment: CommentWithAuthor) => void;
  cancelReply: () => void;
  send: () => void;
  sending: boolean;
  canSend: boolean;
  toggleLike: (comment: CommentWithAuthor) => void;
  remove: (comment: CommentWithAuthor) => void;
  /** Null while the session hydrates — used to find the reader's own rows. */
  meId: ID | null;
};

export type CommentListProps = {
  thread: CommentThreadState;
  /** Whose post this is — "Buddy", "Priya". Every line of copy uses it. */
  subject: string;
  /** The ground the rows sit on, so the swipe panel can't show through. */
  ground: string;
  /** Empty state's one action: put the cursor in the bar. */
  onWriteFirst: () => void;
  /**
   * Opens report / block for somebody else's comment. Omitted only where there
   * is nowhere to put the sheets — the row simply loses its overflow control.
   */
  onMore?: (comment: CommentWithAuthor) => void;
  style?: StyleProp<ViewStyle>;
};

export type CommentBarProps = {
  thread: CommentThreadState;
  subject: string;
  /** Rise with the keyboard. Off inside a sheet, which already does. */
  lift?: boolean;
  /** Absorb the bottom safe-area inset — true on a screen, false in a footer. */
  safeArea?: boolean;
  /**
   * Draw the bar's own ground, hairline and gutter. Off inside `Sheet`'s
   * footer, which already supplies all three — two of each reads as a mistake.
   */
  framed?: boolean;
  inputRef?: React.Ref<TextAreaHandle>;
  style?: StyleProp<ViewStyle>;
};

export type CommentSheetProps = {
  controller: SheetController;
  postId: ID | null;
  subject: string;
};

/* ---------------------------------------------------------------- constants */

/** See `@/ui/Touchable` — the theme's `springWith` helper doesn't type-check yet. */
const POP_IN: WithSpringConfig = { ...spring.bouncy, reduceMotion: ReduceMotion.System };
const POP_OUT: WithSpringConfig = { ...spring.gentle, reduceMotion: ReduceMotion.System };
const SEND_SPRING: WithSpringConfig = { ...spring.snappy, reduceMotion: ReduceMotion.System };

/** Entrance stagger cap — past this the thread reads as slow rather than lively. */
const STAGGER_CAP = 8;

/** Long enough for a real thought, short enough to stay a comment. */
const COMMENT_MAX = 400;

/* ------------------------------------------------------------------ helpers */

/**
 * Fold a flat comment list into threads. A comment that opens with the display
 * name of someone who has already commented is nested under that person's most
 * recent top-level comment; everything else is a root. Replies never nest
 * further, because a two-level thread is the deepest anyone reads on a phone.
 */
export function buildThread(comments: readonly CommentWithAuthor[]): CommentThreadNode[] {
  const nodes: CommentThreadNode[] = [];
  const latestByAuthor = new Map<string, CommentThreadNode>();

  for (const comment of comments) {
    const target = addressedNode(comment.body, latestByAuthor);
    if (target) {
      target.node.replies.push({ comment, addressing: target.name });
      continue;
    }
    const node: CommentThreadNode = { comment, replies: [] };
    nodes.push(node);
    latestByAuthor.set(comment.author.displayName, node);
  }

  return nodes;
}

/** Longest matching name wins, so "Sam" can't swallow a reply meant for "Sam O". */
function addressedNode(
  body: string,
  index: ReadonlyMap<string, CommentThreadNode>,
): { name: string; node: CommentThreadNode } | null {
  if (!body.startsWith('@')) return null;

  let best: { name: string; node: CommentThreadNode } | null = null;
  for (const [name, node] of index) {
    const prefix = `@${name}`;
    if (!body.startsWith(prefix)) continue;
    if (body.length <= prefix.length) continue;
    if (best === null || name.length > best.name.length) best = { name, node };
  }
  return best;
}

/* --------------------------------------------------------------------- hook */

export function useCommentThread(postId: ID | null | undefined): CommentThreadState {
  const id = postId ?? '';
  const client = useQueryClient();
  const me = useCurrentUser();

  const query = useComments(id === '' ? null : id);
  const add = useAddComment(id);
  const del = useDeleteComment(id);

  const [draft, setDraft] = useState('');
  const [replyingTo, setReplyingTo] = useState<CommentWithAuthor | null>(null);
  /** Has the filter already asked about *this* draft? See `send`. */
  const [warned, setWarned] = useState(false);

  const comments = useMemo(() => query.data ?? [], [query.data]);
  const nodes = useMemo(() => buildThread(comments), [comments]);

  const startReply = useCallback((comment: CommentWithAuthor) => {
    haptics.tap();
    setReplyingTo(comment);
  }, []);

  const cancelReply = useCallback(() => setReplyingTo(null), []);

  /**
   * Send, with the content filter in front of it.
   *
   * A comment is too small to justify a confirmation sheet, so the two verdicts
   * are spent differently: `block` refuses and keeps the draft, and `warn` costs
   * one tap — the first press says why, the second sends it. That is enough
   * friction to catch a comment written in temper and not enough to be a wall
   * in front of a comment that was fine.
   */
  const send = useCallback(() => {
    const text = draft.trim();
    if (text.length === 0 || id === '') return;

    const verdict = moderateText(text);
    if (verdict.verdict === 'block') {
      haptics.error();
      toast.error('We can’t post that', { description: verdict.message ?? undefined });
      return;
    }
    if (verdict.verdict === 'warn' && !warned) {
      haptics.warn();
      setWarned(true);
      toast.warning('Have another look?', {
        description: `${verdict.message ?? ''} Send again if you meant it.`.trim(),
      });
      return;
    }

    const body = replyingTo ? `@${replyingTo.author.displayName} ${text}` : text;
    setDraft('');
    setReplyingTo(null);
    setWarned(false);
    haptics.commit();
    add.mutate(body);
  }, [add, draft, id, replyingTo, warned]);

  /**
   * No adapter endpoint for comment likes yet, so this is a cache-held
   * reaction rather than a mutation: instant, shared by every mounted view of
   * the thread, and reconciled on the next refetch.
   */
  const toggleLike = useCallback(
    (comment: CommentWithAuthor) => {
      if (id === '') return;
      const next = !comment.likedByMe;
      if (next) haptics.soft();
      else haptics.tap();
      client.setQueryData<CommentWithAuthor[]>(queryKeys.comments.forPost(id), (rows) =>
        rows?.map((row) =>
          row.id === comment.id
            ? {
                ...row,
                likedByMe: next,
                likeCount: Math.max(0, row.likeCount + (next ? 1 : -1)),
              }
            : row,
        ),
      );
    },
    [client, id],
  );

  const remove = useCallback(
    (comment: CommentWithAuthor) => {
      haptics.commit();
      del.mutate(comment.id);
      toast.success('Taken down', { description: 'Your comment is gone from the thread.' });
    },
    [del],
  );

  return {
    nodes,
    count: comments.length,
    pending: query.isPending,
    error: query.isError ? query.error : null,
    refetch: () => {
      void query.refetch();
    },
    draft,
    setDraft: (next: string) => {
      // Editing after a warning clears it: the next press is a first press
      // again, because the sentence it objected to is no longer the sentence.
      setWarned(false);
      setDraft(next);
    },
    replyingTo,
    startReply,
    cancelReply,
    send,
    sending: add.isPending,
    canSend: draft.trim().length > 0,
    toggleLike,
    remove,
    meId: me?.id ?? null,
  };
}

/* --------------------------------------------------------------------- list */

export function CommentList({
  thread,
  subject,
  ground,
  onWriteFirst,
  onMore,
  style,
}: CommentListProps) {
  const t = useTheme();

  if (thread.pending) {
    return (
      <View style={style}>
        <ListRowSkeleton count={3} avatar />
      </View>
    );
  }

  if (thread.error) {
    return (
      <View style={style}>
        <ErrorState
          variant="compact"
          frame
          error={thread.error}
          title="The conversation didn’t load"
          body="It's still there — we just couldn't reach it. One more try usually does it."
          onRetry={thread.refetch}
        />
      </View>
    );
  }

  if (thread.nodes.length === 0) {
    return (
      <View style={style}>
        <EmptyState
          variant="compact"
          frame
          illustration={<EmptyComments size={t.spacing.colossal * 2} />}
          headline="No one’s said anything yet"
          body={`Be the first to answer ${possessive(subject)} post — a single line is plenty.`}
          action={{
            label: 'Write the first one',
            icon: 'chatbubble-ellipses-outline',
            onPress: onWriteFirst,
          }}
        />
      </View>
    );
  }

  let position = 0;

  return (
    <View style={[{ gap: t.spacing.base }, style]}>
      {thread.nodes.map((node) => {
        const rows = (
          <View key={node.comment.id} style={{ gap: t.spacing.sm }}>
            <CommentRow
              comment={node.comment}
              addressing={null}
              index={position}
              ground={ground}
              thread={thread}
              onMore={onMore}
            />
            {node.replies.length > 0 ? (
              <View
                style={{
                  marginLeft: t.spacing.xl,
                  paddingLeft: t.spacing.md,
                  gap: t.spacing.sm,
                  borderLeftWidth: t.borderWidth.hairline,
                  borderLeftColor: t.color.divider,
                }}
              >
                {node.replies.map((reply, replyIndex) => (
                  <CommentRow
                    key={reply.comment.id}
                    comment={reply.comment}
                    addressing={reply.addressing}
                    index={position + replyIndex + 1}
                    ground={ground}
                    thread={thread}
                    onMore={onMore}
                    compact
                  />
                ))}
              </View>
            ) : null}
          </View>
        );

        position += 1 + node.replies.length;
        return rows;
      })}
    </View>
  );
}

/* ---------------------------------------------------------------------- row */

function CommentRow({
  comment,
  addressing,
  index,
  ground,
  thread,
  onMore,
  compact = false,
}: {
  comment: CommentWithAuthor;
  addressing: string | null;
  index: number;
  ground: string;
  thread: CommentThreadState;
  onMore?: (comment: CommentWithAuthor) => void;
  compact?: boolean;
}) {
  const t = useTheme();
  const mine = thread.meId !== null && comment.authorId === thread.meId;
  const when = relativeTime(comment.createdAt);
  const body = addressing ? comment.body.slice(addressing.length + 1).trimStart() : comment.body;

  const delay = Math.min(index, STAGGER_CAP) * t.motion.stagger.base;
  const entering = t.reduceMotion
    ? FadeIn.duration(t.motion.duration.base).delay(delay)
    : FadeInDown.duration(t.motion.duration.slow).delay(delay).easing(t.motion.easing.decelerate);

  const spoken = `${comment.author.displayName}, ${when}. ${addressing ? `Replying to ${addressing}. ` : ''}${body}`;

  const bubble = (
    <View
      style={[
        styles.row,
        {
          gap: t.spacing.sm,
          backgroundColor: ground,
          paddingVertical: t.spacing.xs,
        },
      ]}
    >
      <Avatar
        uri={comment.author.avatarUrl}
        name={comment.author.displayName}
        size={compact ? 'xs' : 'sm'}
      />

      <View style={styles.grow}>
        <View
          accessible
          accessibilityRole="text"
          accessibilityLabel={spoken}
          style={{
            backgroundColor: t.color.surfaceAlt,
            borderRadius: t.radius.lg,
            borderTopLeftRadius: t.spacing.xxs,
            paddingVertical: t.spacing.sm,
            paddingHorizontal: t.spacing.md,
            gap: t.spacing.hair,
          }}
        >
          <View style={[styles.row, { gap: t.spacing.xs }]}>
            <Text variant="captionStrong" numberOfLines={1} style={styles.shrink}>
              {comment.author.displayName}
            </Text>
            <Text variant="caption" color="textFaint" numberOfLines={1}>
              {when}
            </Text>
          </View>

          <Text variant={compact ? 'footnote' : 'callout'}>
            {addressing ? (
              <Text variant={compact ? 'footnote' : 'callout'} color="primaryText">
                {`@${addressing} `}
              </Text>
            ) : null}
            {body}
          </Text>
        </View>

        <View style={[styles.row, { gap: t.spacing.base, paddingTop: t.spacing.xxs }]}>
          <CommentLike comment={comment} onPress={() => thread.toggleLike(comment)} />
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={`Reply to ${comment.author.displayName}`}
            accessibilityHint="Puts their name at the front of your comment."
            haptic="none"
            onPress={() => thread.startReply(comment)}
            pressScale="small"
          >
            <Text variant="captionStrong" color="textTertiary">
              Reply
            </Text>
          </Touchable>

          {/* Spelled out rather than left to the swipe: a gesture is a fine
              shortcut and a poor only-way, and this is the control somebody is
              looking for at the worst possible moment. */}
          {!mine && onMore ? (
            <Touchable
              accessibilityRole="button"
              accessibilityLabel={`Report or block ${comment.author.displayName}`}
              accessibilityHint="Opens reporting and blocking for this comment."
              haptic="tap"
              onPress={() => onMore(comment)}
              pressScale="small"
            >
              <Text variant="captionStrong" color="textTertiary">
                Report
              </Text>
            </Touchable>
          ) : null}
        </View>
      </View>
    </View>
  );

  return (
    <Animated.View
      entering={entering}
      layout={t.reduceMotion ? undefined : LinearTransition.duration(t.motion.duration.base)}
    >
      {mine ? (
        <SwipeRow
          background={ground}
          radius="lg"
          right={[
            {
              key: 'delete',
              label: 'Delete',
              icon: 'trash-outline',
              tone: 'danger',
              fullSwipe: true,
              onPress: () => thread.remove(comment),
            },
          ]}
        >
          {bubble}
        </SwipeRow>
      ) : onMore ? (
        <SwipeRow
          background={ground}
          radius="lg"
          right={[
            {
              key: 'report',
              label: 'Report',
              icon: 'flag-outline',
              tone: 'warning',
              onPress: () => onMore(comment),
            },
          ]}
        >
          {bubble}
        </SwipeRow>
      ) : (
        bubble
      )}
    </Animated.View>
  );
}

/** The per-comment heart. Small, quiet, and it pops when it fills. */
function CommentLike({ comment, onPress }: { comment: CommentWithAuthor; onPress: () => void }) {
  const t = useTheme();
  const liked = comment.likedByMe;

  const pop = useSharedValue(0);
  const popStyle = useAnimatedStyle(() => ({ transform: [{ scale: 1 + pop.value * 0.35 }] }));

  const handlePress = useCallback(() => {
    if (!comment.likedByMe) {
      pop.value = withSequence(withSpring(1, POP_IN), withSpring(0, POP_OUT));
    }
    onPress();
  }, [comment.likedByMe, onPress, pop]);

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={
        liked
          ? `Liked. ${comment.likeCount} ${pluralWord(comment.likeCount, 'like')}`
          : `Like this comment. ${comment.likeCount} ${pluralWord(comment.likeCount, 'like')}`
      }
      accessibilityState={{ selected: liked }}
      haptic="none"
      onPress={handlePress}
      pressScale="small"
      style={[styles.row, { gap: t.spacing.xxs }]}
    >
      <Animated.View style={popStyle}>
        <Icon
          name={liked ? 'heart' : 'heart-outline'}
          size="xs"
          color={liked ? t.color.danger : t.color.textTertiary}
        />
      </Animated.View>
      {comment.likeCount > 0 ? (
        <Text variant="caption" color={liked ? 'danger' : 'textTertiary'} tabular>
          {formatCount(comment.likeCount)}
        </Text>
      ) : null}
    </Touchable>
  );
}

/* ---------------------------------------------------------------------- bar */

export function CommentBar({
  thread,
  subject,
  lift = false,
  safeArea = false,
  framed = true,
  inputRef,
  style,
}: CommentBarProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const me = useCurrentUser();

  const replyName = thread.replyingTo?.author.displayName ?? null;

  const grow = useSharedValue(0);
  const sendStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 0.6 + grow.value * 0.4 }],
    opacity: 0.35 + grow.value * 0.65,
  }));

  useEffect(() => {
    grow.value = withSpring(thread.canSend ? 1 : 0, SEND_SPRING);
  }, [grow, thread.canSend]);

  const frame: StyleProp<ViewStyle> = [
    framed
      ? {
          backgroundColor: t.color.surface,
          borderTopWidth: t.borderWidth.hairline,
          borderTopColor: t.color.chromeBorder,
          paddingHorizontal: t.gutter,
          paddingTop: t.spacing.md,
          paddingBottom: (safeArea ? insets.bottom : 0) + t.spacing.md,
        }
      : null,
    { gap: t.spacing.sm },
    style,
  ];

  const content = (
    <>
      {replyName ? (
        <Animated.View
          entering={t.reduceMotion ? FadeIn : FadeInDown.duration(t.motion.duration.fast)}
          style={[
            styles.row,
            {
              gap: t.spacing.xs,
              alignSelf: 'flex-start',
              paddingVertical: t.spacing.xxs,
              paddingHorizontal: t.spacing.sm,
              borderRadius: t.radius.pill,
              backgroundColor: t.color.primarySoft,
            },
          ]}
        >
          <Icon name="return-down-forward-outline" size="xs" color="onPrimarySoft" />
          <Text variant="caption" color="onPrimarySoft" numberOfLines={1} style={styles.shrink}>
            {`Replying to ${replyName}`}
          </Text>
          <Touchable
            accessibilityRole="button"
            accessibilityLabel="Stop replying"
            accessibilityHint="Your comment goes to the thread instead."
            haptic="tap"
            onPress={thread.cancelReply}
            pressScale="small"
          >
            <Icon name="close" size="xs" color="onPrimarySoft" />
          </Touchable>
        </Animated.View>
      ) : null}

      <View style={[styles.barRow, { gap: t.spacing.sm }]}>
        <Avatar uri={me?.avatarUrl} name={me?.displayName} size="sm" />

        <View style={styles.grow}>
          <TextArea
            ref={inputRef}
            value={thread.draft}
            onChangeText={thread.setDraft}
            variant="filled"
            minRows={1}
            maxRows={4}
            maxLength={COMMENT_MAX}
            placeholder={
              replyName ? `Say something to ${replyName}…` : `Say something to ${subject}…`
            }
            accessibilityLabel="Your comment"
            accessibilityHint="Posts to this thread straight away."
          />
        </View>

        <Animated.View style={sendStyle}>
          <IconButton
            icon="arrow-up"
            accessibilityLabel="Post your comment"
            accessibilityHint="Adds it to the thread."
            variant="solid"
            tone="primary"
            size="md"
            shape="circle"
            haptic="none"
            loading={thread.sending}
            disabled={!thread.canSend}
            onPress={thread.send}
          />
        </Animated.View>
      </View>
    </>
  );

  if (lift && BAR_LIFTS_ITSELF) {
    return (
      <KeyboardLift inset={safeArea ? insets.bottom : 0} style={frame}>
        {content}
      </KeyboardLift>
    );
  }

  return <View style={frame}>{content}</View>;
}

/**
 * iOS leaves the window where it is when the keyboard opens, so a bar pinned to
 * the bottom has to move itself. Android resizes the window and has already
 * done the job — the same split `@/ui/Screen`'s keyboard avoider makes.
 */
const BAR_LIFTS_ITSELF = Platform.OS === 'ios';

function KeyboardLift({
  inset,
  style,
  children,
}: {
  /** Safe-area padding already in the resting bar, which the keyboard replaces. */
  inset: number;
  style: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const keyboard = useAnimatedKeyboard();
  const liftStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -Math.max(0, keyboard.height.value - inset) }],
  }));

  return <Animated.View style={[style, liftStyle]}>{children}</Animated.View>;
}

/**
 * Drop this at the end of a scroll view whose bottom is covered by a lifting
 * bar — it grows to the keyboard's height so the last comment stays readable.
 * Renders nothing where the platform resizes the window instead.
 */
export function KeyboardSpacer({ inset = 0 }: { inset?: number }) {
  return BAR_LIFTS_ITSELF ? <KeyboardSpacerIOS inset={inset} /> : null;
}

function KeyboardSpacerIOS({ inset }: { inset: number }) {
  const keyboard = useAnimatedKeyboard();
  const style = useAnimatedStyle(() => ({
    height: Math.max(0, keyboard.height.value - inset),
  }));
  return <Animated.View style={style} />;
}

/* -------------------------------------------------------------------- sheet */

export function CommentSheet({ controller, postId, subject }: CommentSheetProps) {
  const t = useTheme();
  const thread = useCommentThread(postId);
  const inputRef = useRef<TextAreaHandle | null>(null);
  const safety = useContentSafety();

  const focusBar = useCallback(() => inputRef.current?.focus(), []);

  const openSafety = useCallback(
    (comment: CommentWithAuthor) => {
      safety.open({
        kind: 'comment',
        id: comment.id,
        authorId: comment.authorId,
        authorName: comment.author.displayName,
        snapshot: comment.body,
      });
    },
    [safety],
  );

  return (
    <>
    <Sheet
      controller={controller}
      size="tall"
      scrollable
      contentStyle={{ gap: t.spacing.base }}
      footer={<CommentBar thread={thread} subject={subject} framed={false} inputRef={inputRef} />}
    >
      <SheetHeader
        title={thread.count === 0 ? 'Comments' : `${formatCount(thread.count)} comments`}
        subtitle={`Everyone talking about ${possessive(subject)} post.`}
        onClose={controller.close}
      />
      <CommentList
        thread={thread}
        subject={subject}
        ground={t.color.surfaceRaised}
        onWriteFirst={focusBar}
        onMore={openSafety}
      />
    </Sheet>

    {safety.element}
    </>
  );
}

/* ----------------------------------------------------------------- styles */

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  barRow: { flexDirection: 'row', alignItems: 'flex-end' },
  grow: { flex: 1 },
  shrink: { flexShrink: 1 },
});

export default CommentSheet;
