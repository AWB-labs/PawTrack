/**
 * Petal — PostCard.
 *
 * The unit the whole community screen is made of, and the place where "feels
 * alive" is either won or lost. Four things it takes seriously:
 *
 *   · **Dual attribution.** A post can be written *as* a pet by a person who
 *     may not even own it. So the card shows the pet as the subject, the human
 *     underneath, and — when a sitter wrote it — says so warmly rather than
 *     hiding it. Two avatars, one clipped to the other's corner, is the whole
 *     story in 48pt.
 *   · **Photos arrive, they don't pop.** Every tile holds a skeleton-coloured
 *     bed at the exact aspect ratio it will occupy, and the image fades and
 *     settles over it. Nothing reflows, and a slow connection degrades to a
 *     calm grey card rather than a jumping list.
 *   · **The like is the reward.** Scale burst, a ring of hearts thrown outward,
 *     a haptic, and a count that has already moved — all before the request
 *     leaves the device, because `useToggleLike` patches every cached copy of
 *     the post on mutate. Double-tapping a photo does the same and floats a
 *     heart up off the picture.
 *   · **Long posts fold, they don't clip.** The fold is decided from the text
 *     itself rather than from a measure pass: measuring inside a virtualised
 *     list costs a second layout on every row, and a fold that flickers is
 *     worse than one that is occasionally a line out.
 */

import { Image } from 'expo-image';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  FadeIn,
  FadeInDown,
  interpolate,
  interpolateColor,
  LinearTransition,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
  type WithSpringConfig,
} from 'react-native-reanimated';
import { runOnJS } from 'react-native-worklets';

import { useToggleLike } from '@/data/queries/useCommunity';
import type { ID, PostWithAuthor } from '@/data/types';
import { relativeTime } from '@/lib/date';
import { buildPostUrl } from '@/lib/deeplinks';
import { formatCount, pluralWord, truncate } from '@/lib/format';
import haptics from '@/lib/haptics';
import { shareText } from '@/lib/share';
import { spring, useTheme, type Theme } from '@/theme';
import { Avatar, Badge, Icon, Text, Touchable, type IconName } from '@/ui';
import { GroupChip } from './GroupChip';

/* -------------------------------------------------------------------- types */

