/**
 * Post detail.
 *
 * Three things make this screen feel like it *grew* out of the feed rather than
 * replacing it:
 *
 *   · **It opens on content, never on a spinner.** `usePost` seeds itself from
 *     whichever feed page already holds this row, so the card is on screen in
 *     the first frame and the fetch only ever fills in what changed.
 *   · **The entrance is a shared-element impression, not a slide.** The card
 *     settles up and scales the last 3% into place, which is what the eye reads
 *     when a tapped row becomes a page. No native shared-element transition
 *     exists in Expo Go, and this costs one shared value.
 *   · **Comments are the page, not a drawer.** Same thread component the sheet
 *     uses, with the input bar pinned to the bottom and riding the keyboard on
 *     its own shared value — `Screen`'s footer sits outside the keyboard
 *     avoider by design, so a bar that must stay above the keys handles it
 *     itself.
 *
 * The photo viewer is a native modal with its own gesture root (gesture-handler
 * doesn't reach into an RN `Modal` window). Pinch to zoom, drag to pan when
 * zoomed, drag down to dismiss when not, and drag sideways to move between the
 * post's photos.
 */

import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type WithSpringConfig,
} from 'react-native-reanimated';
import { runOnJS } from 'react-native-worklets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useDeletePost, usePost } from '@/data/queries/useCommunity';
import {
  CommentBar,
  CommentList,
  KeyboardSpacer,
  useCommentThread,
} from '@/features/community/CommentSheet';
import { PostCard } from '@/features/community/PostCard';
import { toHref } from '@/lib/deeplinks';
import { formatCount, possessive } from '@/lib/format';
import haptics from '@/lib/haptics';
import { useCurrentUser } from '@/stores/session';
import { spring, useTheme, type Theme } from '@/theme';
import {
  ConfirmSheet,
  Divider,
  EmptyState,
  ErrorState,
  IconButton,
  Screen,
  ScreenHeader,
  SectionHeader,
  Text,
  toast,
  useScreenScroll,
  useSheet,
  type TextAreaHandle,
} from '@/ui';
import { ErrorNotFound } from '@/ui/illustrations';
import { ListRowSkeleton, PostSkeleton } from '@/ui/skeletons/ContentSkeletons';
import { SkeletonGroup } from '@/ui/Skeleton';

/* ---------------------------------------------------------------- constants */

/** See `@/ui/Touchable` — the theme's `springWith` helper doesn't type-check yet. */
const SETTLE: WithSpringConfig = { ...spring.snappy, reduceMotion: ReduceMotion.System };

/** How far a photo can be magnified before it's just pixels. */
const MAX_ZOOM = 4;

/** Fraction of the screen a flick must cross to change photo or dismiss. */
const SWIPE_RATIO = 0.22;
const DISMISS_RATIO = 0.18;

/** Points-per-second past which a flick counts regardless of distance. */
const FLING_VELOCITY = 900;

/** Two scrims stacked: a photo viewer needs a deeper ground than one token gives. */
const SCRIM_LAYERS = 2;

/* ------------------------------------------------------------------ helpers */

/** Ink that stays legible over a photo in both schemes. */
function inkOverPhoto(t: Theme): string {
  return t.scheme === 'dark' ? t.color.text : t.color.textInverse;
}

/* ---------------------------------------------------------------- component */

export default function PostDetailScreen() {
  return (
    <Screen padded={false} edges={[]} keyboardAvoiding={false}>
      <PostDetail />
    </Screen>
  );
}

