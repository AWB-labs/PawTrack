/**
 * A group.
 *
 * A group is a *place*, so this reads like arriving somewhere: the group's own
 * colour washes the top of the screen with its paw pressed into it, the two
 * numbers that tell you whether it's alive sit under the name, and joining is a
 * single optimistic pill that fills before the request lands.
 *
 * Two structural notes:
 *
 *   · **The wash is part of the content, not the chrome.** It scrolls away with
 *     everything else and bleeds under the floating bar, whose blur only fades
 *     in once you've actually left it — so the accent gets the top of the
 *     screen rather than a strip beneath a header.
 *   · **The feed here is a real server scope.** `useFeed({ groupId })` is its
 *     own cache entry, so a group's posts page independently of the main feed
 *     and a like in one place is already true in the other.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, StyleSheet, View, type ListRenderItemInfo } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import Svg from 'react-native-svg';

import { useFeed, useGroup } from '@/data/queries/useCommunity';
import type { Group, ID, PostWithAuthor } from '@/data/types';
import { CommentSheet } from '@/features/community/CommentSheet';
import { GroupJoinButton } from '@/features/community/GroupCard';
import { groupTint, GROUP_KIND_META, membersLabel } from '@/features/community/GroupChip';
import { PostCard } from '@/features/community/PostCard';
import { toHref } from '@/lib/deeplinks';
import { formatCount, pluralWord } from '@/lib/format';
import { useTheme } from '@/theme';
import {
  EmptyState,
  ErrorState,
  Icon,
  PawGlyph,
  PAW_VIEWBOX,
  RefreshableFlatList,
  Screen,
  ScreenHeader,
  SkeletonGroup,
  Text,
  Touchable,
  useScreenScroll,
  useSheet,
  type RefreshableFlatListProps,
} from '@/ui';
import { EmptyFeed } from '@/ui/illustrations';
import { PostSkeleton } from '@/ui/skeletons/ContentSkeletons';

/* ---------------------------------------------------------------- constants */

/** Entrance stagger cap — past this the list reads as slow rather than lively. */
const STAGGER_CAP = 8;

/** Wash strength at the top of the hero and where it fades out. */
const WASH_TOP = 0.42;
const WASH_BOTTOM = 0;

/** Watermark paw, as a fraction of the hero's height. */
const WATERMARK_RATIO = 0.95;
const WATERMARK_OPACITY = 0.18;

const GRADIENT_START = { x: 0.15, y: 0 } as const;
const GRADIENT_END = { x: 0.85, y: 1 } as const;

/**
 * See `app/(tabs)/community.tsx` — `RefreshableFlatList` forwards unknown props
 * to the `Animated.FlatList` beneath it, so a ref reaches the real list even
 * though Reanimated's prop type never declares one.
 */
const GroupFeedList = RefreshableFlatList as <ItemT>(
  props: RefreshableFlatListProps<ItemT> & { ref?: React.Ref<FlatList<ItemT>> },
) => React.ReactElement;

/* ---------------------------------------------------------------- component */

export default function GroupScreen() {
  return (
    <Screen padded={false} edges={[]} keyboardAvoiding={false}>
      <GroupPage />
    </Screen>
  );
}

