/**
 * Community — the feed.
 *
 * The brief asked for this tab to "feel alive", which in practice is four
 * things, none of them decoration:
 *
 *   · **Nothing ever blocks on the network.** Likes and joins are optimistic in
 *     the query layer, so the heart fills and the count moves before the request
 *     leaves the device. Switching scope never refetches — all three scopes read
 *     the *same* cached feed and differ only in the filter, so the segmented
 *     control moves as fast as a finger and no skeleton flashes between tabs.
 *     (`FeedScope` on the adapter is a single-group/author/pet narrowing; the
 *     scopes here are set-shaped, which is why they live client-side.)
 *   · **Paws, not a spinner.** `RefreshableFlatList` replaces the platform
 *     control with the pull-to-refresh trail, offset to clear the floating
 *     header.
 *   · **The chrome gets out of the way.** The compose button retracts on the
 *     way down and springs back the moment you reverse, driven straight off the
 *     list's shared scroll offset — no re-renders while you flick.
 *   · **All four states, per scope.** Each scope's empty state says something
 *     true about *that* scope; "My groups" with nothing joined shows real groups
 *     to join rather than an apology.
 *
 * The header is rendered inside `Screen`'s children rather than via its `header`
 * slot on purpose: the slot pads content down by the header's height, and this
 * list needs to scroll *underneath* the blur for the large title to collapse
 * against something.
 */

import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import type { ParamListBase } from '@react-navigation/native';
import { useNavigation, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, View, type ListRenderItemInfo } from 'react-native';
import Animated, {
  FadeIn,
  ReduceMotion,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
  type WithSpringConfig,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useFeed, useGroups } from '@/data/queries/useCommunity';
import { usePets } from '@/data/queries/usePets';
import type { Group, ID, PostWithAuthor } from '@/data/types';
import { CommentSheet } from '@/features/community/CommentSheet';
import { GroupCard } from '@/features/community/GroupCard';
import { GroupChip } from '@/features/community/GroupChip';
import { PostCard } from '@/features/community/PostCard';
import { toHref } from '@/lib/deeplinks';
import { useCurrentUser } from '@/stores/session';
import { spring, useTheme } from '@/theme';
import {
  EmptyState,
  ErrorState,
  Icon,
  PawPrint,
  RefreshableFlatList,
  Screen,
  ScreenHeader,
  SegmentedControl,
  SkeletonGroup,
  Text,
  Touchable,
  useScreenScroll,
  useSheet,
  type RefreshableFlatListProps,
  type Segment,
} from '@/ui';
import { EmptyFeed } from '@/ui/illustrations';
import { PostSkeleton } from '@/ui/skeletons/ContentSkeletons';

/* -------------------------------------------------------------------- types */

type FeedFilter = 'all' | 'following' | 'groups';

/* ---------------------------------------------------------------- constants */

/** See `@/ui/Touchable` — the theme's `springWith` helper doesn't type-check yet. */
const SETTLE: WithSpringConfig = { ...spring.snappy, reduceMotion: ReduceMotion.System };

const SEGMENTS: Segment<FeedFilter>[] = [
  { value: 'all', label: 'All' },
  { value: 'following', label: 'Following', accessibilityLabel: 'Following — your circle' },
  { value: 'groups', label: 'My groups' },
];

/** Entrance stagger cap — past this the list reads as slow rather than lively. */
const STAGGER_CAP = 8;

/**
 * Scroll delta, in points, below which a direction change is finger tremor
 * rather than intent. Not a design dimension — a gesture noise floor.
 */
const SCROLL_NOISE = 2;

/** Above this offset the compose button is allowed to retract. */
const FAB_ARM_OFFSET = 48;

/**
 * A filtered scope keeps pulling pages until it has at least this many posts or
 * the feed runs out — otherwise "Following" can look empty purely because the
 * first page happened to be strangers.
 */
const MIN_FILLED = 4;

/** Groups offered when the reader hasn't joined any. */
const SUGGESTION_COUNT = 3;

/* ---------------------------------------------------------------- feed list */

/**
 * `RefreshableFlatList` spreads every prop it doesn't consume onto the
 * `Animated.FlatList` beneath it, and React 19 delivers `ref` as an ordinary
 * prop — so a ref does reach the real list. Reanimated's
 * `FlatListPropsWithLayout` simply never declares `ref`; the capability is
 * restated here rather than added.
 */
const FeedList = RefreshableFlatList as <ItemT>(
  props: RefreshableFlatListProps<ItemT> & { ref?: React.Ref<FlatList<ItemT>> },
) => React.ReactElement;

/* --------------------------------------------------------------- component */