export type PostCardProps = {
  post: PostWithAuthor;
  /** Position in the list, for the entrance stagger. The caller caps it. */
  index?: number;
  /** Detail view: the body is never folded and the media opens a viewer. */
  expanded?: boolean;
  onPress?: () => void;
  onComment?: () => void;
  /** Given the index of the photo that was tapped. */
  onOpenImage?: (imageIndex: number) => void;
  onOpenGroup?: (groupId: ID) => void;
  /** Off inside a group's own feed, where the chip only repeats the header. */
  showGroup?: boolean;
  /** The composer's live preview: everything renders, nothing responds. */
  preview?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

type TileGeometry = { style: StyleProp<ViewStyle>; badge: string | null };

/* ---------------------------------------------------------------- constants */

/** See `@/ui/Touchable` — the theme's `springWith` helper doesn't type-check yet. */
const POP_IN: WithSpringConfig = { ...spring.bouncy, reduceMotion: ReduceMotion.System };
const POP_OUT: WithSpringConfig = { ...spring.gentle, reduceMotion: ReduceMotion.System };
const FILL_SPRING: WithSpringConfig = { ...spring.snappy, reduceMotion: ReduceMotion.System };

/** Lines shown before the fold, and the length that triggers one. */
const COLLAPSED_LINES = 6;
const FOLD_AT_CHARS = 230;

/** Entrance stagger cap — past this the list reads as slow rather than lively. */
const STAGGER_CAP = 8;

/** Hearts thrown by the like burst. Six reads as a bloom; ten as a firework. */
const BURST_HEARTS = 6;

/** Overshoot the heart takes on a like, as a fraction of its size. */
const HEART_POP = 0.42;

/** Photos beyond this get folded into the last tile's "+N". */
const MAX_TILES = 4;

/** Single photo, matching `PostSkeleton`'s reserve exactly. */
const SOLO_ASPECT = 16 / 10;
const PAIR_ASPECT = 2;
const TRIO_ASPECT = 3 / 2;

/* ------------------------------------------------------------------ helpers */

/** Roughly how many lines this body will occupy on a phone at `callout`. */
function foldsOver(body: string): boolean {
  if (body.length > FOLD_AT_CHARS) return true;
  let breaks = 0;
  for (const ch of body) if (ch === '\n') breaks += 1;
  return breaks >= COLLAPSED_LINES;
}

/**
 * Ink that stays legible on a photo in both schemes. `textInverse` flips with
 * the scheme, so on a dark ground we want the scheme's *own* light ink — one of
 * the few places the contract's "read `scheme` when a value must genuinely
 * differ" applies.
 */
function inkOverPhoto(t: Theme): string {
  return t.scheme === 'dark' ? t.color.text : t.color.textInverse;
}

/* ---------------------------------------------------------------- component */

export function PostCard({
  post,
  index = 0,
  expanded = false,
  onPress,
  onComment,
  onOpenImage,
  onOpenGroup,
  showGroup = true,
  preview = false,
  style,
  testID,
}: PostCardProps) {
  const t = useTheme();
  const toggle = useToggleLike();
  const [unfolded, setUnfolded] = useState(false);

  const interactive = !preview;
  const foldable = !expanded && !preview && foldsOver(post.body);
  const folded = foldable && !unfolded;

  const pet = post.pet;
  const author = post.author;
  const when = relativeTime(post.createdAt);

  const title = pet ? pet.name : author.displayName;
  const byline = pet ? `${author.displayName} · ${when}` : when;

  /* ---- attribution copy, spoken in full ------------------------------- */

  const attribution = useMemo(() => {
    if (!pet) return `${author.displayName}, ${when}.`;
    return post.postedWhileSitting
      ? `${pet.name}, posted by ${author.displayName} while sitting, ${when}.`
      : `${pet.name}, posted by ${author.displayName}, ${when}.`;
  }, [author.displayName, pet, post.postedWhileSitting, when]);

  /* ---- like ----------------------------------------------------------- */

  const setLiked = useCallback(
    (next: boolean) => {
      if (!interactive) return;
      if (next) haptics.commit();
      else haptics.tap();
      toggle.mutate({ postId: post.id, liked: next });
    },
    [interactive, post.id, toggle],
  );

  const onLikePress = useCallback(() => setLiked(!post.likedByMe), [post.likedByMe, setLiked]);

  /** A double tap only ever adds a heart. Taking one away by accident stings. */
  const onDoubleTapLike = useCallback(() => {
    if (post.likedByMe) return;
    setLiked(true);
  }, [post.likedByMe, setLiked]);

  /* ---- share ---------------------------------------------------------- */

  const onShare = useCallback(() => {
    const headline = pet ? `${pet.name} on Furry Tracker` : `${author.displayName} on Furry Tracker`;
    const body = post.body.trim();
    const message = body ? `${headline}\n\n${truncate(body, 180)}` : headline;
    void shareText(message, buildPostUrl(post.id));
  }, [author.displayName, pet, post.body, post.id]);

  /* ---- entrance ------------------------------------------------------- */

  const delay = Math.min(index, STAGGER_CAP) * t.motion.stagger.base;
  const entering = t.reduceMotion
    ? FadeIn.duration(t.motion.duration.base).delay(delay)
    : FadeInDown.duration(t.motion.duration.slow).delay(delay).easing(t.motion.easing.decelerate);

  const openPost = interactive ? onPress : undefined;

  return (
    <Animated.View
      entering={entering}
      layout={t.reduceMotion ? undefined : LinearTransition.duration(t.motion.duration.base)}
      testID={testID}
      style={[
        t.elevation(1),
        {
          backgroundColor: t.color.surface,
          borderRadius: t.radius.xl,
          padding: t.spacing.base,
          gap: t.spacing.md,
        },
        style,
      ]}
    >
      {/* ------------------------------------------------------ attribution */}

      <View style={[styles.row, { gap: t.spacing.sm }]}>
        <View
          style={styles.cluster}
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
        >
          {pet ? (
            <>
              <Avatar uri={pet.photoUrl} name={pet.name} species={pet.species} size="md" ring />
              <View
                style={[
                  styles.byAvatar,
                  {
                    borderRadius: t.radius.pill,
                    borderWidth: t.borderWidth.thick,
                    borderColor: t.color.surface,
                  },
                ]}
              >
                <Avatar uri={author.avatarUrl} name={author.displayName} size={t.spacing.lg} />
              </View>
            </>
          ) : (
            <Avatar uri={author.avatarUrl} name={author.displayName} size="md" />
          )}
        </View>

        <Tappable
          onPress={openPost}
          accessibilityLabel={attribution}
          accessibilityHint={interactive ? 'Opens the full post.' : undefined}
          style={styles.grow}
        >
          <Text variant="bodyStrong" numberOfLines={1}>
            {title}
          </Text>
          <View style={[styles.row, { gap: t.spacing.xs, marginTop: t.spacing.hair }]}>
            <Text variant="caption" color="textTertiary" numberOfLines={1} style={styles.shrink}>
              {byline}
            </Text>
            {post.postedWhileSitting ? (
              <Badge label="Sitting" tone="accent" size="sm" accessibilityLabel="Posted while sitting" />
            ) : null}
          </View>
        </Tappable>

        {showGroup && post.group ? (
          <View style={styles.groupSlot}>
            <GroupChip
              group={post.group}
              onPress={
                interactive && onOpenGroup && post.group
                  ? () => onOpenGroup(post.group?.id ?? '')
                  : undefined
              }
            />
          </View>
        ) : null}
      </View>

      {/* ------------------------------------------------------------- body */}

      {post.body.trim().length > 0 ? (
        <View style={{ gap: t.spacing.xxs }}>
          <Tappable
            onPress={openPost}
            accessibilityLabel={post.body}
            accessibilityHint={interactive ? 'Opens the full post.' : undefined}
          >
            <Text variant="callout" numberOfLines={folded ? COLLAPSED_LINES : undefined}>
              {post.body}
            </Text>
          </Tappable>

          {folded ? (
            <Touchable
              accessibilityRole="button"
              accessibilityLabel="Read the rest"
              accessibilityHint="Shows the whole post without leaving the feed."
              haptic="tap"
              onPress={() => setUnfolded(true)}
              pressScale="small"
              style={styles.hug}
            >
              <Text variant="subheadStrong" color="primaryText">
                Read more
              </Text>
            </Touchable>
          ) : null}
        </View>
      ) : null}

      {/* ------------------------------------------------------------ media */}

      {post.imageUrls.length > 0 ? (
        <MediaGrid
          uris={post.imageUrls}
          subject={title}
          interactive={interactive}
          onOpen={onOpenImage}
          onDoubleTap={onDoubleTapLike}
        />
      ) : null}

      {/* ---------------------------------------------------------- actions */}

      <View style={[styles.row, { gap: t.spacing.xl, paddingTop: t.spacing.xxs }]}>
        <LikeButton
          liked={post.likedByMe}
          count={post.likeCount}
          subject={title}
          interactive={interactive}
          onPress={onLikePress}
        />

        <ActionButton
          icon="chatbubble-outline"
          count={post.commentCount}
          label={
            post.commentCount === 0
              ? `Comment on ${title}'s post`
              : `${post.commentCount} ${pluralWord(post.commentCount, 'comment')}`
          }
          hint="Opens the comments."
          onPress={interactive ? onComment : undefined}
        />

        <View style={styles.grow} />

        <ActionButton
          icon="share-outline"
          label="Share this post"
          hint="Opens the share sheet."
          onPress={interactive ? onShare : undefined}
        />
      </View>
    </Animated.View>
  );
}

/* ------------------------------------------------------------- tap wrapper */

/**
 * A pressable region that degrades to a plain, screen-reader-visible block when
 * there is nothing to press — which is the composer's preview, where every
 * control must look real and do nothing.
 */
function Tappable({
  onPress,
  accessibilityLabel,
  accessibilityHint,
  style,
  children,
}: {
  onPress?: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  if (!onPress) {
    return (
      <View accessible accessibilityRole="text" accessibilityLabel={accessibilityLabel} style={style}>
        {children}
      </View>
    );
  }

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      haptic="tap"
      onPress={onPress}
      pressScale="subtle"
      style={style}
    >
      {children}
    </Touchable>
  );
}

/* ----------------------------------------------------------------- media */

function MediaGrid({
  uris,
  subject,
  interactive,
  onOpen,
  onDoubleTap,
}: {
  uris: string[];
  subject: string;
  interactive: boolean;
  onOpen?: (imageIndex: number) => void;
  onDoubleTap: () => void;
}) {
  const t = useTheme();
  const gap = t.spacing.hair;
  const shown = uris.slice(0, MAX_TILES);
  const overflow = uris.length - shown.length;

  const frame: ViewStyle = {
    borderRadius: t.radius.lg,
    overflow: 'hidden',
    backgroundColor: t.color.surfaceAlt,
  };

  const tile = (uri: string, position: number, geometry: TileGeometry) => (
    <MediaTile
      key={`${uri}-${position}`}
      uri={uri}
      badge={geometry.badge}
      position={position}
      total={uris.length}
      subject={subject}
      interactive={interactive}
      onOpen={onOpen}
      onDoubleTap={onDoubleTap}
      style={geometry.style}
    />
  );

  const badgeFor = (position: number): string | null =>
    overflow > 0 && position === shown.length - 1 ? `+${overflow}` : null;

  if (shown.length === 1) {
    return (
      <View style={[frame, { aspectRatio: SOLO_ASPECT }]}>
        {tile(shown[0] ?? '', 0, { style: StyleSheet.absoluteFill, badge: null })}
      </View>
    );
  }

  if (shown.length === 2) {
    return (
      <View style={[frame, styles.row, { aspectRatio: PAIR_ASPECT, gap }]}>
        {shown.map((uri, position) => tile(uri, position, { style: styles.grow, badge: badgeFor(position) }))}
      </View>
    );
  }

  if (shown.length === 3) {
    return (
      <View style={[frame, styles.row, { aspectRatio: TRIO_ASPECT, gap }]}>
        {tile(shown[0] ?? '', 0, { style: styles.lead, badge: null })}
        <View style={[styles.grow, { gap }]}>
          {tile(shown[1] ?? '', 1, { style: styles.grow, badge: null })}
          {tile(shown[2] ?? '', 2, { style: styles.grow, badge: badgeFor(2) })}
        </View>
      </View>
    );
  }

  return (
    <View style={[frame, { aspectRatio: 1, gap }]}>
      <View style={[styles.row, styles.grow, { gap }]}>
        {tile(shown[0] ?? '', 0, { style: styles.grow, badge: null })}
        {tile(shown[1] ?? '', 1, { style: styles.grow, badge: null })}
      </View>
      <View style={[styles.row, styles.grow, { gap }]}>
        {tile(shown[2] ?? '', 2, { style: styles.grow, badge: null })}
        {tile(shown[3] ?? '', 3, { style: styles.grow, badge: badgeFor(3) })}
      </View>
    </View>
  );
}

function MediaTile({
  uri,
  badge,
  position,
  total,
  subject,
  interactive,
  onOpen,
  onDoubleTap,
  style,
}: {
  uri: string;
  badge: string | null;
  position: number;
  total: number;
  subject: string;
  interactive: boolean;
  onOpen?: (imageIndex: number) => void;
  onDoubleTap: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const reduce = t.reduceMotion;

  const reveal = useSharedValue(0);
  const heart = useSharedValue(0);

  // A recycled row must not cross-fade the outgoing photo into the incoming one.
  useEffect(() => {
    reveal.value = 0;
  }, [reveal, uri]);

  const revealStyle = useAnimatedStyle(() => ({
    opacity: reveal.value,
    transform: reduce ? [] : [{ scale: 1.03 - reveal.value * 0.03 }],
  }));

  const lift = t.spacing.xxxl;
  const heartStyle = useAnimatedStyle(() => {
    const p = heart.value;
    if (reduce) return { opacity: interpolate(p, [0, 0.15, 0.7, 1], [0, 1, 1, 0]), transform: [] };
    return {
      opacity: interpolate(p, [0, 0.12, 0.65, 1], [0, 1, 1, 0]),
      transform: [
        { translateY: -interpolate(p, [0, 1], [0, lift]) },
        { scale: interpolate(p, [0, 0.22, 1], [0.4, 1.15, 0.98]) },
      ],
    };
  });

  const fireHeart = useCallback(() => {
    heart.value = 0;
    heart.value = withTiming(1, t.motion.timing(t.motion.duration.slower, 'decelerate'));
    onDoubleTap();
  }, [heart, onDoubleTap, t.motion]);

  const open = useCallback(() => onOpen?.(position), [onOpen, position]);

  const gesture = useMemo(() => {
    const double = Gesture.Tap()
      .numberOfTaps(2)
      .maxDuration(260)
      .enabled(interactive)
      .onEnd((_event, success) => {
        if (success) runOnJS(fireHeart)();
      });

    const single = Gesture.Tap()
      .numberOfTaps(1)
      .enabled(interactive && onOpen !== undefined)
      .onEnd((_event, success) => {
        if (success) runOnJS(open)();
      });

    // Exclusive, so the single tap waits for the double tap to fail rather than
    // opening the viewer under a like.
    return Gesture.Exclusive(double, single);
  }, [fireHeart, interactive, onOpen, open]);

  const spoken =
    total === 1
      ? `Photo of ${subject}`
      : `Photo ${position + 1} of ${total} of ${subject}`;

  const ink = inkOverPhoto(t);

  return (
    <GestureDetector gesture={gesture}>
      <View
        accessible
        accessibilityRole={interactive && onOpen ? 'imagebutton' : 'image'}
        accessibilityLabel={badge ? `${spoken}. ${badge} more.` : spoken}
        accessibilityHint={
          interactive && onOpen ? 'Opens the photo full screen. Double tap the photo to like it.' : undefined
        }
        onAccessibilityTap={interactive && onOpen ? open : undefined}
        style={[styles.tile, { backgroundColor: t.color.skeleton }, style]}
      >
        <Animated.View style={[StyleSheet.absoluteFill, revealStyle]}>
          <Image
            source={{ uri }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            cachePolicy="memory-disk"
            // The reveal is ours; expo-image's own transition would double-fade.
            transition={0}
            recyclingKey={uri}
            accessible={false}
            onLoad={() => {
              reveal.value = withTiming(1, t.motion.timing(t.motion.duration.slow, 'decelerate'));
            }}
          />
        </Animated.View>

        {badge ? (
          <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: t.color.scrim }]}>
            <Text variant="title2" color={ink}>
              {badge}
            </Text>
          </View>
        ) : null}

        <Animated.View style={[styles.floatingHeart, heartStyle]} pointerEvents="none">
          <Icon name="heart" size={t.spacing.giant} color={t.color.danger} />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

/* ------------------------------------------------------------------ like */

function LikeButton({
  liked,
  count,
  subject,
  interactive,
  onPress,
}: {
  liked: boolean;
  count: number;
  subject: string;
  interactive: boolean;
  onPress?: () => void;
}) {
  const t = useTheme();
  const reduce = t.reduceMotion;

  const fill = useSharedValue(liked ? 1 : 0);
  const pop = useSharedValue(0);
  const burst = useSharedValue(0);
  /** The first frame is a state, not a change — a scrolled-back card must not burst. */
  const settled = useRef(false);

  useEffect(() => {
    fill.value = withSpring(liked ? 1 : 0, FILL_SPRING);

    if (!settled.current) {
      settled.current = true;
      return;
    }

    // Un-liking gets a fraction of the overshoot: it is a correction, not a
    // celebration, and celebrating it would read as sarcasm.
    pop.value = withSequence(withSpring(liked ? 1 : 0.3, POP_IN), withSpring(0, POP_OUT));

    if (liked && !reduce) {
      burst.value = 0;
      burst.value = withTiming(1, t.motion.timing(t.motion.duration.slower, 'decelerate'));
    }
  }, [burst, fill, liked, pop, reduce, t.motion]);

  const iconScale = useAnimatedStyle(() => ({ transform: [{ scale: 1 + pop.value * HEART_POP }] }));
  const filledStyle = useAnimatedStyle(() => ({ opacity: fill.value }));
  const outlineStyle = useAnimatedStyle(() => ({ opacity: 1 - fill.value }));

  const restInk = t.color.textSecondary;
  const activeInk = t.color.danger;
  const countStyle = useAnimatedStyle(() => ({
    color: interpolateColor(fill.value, [0, 1], [restInk, activeInk]),
  }));

  const label = liked
    ? `Liked. ${count} ${pluralWord(count, 'like')}`
    : `Like ${subject}'s post. ${count} ${pluralWord(count, 'like')}`;

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={liked ? 'Removes your like.' : 'Adds your like straight away.'}
      accessibilityState={{ selected: liked }}
      haptic="none"
      onPress={onPress}
      pressScale="small"
      style={[styles.action, { gap: t.spacing.xs }]}
    >
      <View style={styles.glyph}>
        {!reduce && interactive
          ? Array.from({ length: BURST_HEARTS }, (_, i) => (
              <BurstHeart
                key={i}
                index={i}
                burst={burst}
                color={t.color.danger}
                size={t.spacing.sm}
                distance={t.spacing.lg}
              />
            ))
          : null}

        <Animated.View style={iconScale}>
          <Animated.View style={outlineStyle}>
            <Icon name="heart-outline" size="md" color={restInk} />
          </Animated.View>
          <Animated.View
            style={[StyleSheet.absoluteFill, filledStyle]}
            importantForAccessibility="no-hide-descendants"
          >
            <Icon name="heart" size="md" color={activeInk} />
          </Animated.View>
        </Animated.View>
      </View>

      <AnimatedCount value={count} style={countStyle} />
    </Touchable>
  );
}

/** One heart thrown outward by the burst. */
function BurstHeart({
  index,
  burst,
  color,
  size,
  distance,
}: {
  index: number;
  burst: SharedValue<number>;
  color: string;
  size: number;
  distance: number;
}) {
  // Start at twelve o'clock and walk round, so the ring reads as a bloom
  // opening rather than a random scatter.
  const angle = (index / BURST_HEARTS) * Math.PI * 2 - Math.PI / 2;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);

  const style = useAnimatedStyle(() => {
    const p = burst.value;
    const travel = interpolate(p, [0, 1], [0, distance]);
    return {
      opacity: interpolate(p, [0, 0.1, 0.7, 1], [0, 1, 0.9, 0]),
      transform: [
        { translateX: dx * travel },
        { translateY: dy * travel },
        { scale: interpolate(p, [0, 0.25, 1], [0.2, 1, 0.3]) },
      ],
    };
  });

  return (
    <Animated.View style={[styles.burstHeart, style]} pointerEvents="none">
      <Icon name="heart" size={size} color={color} />
    </Animated.View>
  );
}