function GroupPage() {
  const t = useTheme();
  const router = useRouter();
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const { scrollY, headerHeight } = useScreenScroll();

  const groupQuery = useGroup(groupId);
  const group = groupQuery.data ?? null;
  const feed = useFeed({ groupId });

  const [refreshing, setRefreshing] = useState(false);
  const [commentingOn, setCommentingOn] = useState<PostWithAuthor | null>(null);
  const comments = useSheet();

  const posts = useMemo(() => feed.data ?? [], [feed.data]);

  const loadMore = useCallback(() => {
    if (feed.hasNextPage && !feed.isFetchingNextPage) void feed.fetchNextPage();
  }, [feed]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([feed.refetch(), groupQuery.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }, [feed, groupQuery]);

  const openPost = useCallback(
    (postId: ID) => router.push(toHref(`/community/post/${postId}`)),
    [router],
  );

  const compose = useCallback(() => {
    if (!group) return;
    router.push(toHref(`/community/new?groupId=${group.id}`));
  }, [group, router]);

  const openComments = useCallback(
    (post: PostWithAuthor) => {
      setCommentingOn(post);
      comments.open();
    },
    [comments],
  );

  const renderPost = useCallback(
    ({ item, index }: ListRenderItemInfo<PostWithAuthor>) => (
      <PostCard
        post={item}
        // Only the first screenful staggers — a row mounting mid-scroll should
        // arrive immediately, not a third of a second late.
        index={index < STAGGER_CAP ? index : 0}
        // The chip would only repeat the header we're standing in.
        showGroup={false}
        onPress={() => openPost(item.id)}
        onComment={() => openComments(item)}
        onOpenImage={() => openPost(item.id)}
      />
    ),
    [openComments, openPost],
  );

  const keyExtractor = useCallback((post: PostWithAuthor) => post.id, []);

  const header = (
    <ScreenHeader title={group?.name ?? 'Group'} large={false} chrome />
  );

  const clearance = { paddingTop: headerHeight };

  /* ---- states ---------------------------------------------------------- */

  let body: React.ReactNode;

  if (groupQuery.isError) {
    body = (
      <View style={[styles.flex, styles.center, clearance, { paddingHorizontal: t.gutter }]}>
        <ErrorState
          error={groupQuery.error}
          title="That group wouldn’t open"
          body="The group is fine — the connection wasn't. Try again and it should come straight up."
          onRetry={() => groupQuery.refetch()}
        />
      </View>
    );
  } else if (!group) {
    body = (
      <View style={[clearance, { paddingHorizontal: t.gutter }]}>
        <SkeletonGroup label="Opening the group" gap="lg">
          <PostSkeleton count={1} image={false} />
          <PostSkeleton count={1} image />
        </SkeletonGroup>
      </View>
    );
  } else {
    body = (
      <GroupFeedList<PostWithAuthor>
        data={posts}
        renderItem={renderPost}
        keyExtractor={keyExtractor}
        refreshing={refreshing}
        onRefresh={() => {
          void refresh();
        }}
        scrollY={scrollY}
        indicatorOffset={headerHeight}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={<GroupHero group={group} onCompose={compose} />}
        ListEmptyComponent={
          feed.isPending ? (
            <SkeletonGroup label="Loading this group’s posts" gap="base">
              <PostSkeleton count={1} image />
              <PostSkeleton count={1} image={false} />
            </SkeletonGroup>
          ) : feed.isError ? (
            <ErrorState
              variant="compact"
              frame
              error={feed.error}
              title="These posts didn’t load"
              onRetry={() => feed.refetch()}
            />
          ) : (
            <EmptyState
              illustration={<EmptyFeed size={t.spacing.colossal * 2.2} />}
              headline={`${group.name} is quiet today`}
              body="Nobody's posted here yet. Ask the thing you came to ask — this is exactly the room for it."
              action={{ label: 'Start it off', icon: 'create-outline', onPress: compose }}
            />
          )
        }
        ListFooterComponent={
          feed.isFetchingNextPage ? (
            <View style={{ paddingTop: t.spacing.xs }}>
              <PostSkeleton count={1} image={false} />
            </View>
          ) : null
        }
        onEndReached={loadMore}
        onEndReachedThreshold={0.6}
        // Posts keep the gutter; the hero cancels it out to bleed edge to edge.
        contentContainerStyle={{
          paddingHorizontal: t.gutter,
          paddingBottom: t.spacing.giant,
          gap: t.spacing.base,
        }}
      />
    );
  }

  return (
    <>
      {body}

      <View style={[styles.header, { zIndex: t.zIndex.header }]} pointerEvents="box-none">
        {header}
      </View>

      <CommentSheet
        controller={comments}
        postId={commentingOn?.id ?? null}
        subject={commentingOn?.pet?.name ?? commentingOn?.author.displayName ?? 'this post'}
      />
    </>
  );
}

/* ---------------------------------------------------------------------- hero */

function GroupHero({ group, onCompose }: { group: Group; onCompose: () => void }) {
  const t = useTheme();
  const { topInset } = useScreenScroll();
  const kind = GROUP_KIND_META[group.kind];

  const heroHeight = t.spacing.colossal * 2;
  const watermark = heroHeight * WATERMARK_RATIO;
  const wash: readonly [string, string] = [
    groupTint(group.accent, WASH_TOP),
    groupTint(group.accent, WASH_BOTTOM),
  ];

  const enter = t.reduceMotion
    ? FadeIn.duration(t.motion.duration.base)
    : FadeInDown.duration(t.motion.duration.slow).easing(t.motion.easing.decelerate);

  return (
    <View style={{ marginHorizontal: -t.gutter, paddingBottom: t.spacing.xs }}>
      <View style={{ height: heroHeight + topInset }}>
        <LinearGradient
          colors={wash}
          start={GRADIENT_START}
          end={GRADIENT_END}
          style={StyleSheet.absoluteFill}
        />
        {/* Bled off the right edge so it reads as a stamp, not a centred logo. */}
        <View
          style={[styles.watermark, { right: -watermark * 0.2 }]}
          pointerEvents="none"
        >
          <Svg width={watermark} height={watermark} viewBox={`0 0 ${PAW_VIEWBOX} ${PAW_VIEWBOX}`}>
            <PawGlyph
              size={PAW_VIEWBOX}
              color={group.accent}
              opacity={WATERMARK_OPACITY}
              rotation={-16}
            />
          </Svg>
        </View>
      </View>

      <Animated.View
        entering={enter}
        style={[
          t.elevation(2),
          {
            marginTop: -t.spacing.xxl,
            marginHorizontal: t.gutter,
            padding: t.spacing.base,
            borderRadius: t.radius.xxl,
            backgroundColor: t.color.surface,
            borderWidth: t.borderWidth.hairline,
            borderColor: t.color.border,
            gap: t.spacing.md,
          },
        ]}
      >
        <View style={{ gap: t.spacing.xs }}>
          <View style={[styles.row, { gap: t.spacing.xxs }]}>
            <Icon name={kind.icon} size="xs" color="textTertiary" />
            <Text variant="overline" color="textTertiary">
              {kind.label}
            </Text>
          </View>

          <Text variant="title1" numberOfLines={2} accessibilityRole="header">
            {group.name}
          </Text>

          <Text variant="footnote" color="textTertiary">
            {`${membersLabel(group.memberCount)} · ${formatCount(group.postCount)} ${pluralWord(
              group.postCount,
              'post',
            )}`}
          </Text>
        </View>

        <Text variant="callout" color="textSecondary">
          {group.description}
        </Text>

        <View style={[styles.row, { gap: t.spacing.sm }]}>
          <View style={styles.grow}>
            <GroupJoinButton group={group} fullWidth />
          </View>
        </View>

        {group.joined ? (
          <Animated.View entering={FadeIn.duration(t.motion.duration.base)}>
            <Text variant="caption" color="textTertiary" align="center">
              {`You're in. ${group.name} posts now show under “My groups”.`}
            </Text>
          </Animated.View>
        ) : null}
      </Animated.View>

      <View style={{ paddingHorizontal: t.gutter, paddingTop: t.spacing.lg }}>
        <Text variant="overline" color="textTertiary">
          Latest
        </Text>
      </View>

      <View style={{ paddingHorizontal: t.gutter, paddingTop: t.spacing.sm }}>
        <StartSomething onPress={onCompose} name={group.name} />
      </View>
    </View>
  );
}

/** A quiet prompt at the top of the group's own feed. */
function StartSomething({ onPress, name }: { onPress: () => void; name: string }) {
  const t = useTheme();

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={`Post in ${name}`}
      accessibilityHint="Opens the composer with this group already chosen."
      haptic="tap"
      onPress={onPress}
      pressScale="large"
      style={[
        styles.row,
        {
          gap: t.spacing.sm,
          padding: t.spacing.md,
          borderRadius: t.radius.xl,
          borderWidth: t.borderWidth.thin,
          borderColor: t.color.border,
          borderStyle: 'dashed',
        },
      ]}
    >
      <Icon name="create-outline" size="sm" color="primaryText" />
      <Text variant="footnote" color="textTertiary" numberOfLines={1} style={styles.grow}>
        {`Say something in ${name}…`}
      </Text>
      <Icon name="chevron-forward" size="xs" color="textFaint" />
    </Touchable>
  );
}

/* ----------------------------------------------------------------- styles */

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  grow: { flex: 1 },
  header: { position: 'absolute', top: 0, left: 0, right: 0 },
  watermark: { position: 'absolute', top: 0, bottom: 0, justifyContent: 'center' },
});