export default function CommunityScreen() {
  return (
    <Screen padded={false} edges={[]} keyboardAvoiding={false}>
      <CommunityFeed />
    </Screen>
  );
}

/**
 * Split out so it can read `Screen`'s scroll context — the header's collapse
 * and the list's top clearance are the same number, published once.
 */
function CommunityFeed() {
  const t = useTheme();
  const router = useRouter();
  const me = useCurrentUser();
  const insets = useSafeAreaInsets();
  const { scrollY, headerHeight } = useScreenScroll();
  const navigation = useNavigation<BottomTabNavigationProp<ParamListBase>>();

  /** Everything the floating tab bar occupies, so nothing hides behind it. */
  const tabBarZone = Math.max(insets.bottom, t.spacing.md) + t.spacing.giant;

  const feed = useFeed();
  const groupsQuery = useGroups();
  const petsQuery = usePets();

  const [filter, setFilter] = useState<FeedFilter>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [commentingOn, setCommentingOn] = useState<PostWithAuthor | null>(null);

  const listRef = useRef<FlatList<PostWithAuthor> | null>(null);
  const comments = useSheet();

  const all = useMemo(() => feed.data ?? [], [feed.data]);
  const groups = useMemo(() => groupsQuery.data ?? [], [groupsQuery.data]);

  /* ---- scopes ---------------------------------------------------------- */

  /**
   * Petal has no follow graph — it has something better and more honest: shared
   * responsibility for an animal. "Following" is therefore the people and pets
   * you're actually connected to: anything about a pet in your care, plus
   * anything written by someone who also looks after one.
   */
  const circle = useMemo(() => {
    const petIds = new Set((petsQuery.data ?? []).map((pet) => pet.id));
    const people = new Set<ID>();
    if (me) people.add(me.id);
    for (const post of all) {
      if (post.petId !== null && petIds.has(post.petId)) people.add(post.authorId);
    }
    return { petIds, people };
  }, [all, me, petsQuery.data]);

  const posts = useMemo(() => {
    if (filter === 'all') return all;
    if (filter === 'groups') return all.filter((post) => post.group?.joined === true);
    return all.filter(
      (post) =>
        (post.petId !== null && circle.petIds.has(post.petId)) || circle.people.has(post.authorId),
    );
  }, [all, circle, filter]);

  const joinedGroups = useMemo(() => groups.filter((group) => group.joined), [groups]);

  // Sorted so the rail opens on what you already care about.
  const rail = useMemo(
    () => [...groups].sort((a, b) => Number(b.joined) - Number(a.joined)),
    [groups],
  );

  /* ---- paging ---------------------------------------------------------- */

  const loadMore = useCallback(() => {
    if (feed.hasNextPage && !feed.isFetchingNextPage) void feed.fetchNextPage();
  }, [feed]);

  // A narrowed scope can exhaust a page without filling the screen; top it up
  // rather than showing an empty state that isn't true.
  useEffect(() => {
    if (filter === 'all') return;
    if (posts.length >= MIN_FILLED) return;
    loadMore();
  }, [filter, loadMore, posts.length]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([feed.refetch(), groupsQuery.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }, [feed, groupsQuery]);

  /* ---- tab re-tap ------------------------------------------------------ */

  useEffect(() => {
    const unsubscribe = navigation.addListener('tabPress', () => {
      if (!navigation.isFocused()) return;
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
    });
    return unsubscribe;
  }, [navigation]);

  /* ---- navigation ------------------------------------------------------ */

  const openPost = useCallback(
    (postId: ID) => router.push(toHref(`/community/post/${postId}`)),
    [router],
  );
  const openGroup = useCallback(
    (groupId: ID) => router.push(toHref(`/community/group/${groupId}`)),
    [router],
  );
  const openComposer = useCallback(() => router.push(toHref('/community/new')), [router]);

  const openComments = useCallback(
    (post: PostWithAuthor) => {
      setCommentingOn(post);
      comments.open();
    },
    [comments],
  );

  const changeFilter = useCallback((next: FeedFilter) => {
    setFilter(next);
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  /* ---- chrome ---------------------------------------------------------- */

  const header = (
    <ScreenHeader
      title="Community"
      subtitle="People who get it, and their extremely photogenic pets."
      showBack={false}
    />
  );

  const listHeader = (
    <View style={{ gap: t.spacing.base, paddingBottom: t.spacing.base }}>
      <GroupRail groups={rail} onOpen={openGroup} />
      <SegmentedControl
        segments={SEGMENTS}
        value={filter}
        onChange={changeFilter}
        accessibilityLabel="Which posts to show"
      />
    </View>
  );

  const renderPost = useCallback(
    ({ item, index }: ListRenderItemInfo<PostWithAuthor>) => (
      <PostCard
        post={item}
        // Only the first screenful staggers. A row that mounts mid-scroll must
        // appear now, not 320ms after your thumb has already moved on.
        index={index < STAGGER_CAP ? index : 0}
        onPress={() => openPost(item.id)}
        onComment={() => openComments(item)}
        onOpenImage={() => openPost(item.id)}
        onOpenGroup={openGroup}
      />
    ),
    [openComments, openGroup, openPost],
  );

  const keyExtractor = useCallback((post: PostWithAuthor) => post.id, []);

  /* ---- states ---------------------------------------------------------- */

  const clearance = { paddingTop: headerHeight + t.spacing.sm };
  // Clears the tab bar *and* the compose button resting above it.
  const bottomClearance = tabBarZone + t.spacing.giant + t.spacing.lg;

  let body: React.ReactNode;

  if (feed.isPending) {
    body = (
      <ScrollView
        scrollEnabled={false}
        contentContainerStyle={[clearance, { paddingHorizontal: t.gutter }]}
      >
        <SkeletonGroup label="Loading the community" gap="base">
          <PostSkeleton count={1} image />
          <PostSkeleton count={1} image={false} />
          <PostSkeleton count={1} image />
        </SkeletonGroup>
      </ScrollView>
    );
  } else if (feed.isError) {
    body = (
      <View style={[styles.center, styles.flex, clearance, { paddingHorizontal: t.gutter }]}>
        <ErrorState
          error={feed.error}
          title="The feed didn’t come through"
          body="Everyone's posts are still there — we just couldn't reach them. Give it another go."
          onRetry={() => feed.refetch()}
        />
      </View>
    );
  } else {
    body = (
      <FeedList<PostWithAuthor>
        ref={listRef}
        data={posts}
        renderItem={renderPost}
        keyExtractor={keyExtractor}
        refreshing={refreshing}
        onRefresh={() => {
          void refresh();
        }}
        scrollY={scrollY}
        indicatorOffset={headerHeight}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={
          <FeedEmpty
            filter={filter}
            groups={groups}
            hasJoined={joinedGroups.length > 0}
            onCompose={openComposer}
            onOpenGroup={openGroup}
            onShowAll={() => changeFilter('all')}
          />
        }
        ListFooterComponent={
          <FeedFooter
            loading={feed.isFetchingNextPage}
            done={!feed.hasNextPage && posts.length > 0}
          />
        }
        onEndReached={loadMore}
        onEndReachedThreshold={0.6}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          clearance,
          {
            paddingHorizontal: t.gutter,
            paddingBottom: bottomClearance,
            gap: t.spacing.base,
          },
        ]}
      />
    );
  }

  return (
    <>
      {body}

      <View style={[styles.header, { zIndex: t.zIndex.header }]} pointerEvents="box-none">
        {header}
      </View>

      <ComposeFab scrollY={scrollY} bottom={tabBarZone + t.spacing.sm} onPress={openComposer} />

      <CommentSheet
        controller={comments}
        postId={commentingOn?.id ?? null}
        subject={commentingOn?.pet?.name ?? commentingOn?.author.displayName ?? 'this post'}
      />
    </>
  );
}

/* ---------------------------------------------------------------- the rail */

function GroupRail({ groups, onOpen }: { groups: Group[]; onOpen: (groupId: ID) => void }) {
  const t = useTheme();
  if (groups.length === 0) return null;

  return (
    <View style={{ gap: t.spacing.sm }}>
      <Text variant="overline" color="textTertiary">
        Groups
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        // Bleeds past the list's gutter so the rail reads as a separate plane.
        style={{ marginHorizontal: -t.gutter }}
        contentContainerStyle={{ gap: t.spacing.sm, paddingHorizontal: t.gutter }}
      >
        {groups.map((group) => (
          <GroupChip
            key={group.id}
            group={group}
            size="md"
            showMembers
            selected={group.joined}
            onPress={() => onOpen(group.id)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

/* -------------------------------------------------------------- empty state */

function FeedEmpty({
  filter,
  groups,
  hasJoined,
  onCompose,
  onOpenGroup,
  onShowAll,
}: {
  filter: FeedFilter;
  groups: Group[];
  hasJoined: boolean;
  onCompose: () => void;
  onOpenGroup: (groupId: ID) => void;
  onShowAll: () => void;
}) {
  const t = useTheme();
  const art = <EmptyFeed size={t.spacing.colossal * 2.4} />;

  if (filter === 'following') {
    return (
      <EmptyState
        illustration={art}
        headline="Your circle is quiet today"
        body="Posts about your pets — and from the people who help look after them — collect here. Yours would be a good place to start."
        action={{ label: 'Share something', icon: 'create-outline', onPress: onCompose }}
        secondaryAction={{ label: 'See everyone', onPress: onShowAll }}
      />
    );
  }

  if (filter === 'groups') {
    if (!hasJoined) {
      return (
        <View style={{ gap: t.spacing.base }}>
          <EmptyState
            variant="compact"
            frame
            illustration={art}
            headline="You haven’t joined a group yet"
            body="Groups are where the specific help lives — the breed quirks, the joint-care evidence, the towpath that's actually dog-friendly."
          />
          {groups.slice(0, SUGGESTION_COUNT).map((group, index) => (
            <GroupCard
              key={group.id}
              group={group}
              index={index}
              onPress={() => onOpenGroup(group.id)}
            />
          ))}
        </View>
      );
    }

    return (
      <EmptyState
        illustration={art}
        headline="Nothing new in your groups"
        body="Everyone's been quiet. Ask the question you've been sitting on — someone in there has almost certainly answered it before."
        action={{ label: 'Start a conversation', icon: 'create-outline', onPress: onCompose }}
        secondaryAction={{ label: 'See everyone', onPress: onShowAll }}
      />
    );
  }

  return (
    <EmptyState
      illustration={art}
      headline="The community’s just getting started"
      body="Nobody's posted yet, which means the first photo of the day is yours to take."
      action={{ label: 'Share something', icon: 'create-outline', onPress: onCompose }}
    />
  );
}

/* ------------------------------------------------------------------ footer */

function FeedFooter({ loading, done }: { loading: boolean; done: boolean }) {
  const t = useTheme();

  if (loading) {
    return (
      <View style={{ paddingTop: t.spacing.xs }}>
        <PostSkeleton count={1} image={false} />
      </View>
    );
  }

  if (!done) return null;

  return (
    <Animated.View
      entering={FadeIn.duration(t.motion.duration.slow)}
      style={[styles.center, { paddingVertical: t.spacing.xl, gap: t.spacing.sm }]}
    >
      <PawPrint size={t.spacing.xxl} color="textFaint" rotation={-12} />
      <Text variant="footnote" color="textTertiary" align="center">
        That’s everything for now. Go and enjoy the actual animal.
      </Text>
    </Animated.View>
  );
}

/* --------------------------------------------------------------------- fab */

/**
 * Retracts on the way down and springs back the instant you reverse. Driven
 * from the list's shared offset, so the whole thing runs on the UI thread.
 */
function ComposeFab({
  scrollY,
  bottom,
  onPress,
}: {
  scrollY: SharedValue<number>;
  /** Distance from the screen edge, measured to clear the floating tab bar. */
  bottom: number;
  onPress: () => void;
}) {
  const t = useTheme();
  const hidden = useSharedValue(0);
  const travel = t.spacing.giant + t.spacing.xxl;

  useAnimatedReaction(
    () => scrollY.value,
    (current, previous) => {
      if (previous === null) return;
      if (current < FAB_ARM_OFFSET) {
        if (hidden.value !== 0) hidden.value = withSpring(0, SETTLE);
        return;
      }
      const delta = current - previous;
      if (delta > SCROLL_NOISE && hidden.value !== 1) hidden.value = withSpring(1, SETTLE);
      else if (delta < -SCROLL_NOISE && hidden.value !== 0) hidden.value = withSpring(0, SETTLE);
    },
  );

  const style = useAnimatedStyle(() => ({
    opacity: 1 - hidden.value,
    transform: t.reduceMotion
      ? []
      : [{ translateY: hidden.value * travel }, { scale: 1 - hidden.value * 0.2 }],
  }));

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.fab,
        { right: t.gutter, bottom, zIndex: t.zIndex.fab },
        style,
      ]}
    >
      <Touchable
        accessibilityRole="button"
        accessibilityLabel="Share something"
        accessibilityHint="Opens the composer."
        haptic="tap"
        onPress={onPress}
        pressScale="small"
        style={[
          styles.center,
          styles.row,
          t.elevation(4),
          t.glow(t.color.primary),
          {
            gap: t.spacing.xs,
            height: t.spacing.huge + t.spacing.xxs,
            paddingHorizontal: t.spacing.lg,
            borderRadius: t.radius.pill,
            backgroundColor: t.color.primary,
          },
        ]}
      >
        <Icon name="create-outline" size="md" color={t.color.onPrimary} />
        <Text variant="button" color="onPrimary">
          Post
        </Text>
      </Touchable>
    </Animated.View>
  );
}

/* ----------------------------------------------------------------- styles */

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  header: { position: 'absolute', top: 0, left: 0, right: 0 },
  fab: { position: 'absolute' },
});