/* --------------------------------------------------------------- actions */

function ActionButton({
  icon,
  count,
  label,
  hint,
  onPress,
}: {
  icon: IconName;
  count?: number;
  label: string;
  hint: string;
  onPress?: () => void;
}) {
  const t = useTheme();

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      haptic="tap"
      onPress={onPress}
      pressScale="small"
      style={[styles.action, { gap: t.spacing.xs }]}
    >
      <Icon name={icon} size="md" color="textSecondary" />
      {count === undefined ? null : (
        <Text variant="subheadStrong" color="textSecondary" tabular>
          {formatCount(count)}
        </Text>
      )}
    </Touchable>
  );
}

/**
 * The like count. Its colour is animated with the heart, which needs an animated
 * text node — `@/ui/Text` renders a plain one, so the style is applied to an
 * `Animated.Text` carrying the same variant metrics.
 */
// The animated style handed in interpolates `color`, so this is a text style —
// typing it as ViewStyle compiled everywhere except at the one call site.
function AnimatedCount({ value, style }: { value: number; style: StyleProp<TextStyle> }) {
  const t = useTheme();
  const { maxFontSizeMultiplier, ...typeStyle } = t.type.subheadStrong;

  return (
    <Animated.Text
      allowFontScaling
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      importantForAccessibility="no-hide-descendants"
      style={[typeStyle, style]}
    >
      {formatCount(value)}
    </Animated.Text>
  );
}

/* ----------------------------------------------------------------- styles */

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  grow: { flex: 1 },
  shrink: { flexShrink: 1 },
  hug: { alignSelf: 'flex-start' },
  // The three-up layout's hero tile: twice the width of the stacked pair.
  lead: { flex: 2 },
  cluster: { position: 'relative' },
  byAvatar: { position: 'absolute', right: -2, bottom: -2 },
  // A breed name must never squeeze the pet's own name out of the header.
  groupSlot: { maxWidth: '42%', flexShrink: 1 },
  tile: { overflow: 'hidden' },
  action: { flexDirection: 'row', alignItems: 'center' },
  glyph: { alignItems: 'center', justifyContent: 'center' },
  burstHeart: { position: 'absolute' },
  floatingHeart: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default PostCard;