function PostDetail() {
  const t = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const me = useCurrentUser();
  const { postId } = useLocalSearchParams<{ postId: string }>();
  // `onScroll` feeds the Screen's shared offset, which is what the floating
  // header's collapse is driven from — no re-render while you flick.
  const { onScroll, headerHeight } = useScreenScroll();

  const postQuery = usePost(postId);
  const post = postQuery.data ?? null;
  const remove = useDeletePost();
  const thread = useCommentThread(postId);
  const confirmDelete = useSheet();

  const inputRef = useRef<TextAreaHandle | null>(null);
  const [barHeight, setBarHeight] = useState(0);
  const [viewing, setViewing] = useState<number | null>(null);

  const subject = post?.pet?.name ?? post?.author.displayName ?? 'this post';
  const mine = me !== null && post !== null && post.authorId === me.id;

  /* ---- entrance -------------------------------------------------------- */

  const reveal = useSharedValue(0);
  useEffect(() => {
    reveal.value = withTiming(1, t.motion.timing(t.motion.duration.page, 'decelerate'));
  }, [reveal, t.motion]);

  const lift = t.spacing.lg;
  const revealStyle = useAnimatedStyle(() => ({
    opacity: reveal.value,
    transform: t.reduceMotion
      ? []
      : [
          { translateY: (1 - reveal.value) * lift },
          // The last 3% of scale is what reads as "this row became a page".
          { scale: 0.97 + reveal.value * 0.03 },
        ],
  }));

  /* ---- actions --------------------------------------------------------- */

  const onBarLayout = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    setBarHeight((prev) => (Math.abs(prev - height) < 1 ? prev : height));
  }, []);

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace(toHref('/community'));
  }, [router]);

  const deletePost = useCallback(() => {
    if (!post) return;
    haptics.commit();
    remove.mutate(post.id);
    toast.success('Taken down', { description: 'It’s out of the feed and the comments went with it.' });
    goBack();
  }, [goBack, post, remove]);

  const openGroup = useCallback(
    (groupId: string) => router.push(toHref(`/community/group/${groupId}`)),
    [router],
  );

  /* ---- chrome ---------------------------------------------------------- */

  const header = (
    <ScreenHeader
      title={post ? `${possessive(subject)} post` : 'Post'}
      large={false}
      actions={
        mine ? (
          <IconButton
            icon="trash-outline"
            accessibilityLabel="Take this post down"
            accessibilityHint="Removes it and its comments for everyone."
            variant="ghost"
            tone="danger"
            onPress={() => confirmDelete.open()}
          />
        ) : undefined
      }
    />
  );

  const clearance = { paddingTop: headerHeight + t.spacing.sm };

  /* ---- states ---------------------------------------------------------- */

  let body: React.ReactNode;

  if (postQuery.isPending) {
    body = (
      <View style={[clearance, { paddingHorizontal: t.gutter }]}>
        <SkeletonGroup label="Opening the post" gap="lg">
          <PostSkeleton count={1} image />
          <ListRowSkeleton count={3} avatar />
        </SkeletonGroup>
      </View>
    );
  } else if (postQuery.isError) {
    body = (
      <View style={[styles.flex, styles.center, clearance, { paddingHorizontal: t.gutter }]}>
        <ErrorState
          error={postQuery.error}
          title="We couldn’t open that post"
          body="It's still out there — the connection just gave up halfway. One more try?"
          onRetry={() => postQuery.refetch()}
        />
      </View>
    );
  } else if (!post) {
    body = (
      <View style={[styles.flex, styles.center, clearance, { paddingHorizontal: t.gutter }]}>
        <EmptyState
          illustration={<ErrorNotFound size={t.spacing.colossal * 2.4} />}
          headline="That post has gone"
          body="Whoever wrote it has taken it down. The rest of the community is still here."
          action={{ label: 'Back to the feed', icon: 'arrow-back', onPress: goBack }}
        />
      </View>
    );
  } else {
    body = (
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        showsVerticalScrollIndicator={false}
        scrollIndicatorInsets={{ top: headerHeight }}
        contentContainerStyle={[
          clearance,
          {
            paddingHorizontal: t.gutter,
            paddingBottom: barHeight + t.spacing.lg,
            gap: t.spacing.lg,
          },
        ]}
      >
        <Animated.View style={revealStyle}>
          <PostCard
            post={post}
            expanded
            showGroup
            onComment={() => inputRef.current?.focus()}
            onOpenImage={(imageIndex) => setViewing(imageIndex)}
            onOpenGroup={openGroup}
          />
        </Animated.View>

        <Divider spacing={0} />

        <View style={{ gap: t.spacing.md }}>
          <SectionHeader
            first
            title={
              thread.count === 0
                ? 'Comments'
                : `${formatCount(thread.count)} ${thread.count === 1 ? 'comment' : 'comments'}`
            }
            subtitle={
              thread.count === 0
                ? undefined
                : `What people said back to ${possessive(subject)} post.`
            }
          />
          <CommentList
            thread={thread}
            subject={subject}
            ground={t.color.bg}
            onWriteFirst={() => inputRef.current?.focus()}
          />
        </View>

        {/* Keeps the last comment clear of the keyboard without an avoiding view. */}
        <KeyboardSpacer inset={insets.bottom} />
      </Animated.ScrollView>
    );
  }

  return (
    <>
      {body}

      <View style={[styles.header, { zIndex: t.zIndex.header }]} pointerEvents="box-none">
        {header}
      </View>

      {post ? (
        <View
          onLayout={onBarLayout}
          style={[styles.bar, { zIndex: t.zIndex.sticky }]}
          pointerEvents="box-none"
        >
          <CommentBar thread={thread} subject={subject} lift safeArea inputRef={inputRef} />
        </View>
      ) : null}

      {post && viewing !== null ? (
        <PhotoViewer
          uris={post.imageUrls}
          startAt={viewing}
          subject={subject}
          onClose={() => setViewing(null)}
        />
      ) : null}

      <ConfirmSheet
        controller={confirmDelete}
        title="Take this post down?"
        body="It disappears for everyone, and the conversation underneath goes with it. This can’t be undone."
        confirmLabel="Take it down"
        cancelLabel="Leave it up"
        icon="trash-outline"
        onConfirm={deletePost}
      />
    </>
  );
}

/* ------------------------------------------------------------ photo viewer */

function PhotoViewer({
  uris,
  startAt,
  subject,
  onClose,
}: {
  uris: string[];
  startAt: number;
  subject: string;
  onClose: () => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [index, setIndex] = useState(Math.min(Math.max(0, startAt), Math.max(0, uris.length - 1)));

  const scale = useSharedValue(1);
  const saved = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);

  const uri = uris[index] ?? '';
  const swipeAt = width * SWIPE_RATIO;
  const dismissAt = height * DISMISS_RATIO;

  const reset = useCallback(() => {
    scale.value = withSpring(1, SETTLE);
    saved.value = 1;
    x.value = withSpring(0, SETTLE);
    y.value = withSpring(0, SETTLE);
    savedX.value = 0;
    savedY.value = 0;
  }, [saved, savedX, savedY, scale, x, y]);

  const step = useCallback(
    (direction: number) => {
      haptics.select();
      setIndex((current) => Math.min(uris.length - 1, Math.max(0, current + direction)));
      reset();
    },
    [reset, uris.length],
  );

  const pinch = useMemo(
    () =>
      Gesture.Pinch()
        .onUpdate((event) => {
          scale.value = Math.min(MAX_ZOOM, Math.max(0.6, saved.value * event.scale));
        })
        .onEnd(() => {
          if (scale.value <= 1) {
            scale.value = withSpring(1, SETTLE);
            saved.value = 1;
            x.value = withSpring(0, SETTLE);
            y.value = withSpring(0, SETTLE);
            savedX.value = 0;
            savedY.value = 0;
            return;
          }
          saved.value = scale.value;
        }),
    [saved, savedX, savedY, scale, x, y],
  );

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .onUpdate((event) => {
          x.value = savedX.value + event.translationX;
          y.value = savedY.value + event.translationY;
        })
        .onEnd((event) => {
          // Zoomed in, the drag is panning the photo — keep where it landed.
          if (scale.value > 1) {
            savedX.value = x.value;
            savedY.value = y.value;
            return;
          }

          const flungDown = Math.abs(event.velocityY) > FLING_VELOCITY;
          if (Math.abs(y.value) > dismissAt || (flungDown && Math.abs(y.value) > Math.abs(x.value))) {
            runOnJS(onClose)();
            return;
          }

          const flungSide = Math.abs(event.velocityX) > FLING_VELOCITY;
          if (Math.abs(x.value) > swipeAt || (flungSide && Math.abs(x.value) > Math.abs(y.value))) {
            const direction = x.value < 0 ? 1 : -1;
            runOnJS(step)(direction);
            return;
          }

          x.value = withSpring(0, SETTLE);
          y.value = withSpring(0, SETTLE);
        }),
    [dismissAt, onClose, savedX, savedY, scale, step, swipeAt, x, y],
  );

  const doubleTap = useMemo(
    () =>
      Gesture.Tap()
        .numberOfTaps(2)
        .onEnd((_event, success) => {
          if (!success) return;
          const zoomed = scale.value > 1;
          scale.value = withSpring(zoomed ? 1 : MAX_ZOOM / 2, SETTLE);
          saved.value = zoomed ? 1 : MAX_ZOOM / 2;
          if (zoomed) {
            x.value = withSpring(0, SETTLE);
            y.value = withSpring(0, SETTLE);
            savedX.value = 0;
            savedY.value = 0;
          }
        }),
    [saved, savedX, savedY, scale, x, y],
  );

  const gesture = useMemo(
    () => Gesture.Race(Gesture.Simultaneous(pinch, pan), doubleTap),
    [doubleTap, pan, pinch],
  );

  const photoStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }],
  }));

  /** The ground thins out as you drag the photo away — the dismissal previews itself. */
  const groundStyle = useAnimatedStyle(() => ({
    opacity: scale.value > 1 ? 1 : Math.max(0.2, 1 - Math.abs(y.value) / (dismissAt * 3)),
  }));

  const ink = inkOverPhoto(t);
  const counter = uris.length > 1 ? `${index + 1} of ${uris.length}` : null;

  return (
    <Modal visible transparent statusBarTranslucent animationType="fade" onRequestClose={onClose}>
      {/* An RN Modal is its own native window and gesture-handler doesn't reach
          into one — the viewer needs a root of its own. */}
      <GestureHandlerRootView style={styles.flex}>
        <Animated.View style={[StyleSheet.absoluteFill, groundStyle]}>
          {Array.from({ length: SCRIM_LAYERS }, (_, layer) => (
            <View
              key={layer}
              style={[StyleSheet.absoluteFill, { backgroundColor: t.color.scrim }]}
            />
          ))}
        </Animated.View>

        <GestureDetector gesture={gesture}>
          <Animated.View style={[styles.flex, styles.center]}>
            <Animated.View style={[{ width, height: height * 0.8 }, photoStyle]}>
              <Image
                source={{ uri }}
                style={StyleSheet.absoluteFill}
                contentFit="contain"
                cachePolicy="memory-disk"
                transition={t.motion.duration.base}
                recyclingKey={uri}
                accessible
                accessibilityLabel={
                  counter ? `${counter}. Photo of ${subject}.` : `Photo of ${subject}`
                }
              />
            </Animated.View>
          </Animated.View>
        </GestureDetector>

        <View
          style={[
            styles.viewerBar,
            { paddingTop: insets.top + t.spacing.sm, paddingHorizontal: t.gutter },
          ]}
          pointerEvents="box-none"
        >
          <IconButton
            icon="close"
            accessibilityLabel="Close the photo"
            accessibilityHint="Returns to the post."
            variant="glass"
            tone="neutral"
            onPress={onClose}
          />
          {counter ? (
            <Text variant="subheadStrong" color={ink} tabular>
              {counter}
            </Text>
          ) : null}
          {/* Balances the counter so it sits dead centre. */}
          <View style={{ width: t.minTarget }} />
        </View>

        <View
          style={[
            styles.viewerHint,
            { paddingBottom: insets.bottom + t.spacing.lg, paddingHorizontal: t.gutter },
          ]}
          pointerEvents="none"
        >
          <Text variant="caption" color={ink} align="center">
            {uris.length > 1
              ? 'Pinch to zoom · swipe across for the next one · drag down to close'
              : 'Pinch to zoom · drag down to close'}
          </Text>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

/* ----------------------------------------------------------------- styles */

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  header: { position: 'absolute', top: 0, left: 0, right: 0 },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  viewerBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  viewerHint: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});
