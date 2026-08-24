/**
 * Petal — the post composer.
 *
 * A composer is where a social app either sounds like a person or like a form,
 * so this one is built as four questions in the order you actually answer them:
 * *who is speaking*, *what are you saying*, *where does it go*, and *how will it
 * look*. Nothing here is a labelled input with a Save button underneath.
 *
 *   · **Who** is a rail of faces, not a dropdown. Posting *as* a pet is the
 *     charm of this community, and a caregiver can only do it for a pet whose
 *     owner granted `community.post` — so ungranted pets stay visible, dimmed,
 *     and explain themselves on tap rather than vanishing. A sitter's post is
 *     badged as such, and the preview shows that badge before they commit.
 *   · **What** is one warm writing surface with the budget drawn as a ring in
 *     its corner. A ring beats "412/500": you read a ring in peripheral vision,
 *     and it only turns into a number once the ending is actually near.
 *   · **Where** is the group rail, with "Anywhere" first — most posts don't
 *     belong to a group and the composer shouldn't imply they must.
 *   · **How it looks** is the real `PostCard` in `preview` mode. Not a mock-up:
 *     the same component the feed renders, which is why the fold, the photo
 *     grid and the sitting badge are all honest.
 *
 * Photos reorder by dragging. The tiles are absolutely positioned on a fixed
 * grid so a drag is one shared value and everything else springs out of its
 * way; screen-reader users get "Move earlier"/"Move later" actions on each
 * tile, because a drag-only affordance is a drag-only affordance.
 */

import * as ImagePicker from 'expo-image-picker';
import { Image } from 'expo-image';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  FadeIn,
  FadeInDown,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
  type WithSpringConfig,
} from 'react-native-reanimated';
import { runOnJS } from 'react-native-worklets';

import type { CreatePostInput } from '@/data/queries/useCommunity';
import { useGroups } from '@/data/queries/useCommunity';
import { usePets } from '@/data/queries/usePets';
import type { ID, Pet, PostWithAuthor } from '@/data/types';
import { possessive } from '@/lib/format';
import haptics from '@/lib/haptics';
import { useMyRole, usePermission } from '@/rbac/usePermission';
import { useCurrentUser } from '@/stores/session';
import { spring, useTheme, type Theme } from '@/theme';
import {
  Avatar,
  Button,
  ConfirmSheet,
  Icon,
  IconButton,
  ProgressRing,
  Screen,
  ScreenHeader,
  SectionHeader,
  Surface,
  Text,
  TextArea,
  Touchable,
  toast,
  useSheet,
} from '@/ui';
import { PostSkeleton } from '@/ui/skeletons/ContentSkeletons';
import { SkeletonGroup } from '@/ui/Skeleton';
import { GroupChip } from './GroupChip';
import { PostCard } from './PostCard';

/* -------------------------------------------------------------------- types */

export type ComposerProps = {
  /** Preselect the group — the group page's own "post here" affordance. */
  initialGroupId?: ID | null;
  /** Preselect the pet being spoken for. */
  initialPetId?: ID | null;
  submitting?: boolean;
  onSubmit: (input: CreatePostInput) => void;
  onCancel: () => void;
  style?: StyleProp<ViewStyle>;
};

/* ---------------------------------------------------------------- constants */

/** See `@/ui/Touchable` — the theme's `springWith` helper doesn't type-check yet. */
const SETTLE: WithSpringConfig = { ...spring.snappy, reduceMotion: ReduceMotion.System };
const LIFT: WithSpringConfig = { ...spring.gentle, reduceMotion: ReduceMotion.System };

/** Long enough for a real story, short enough that the feed stays scannable. */
const BODY_MAX = 500;

/** The number only appears once the ending is genuinely close. */
const COUNTDOWN_FROM = 80;

/** Matches `PostCard`'s grid — a fifth photo would have nowhere to live. */
const MAX_IMAGES = 4;

/** How much a dragged thumbnail grows, as a fraction of its size. */
const DRAG_LIFT = 0.08;

/* ------------------------------------------------------------------ helpers */

function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return next;
  next.splice(to, 0, moved);
  return next;
}

/* ---------------------------------------------------------------- component */

export function Composer({
  initialGroupId = null,
  initialPetId = null,
  submitting = false,
  onSubmit,
  onCancel,
  style,
}: ComposerProps) {
  const t = useTheme();
  const me = useCurrentUser();
  const petsQuery = usePets();
  const groupsQuery = useGroups();

  const [petId, setPetId] = useState<ID | null>(initialPetId);
  const [groupId, setGroupId] = useState<ID | null>(initialGroupId);
  const [body, setBody] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const discard = useSheet();

  const pets = useMemo(() => petsQuery.data ?? [], [petsQuery.data]);
  const groups = useMemo(() => groupsQuery.data ?? [], [groupsQuery.data]);

  const pet = useMemo(() => pets.find((row) => row.id === petId) ?? null, [petId, pets]);
  const group = useMemo(() => groups.find((row) => row.id === groupId) ?? null, [groupId, groups]);
  const role = useMyRole(petId);

  const trimmed = body.trim();
  const used = body.length;
  const remaining = BODY_MAX - used;
  const hasSomething = trimmed.length > 0 || images.length > 0;
  const canPost = hasSomething && remaining >= 0 && !submitting;

  /* ---- photos --------------------------------------------------------- */

  const addPhotos = useCallback(async () => {
    const room = MAX_IMAGES - images.length;
    if (room <= 0) return;

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      haptics.warn();
      toast.warning('Furry Tracker can’t see your photos yet', {
        description: 'Turn on photo access in Settings and they’ll be right here.',
      });
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: room,
      orderedSelection: true,
      quality: 0.85,
    });
    if (result.canceled) return;

    const picked = result.assets.map((asset) => asset.uri);
    if (picked.length === 0) return;
    haptics.success();
    setImages((prev) => [...prev, ...picked].slice(0, MAX_IMAGES));
  }, [images.length]);

  const removePhoto = useCallback((index: number) => {
    haptics.tap();
    setImages((prev) => prev.filter((_, position) => position !== index));
  }, []);

  const reorderPhotos = useCallback((from: number, to: number) => {
    if (from === to) return;
    haptics.select();
    setImages((prev) => moveItem(prev, from, to));
  }, []);

  /* ---- submit ---------------------------------------------------------- */

  const submit = useCallback(() => {
    if (!canPost) return;
    haptics.commit();
    onSubmit({ petId, groupId, body: trimmed, imageUrls: images });
  }, [canPost, groupId, images, onSubmit, petId, trimmed]);

  /** Half-written posts are worth one question before they disappear. */
  const requestCancel = useCallback(() => {
    if (hasSomething) {
      discard.open();
      return;
    }
    onCancel();
  }, [discard, hasSomething, onCancel]);

  /* ---- preview --------------------------------------------------------- */

  const preview = useMemo<PostWithAuthor | null>(() => {
    if (!me) return null;
    return {
      id: 'composer-preview',
      authorId: me.id,
      petId,
      groupId,
      body: trimmed,
      imageUrls: images,
      likeCount: 0,
      commentCount: 0,
      likedByMe: false,
      // The adapter stamps this from the membership; mirroring it here means the
      // sitter sees the badge before they commit, not after.
      postedWhileSitting: role === 'caregiver',
      createdAt: new Date().toISOString(),
      author: me,
      pet,
      group,
    };
  }, [group, groupId, images, me, pet, petId, role, trimmed]);

  /* ---- chrome ---------------------------------------------------------- */

  /**
   * The action lives in the bar, not on a sticky footer. `Screen`'s footer sits
   * outside the keyboard avoider by design, which would leave the one button
   * that finishes the job hidden under the keys for the entire time you're
   * writing.
   */
  const header = (
    <ScreenHeader
      title="Share something"
      large={false}
      showBack={false}
      leading={
        <IconButton
          icon="close"
          accessibilityLabel="Close the composer"
          accessibilityHint="Nothing you’ve written is posted."
          variant="ghost"
          tone="neutral"
          onPress={requestCancel}
        />
      }
      actions={
        <Button
          label="Post"
          onPress={submit}
          variant="primary"
          size="sm"
          haptic="none"
          loading={submitting}
          disabled={!canPost}
          accessibilityHint={
            canPost ? 'Shares this with the community.' : 'Write something or add a photo first.'
          }
        />
      }
    />
  );

  if (!me || petsQuery.isPending || groupsQuery.isPending) {
    return (
      <Screen header={header} scroll style={style}>
        <SkeletonGroup label="Getting the composer ready" gap="xl">
          <PostSkeleton image={false} />
          <PostSkeleton />
        </SkeletonGroup>
      </Screen>
    );
  }

  const speaker = pet ? pet.name : me.displayName;

  return (
    <Screen
      header={header}
      scroll
      style={style}
      contentContainerStyle={{ gap: t.spacing.xl, paddingBottom: t.spacing.giant }}
    >
      {/* ------------------------------------------------------ posting as */}

      <Animated.View entering={enterAt(t, 0)} style={{ gap: t.spacing.sm }}>
        <SectionHeader
          first
          variant="overline"
          title="Posting as"
          subtitle="Speak for yourself, or hand the microphone to someone smaller."
        />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: t.spacing.md, paddingVertical: t.spacing.xxs }}
        >
          <SpeakerOption
            label="You"
            caption={me.displayName}
            avatar={<Avatar uri={me.avatarUrl} name={me.displayName} size="lg" />}
            selected={petId === null}
            onPress={() => {
              haptics.select();
              setPetId(null);
            }}
          />
          {pets.map((row) => (
            <PetOption
              key={row.id}
              pet={row}
              selected={petId === row.id}
              onSelect={() => {
                haptics.select();
                setPetId(row.id);
              }}
            />
          ))}
        </ScrollView>
      </Animated.View>

      {/* --------------------------------------------------------- writing */}

      <Animated.View entering={enterAt(t, 1)}>
        <Surface elevation={1} radius="xxl" padding="base" style={{ gap: t.spacing.md }}>
          <TextArea
            value={body}
            onChangeText={setBody}
            variant="filled"
            minRows={5}
            maxRows={12}
            maxLength={BODY_MAX}
            placeholder={
              pet
                ? `What has ${pet.name} been up to?`
                : 'A small win, a hard week, a question for people who get it…'
            }
            accessibilityLabel={`Your post, as ${speaker}`}
            accessibilityHint="Up to five hundred characters."
          />

          <View style={[styles.row, { gap: t.spacing.md }]}>
            <Touchable
              accessibilityRole="button"
              accessibilityLabel={
                images.length === 0
                  ? 'Add photos'
                  : `Add photos. ${images.length} of ${MAX_IMAGES} chosen.`
              }
              accessibilityHint="Opens your photo library."
              accessibilityState={{ disabled: images.length >= MAX_IMAGES }}
              disabled={images.length >= MAX_IMAGES}
              haptic="tap"
              onPress={() => {
                void addPhotos();
              }}
              pressScale="small"
              style={[
                styles.row,
                {
                  gap: t.spacing.xs,
                  paddingVertical: t.spacing.sm,
                  paddingHorizontal: t.spacing.md,
                  borderRadius: t.radius.pill,
                  backgroundColor: t.color.primarySoft,
                },
              ]}
            >
              <Icon name="images-outline" size="sm" color="onPrimarySoft" />
              <Text variant="captionStrong" color="onPrimarySoft">
                {images.length === 0 ? 'Add photos' : `${images.length} of ${MAX_IMAGES}`}
              </Text>
            </Touchable>

            <View style={styles.grow} />

            <BudgetRing used={used} max={BODY_MAX} />
          </View>

          {images.length > 0 ? (
            <PhotoStrip
              uris={images}
              subject={speaker}
              onRemove={removePhoto}
              onReorder={reorderPhotos}
            />
          ) : null}
        </Surface>
      </Animated.View>

      {/* ----------------------------------------------------------- where */}

      <Animated.View entering={enterAt(t, 2)} style={{ gap: t.spacing.sm }}>
        <SectionHeader
          variant="overline"
          title="Where it lands"
          subtitle="A group finds the people who'll actually have an answer."
        />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: t.spacing.sm, paddingVertical: t.spacing.xxs }}
        >
          <Touchable
            accessibilityRole="button"
            accessibilityLabel="Anywhere. No group."
            accessibilityHint="Your post goes to the main feed."
            accessibilityState={{ selected: groupId === null }}
            haptic="select"
            onPress={() => setGroupId(null)}
            pressScale="small"
            style={[
              styles.row,
              {
                gap: t.spacing.xs,
                paddingVertical: t.spacing.xxs,
                paddingHorizontal: t.spacing.sm,
                borderRadius: t.radius.pill,
                borderWidth: t.borderWidth.hairline,
                borderColor: groupId === null ? t.color.primarySoftBorder : t.color.border,
                backgroundColor: groupId === null ? t.color.primarySoft : t.color.surfaceAlt,
              },
            ]}
          >
            <Icon
              name="globe-outline"
              size="xs"
              color={groupId === null ? 'onPrimarySoft' : 'textTertiary'}
            />
            <Text
              variant="captionStrong"
              color={groupId === null ? 'onPrimarySoft' : 'textSecondary'}
            >
              Anywhere
            </Text>
          </Touchable>

          {groups.map((row) => (
            <GroupChip
              key={row.id}
              group={row}
              selected={groupId === row.id}
              onPress={() => {
                haptics.select();
                setGroupId((current) => (current === row.id ? null : row.id));
              }}
            />
          ))}
        </ScrollView>
      </Animated.View>

      {/* --------------------------------------------------------- preview */}

      {preview ? (
        <Animated.View entering={enterAt(t, 3)} style={{ gap: t.spacing.sm }}>
          <SectionHeader
            variant="overline"
            title="How it'll look"
            subtitle={
              hasSomething
                ? 'Exactly this — the real card, not a mock-up.'
                : 'Start writing and it fills in as you go.'
            }
          />
          <PreviewSwap hasSomething={hasSomething} speaker={speaker} post={preview} />
        </Animated.View>
      ) : null}

      <ConfirmSheet
        controller={discard}
        title="Throw this one away?"
        body={`We won't keep a copy. ${speaker} can always say it again later, but not in these words.`}
        confirmLabel="Discard it"
        cancelLabel="Keep writing"
        icon="trash-outline"
        onConfirm={onCancel}
      />
    </Screen>
  );
}

/* ----------------------------------------------------------------- preview */

/**
 * Renders the "how it'll look" preview. `PostCard` stays mounted continuously
 * once there's anything to preview at all — only the empty-state hint fades in
 * or out on top of it.
 *
 * The obvious version of this — `hasSomething ? <PostCard/> : <Surface/>` —
 * swaps `PostCard` in and out of the tree on the first keystroke, since that's
 * exactly when `hasSomething` flips. On Android that's a real cost: it inserts
 * a large new subtree (author row, avatar, image grid) into a `ScrollView`
 * during a keystroke that also lands while the keyboard's resize animation
 * from the tap-to-focus a moment earlier is still settling, and the two
 * together are a documented way to lose focus on the field you're actively
 * typing into. Keeping `PostCard` mounted throughout removes that mount
 * entirely — typing only ever updates props on an already-live component.
 */
function PreviewSwap({
  hasSomething,
  speaker,
  post,
}: {
  hasSomething: boolean;
  speaker: string;
  post: PostWithAuthor;
}) {
  const t = useTheme();
  const hint = useSharedValue(hasSomething ? 0 : 1);

  useEffect(() => {
    hint.value = withTiming(
      hasSomething ? 0 : 1,
      t.motion.timing(t.motion.duration.base, 'smooth'),
    );
  }, [hasSomething, hint, t.motion]);

  const hintStyle = useAnimatedStyle(() => ({ opacity: hint.value }));

  // The hint overlay is absolutely filled, so the stack's own height comes
  // from PostCard alone — this floor only matters before any content exists,
  // when PostCard is at its shortest and the hint needs somewhere to sit.
  const stackStyle = { minHeight: t.spacing.colossal * 2 };

  return (
    <View style={stackStyle}>
      <PostCard post={post} preview />

      <Animated.View
        pointerEvents={hasSomething ? 'none' : 'auto'}
        style={[StyleSheet.absoluteFill, hintStyle]}
      >
        <Surface
          variant="surfaceAlt"
          radius="xl"
          padding="lg"
          border
          style={[styles.center, StyleSheet.absoluteFill, { gap: t.spacing.sm, borderStyle: 'dashed' }]}
        >
          <Icon name="sparkles-outline" size="lg" color="textTertiary" />
          <Text variant="footnote" color="textTertiary" align="center">
            {`Your card appears here the moment ${speaker} has something to say.`}
          </Text>
        </Surface>
      </Animated.View>
    </View>
  );
}

/* --------------------------------------------------------------- entrances */

function enterAt(t: Theme, index: number) {
  const delay = index * t.motion.stagger.base;
  return t.reduceMotion
    ? FadeIn.duration(t.motion.duration.base).delay(delay)
    : FadeInDown.duration(t.motion.duration.slow).delay(delay).easing(t.motion.easing.decelerate);
}

/* ---------------------------------------------------------------- speakers */

function SpeakerOption({
  label,
  caption,
  avatar,
  selected,
  onPress,
  disabledReason,
  accessibilityHint,
}: {
  label: string;
  caption: string;
  avatar: React.ReactNode;
  selected: boolean;
  onPress: () => void;
  disabledReason?: string;
  accessibilityHint?: string;
}) {
  const t = useTheme();

  const progress = useSharedValue(selected ? 1 : 0);
  useEffect(() => {
    progress.value = withSpring(selected ? 1 : 0, SETTLE);
  }, [progress, selected]);

  const skin = useAnimatedStyle(() => ({
    transform: [{ scale: 0.96 + progress.value * 0.04 }],
  }));

  const tickStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: 0.4 + progress.value * 0.6 }],
  }));

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={`Post as ${label}. ${caption}.`}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected }}
      disabledReason={disabledReason}
      haptic="none"
      onPress={onPress}
      pressScale="small"
      style={{ width: t.spacing.giant + t.spacing.lg }}
    >
      <Animated.View style={[styles.center, { gap: t.spacing.xs }, skin]}>
        <View>
          <View
            style={[
              styles.center,
              {
                padding: t.spacing.hair,
                borderRadius: t.radius.pill,
                borderWidth: t.borderWidth.thick,
                borderColor: selected ? t.color.primary : 'transparent',
              },
            ]}
          >
            {avatar}
          </View>
          <Animated.View
            pointerEvents="none"
            style={[
              styles.tick,
              styles.center,
              {
                width: t.spacing.lg,
                height: t.spacing.lg,
                borderRadius: t.radius.pill,
                backgroundColor: t.color.primary,
                borderWidth: t.borderWidth.thick,
                borderColor: t.color.bg,
              },
              tickStyle,
            ]}
          >
            <Icon name="checkmark" size={t.spacing.md} color={t.color.onPrimary} />
          </Animated.View>
        </View>

        <Text
          variant="captionStrong"
          color={selected ? 'primaryText' : 'textSecondary'}
          numberOfLines={1}
          align="center"
        >
          {label}
        </Text>
      </Animated.View>
    </Touchable>
  );
}

/**
 * A pet the user might speak for. `community.post` is grantable, so a caregiver
 * without it sees the face dimmed and learns what to ask for on tap — never a
 * pet that silently isn't there.
 */
function PetOption({
  pet,
  selected,
  onSelect,
}: {
  pet: Pet;
  selected: boolean;
  onSelect: () => void;
}) {
  const { allowed, explain } = usePermission('community.post', pet.id);

  return (
    <SpeakerOption
      label={pet.name}
      caption={`${possessive(pet.name)} voice`}
      avatar={<Avatar uri={pet.photoUrl} name={pet.name} species={pet.species} size="lg" ring />}
      selected={selected && allowed}
      onPress={allowed ? onSelect : () => explain({ petName: pet.name })}
      disabledReason={allowed ? undefined : `You can’t post as ${pet.name} yet.`}
      accessibilityHint={allowed ? 'Your post is written in their name.' : undefined}
    />
  );
}

/* ------------------------------------------------------------ budget ring */

function BudgetRing({ used, max }: { used: number; max: number }) {
  const t = useTheme();
  const remaining = max - used;
  const ratio = used / max;
  const tone = remaining < 0 ? 'danger' : ratio >= 0.9 ? 'warning' : 'primary';

  return (
    <ProgressRing
      value={Math.min(1, Math.max(0, ratio))}
      size={t.spacing.xxl}
      tone={tone}
      thickness={t.borderWidth.thick + t.borderWidth.hairline}
      accessibilityLabel={
        remaining >= 0
          ? `${remaining} characters left`
          : `${Math.abs(remaining)} characters over the limit`
      }
    >
      {remaining <= COUNTDOWN_FROM ? (
        // Fill tokens are for fills — the number is text on a page ground, so it
        // takes the matching ink instead.
        <Text
          variant="caption"
          color={remaining < 0 ? 'danger' : ratio >= 0.9 ? 'onWarningSoft' : 'textTertiary'}
          tabular
        >
          {remaining}
        </Text>
      ) : null}
    </ProgressRing>
  );
}

/* ------------------------------------------------------------ photo strip */

function PhotoStrip({
  uris,
  subject,
  onRemove,
  onReorder,
}: {
  uris: string[];
  subject: string;
  onRemove: (index: number) => void;
  onReorder: (from: number, to: number) => void;
}) {
  const t = useTheme();
  const [width, setWidth] = useState(0);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.width;
    setWidth((prev) => (Math.abs(prev - measured) < 1 ? prev : measured));
  }, []);

  const gap = t.spacing.sm;
  // Four slots always, however many photos there are — so a tile never resizes
  // under your finger as the fourth one arrives.
  const tile = width > 0 ? (width - gap * (MAX_IMAGES - 1)) / MAX_IMAGES : 0;
  const step = tile + gap;

  const dragging = useSharedValue(-1);
  const target = useSharedValue(-1);
  const offset = useSharedValue(0);

  return (
    <View onLayout={onLayout} style={{ height: tile }}>
      {tile > 0
        ? uris.map((uri, index) => (
            <PhotoThumb
              key={`${uri}-${index}`}
              uri={uri}
              index={index}
              total={uris.length}
              subject={subject}
              tile={tile}
              step={step}
              dragging={dragging}
              target={target}
              offset={offset}
              onRemove={onRemove}
              onReorder={onReorder}
            />
          ))
        : null}
    </View>
  );
}

function PhotoThumb({
  uri,
  index,
  total,
  subject,
  tile,
  step,
  dragging,
  target,
  offset,
  onRemove,
  onReorder,
}: {
  uri: string;
  index: number;
  total: number;
  subject: string;
  tile: number;
  step: number;
  dragging: SharedValue<number>;
  target: SharedValue<number>;
  offset: SharedValue<number>;
  onRemove: (index: number) => void;
  onReorder: (from: number, to: number) => void;
}) {
  const t = useTheme();

  const settle = useCallback(
    (from: number, to: number) => {
      onReorder(from, to);
    },
    [onReorder],
  );

  // Long-press to lift, so a horizontal drag can't be mistaken for a scroll of
  // the composer underneath.
  const holdToLift = t.motion.duration.fast;

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activateAfterLongPress(holdToLift)
        .onStart(() => {
          dragging.value = index;
          target.value = index;
          offset.value = 0;
          runOnJS(haptics.threshold)();
        })
        .onUpdate((event) => {
          offset.value = event.translationX;
          const raw = Math.round((index * step + event.translationX) / step);
          const next = Math.min(total - 1, Math.max(0, raw));
          if (next !== target.value) target.value = next;
        })
        .onEnd(() => {
          const from = index;
          const to = target.value;
          dragging.value = -1;
          offset.value = 0;
          target.value = -1;
          if (to !== from) runOnJS(settle)(from, to);
        })
        .onFinalize(() => {
          if (dragging.value === index) {
            dragging.value = -1;
            offset.value = 0;
            target.value = -1;
          }
        }),
    [dragging, holdToLift, index, offset, settle, step, target, total],
  );

  const style = useAnimatedStyle(() => {
    const held = dragging.value === index;
    if (held) {
      return {
        transform: [
          { translateX: index * step + offset.value },
          { scale: 1 + DRAG_LIFT },
        ],
        zIndex: 2,
      };
    }

    let x = index * step;
    const from = dragging.value;
    const to = target.value;
    if (from >= 0 && to >= 0) {
      if (from < to && index > from && index <= to) x -= step;
      else if (from > to && index >= to && index < from) x += step;
    }

    return { transform: [{ translateX: withSpring(x, LIFT) }, { scale: 1 }], zIndex: 1 };
  });

  const position = `Photo ${index + 1} of ${total} of ${subject}`;

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        entering={FadeIn.duration(t.motion.duration.base)}
        accessible
        accessibilityRole="image"
        accessibilityLabel={position}
        accessibilityHint="Hold and drag to change the order."
        accessibilityActions={[
          { name: 'moveEarlier', label: 'Move earlier' },
          { name: 'moveLater', label: 'Move later' },
          { name: 'remove', label: 'Remove this photo' },
        ]}
        onAccessibilityAction={(event) => {
          const action = event.nativeEvent.actionName;
          if (action === 'moveEarlier' && index > 0) onReorder(index, index - 1);
          else if (action === 'moveLater' && index < total - 1) onReorder(index, index + 1);
          else if (action === 'remove') onRemove(index);
        }}
        style={[
          styles.thumb,
          t.elevation(2),
          {
            width: tile,
            height: tile,
            borderRadius: t.radius.lg,
            backgroundColor: t.color.skeleton,
          },
          style,
        ]}
      >
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={t.motion.duration.base}
          recyclingKey={uri}
          accessible={false}
        />

        {index === 0 && total > 1 ? (
          <View
            pointerEvents="none"
            style={[
              styles.cover,
              {
                borderRadius: t.radius.pill,
                paddingHorizontal: t.spacing.xs,
                paddingVertical: t.spacing.hair,
                margin: t.spacing.xxs,
                backgroundColor: t.color.scrim,
              },
            ]}
          >
            {/* `textInverse` flips with the scheme; over a scrim we always want
                the scheme's own light ink. */}
            <Text
              variant="overline"
              color={t.scheme === 'dark' ? t.color.text : t.color.textInverse}
            >
              Cover
            </Text>
          </View>
        ) : null}

        <View style={[styles.remove, { margin: t.spacing.xxs }]}>
          <IconButton
            icon="close"
            accessibilityLabel={`Remove photo ${index + 1}`}
            variant="glass"
            tone="neutral"
            size="sm"
            shape="circle"
            haptic="none"
            onPress={() => onRemove(index)}
          />
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

/* ----------------------------------------------------------------- styles */

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  grow: { flex: 1 },
  tick: { position: 'absolute', right: -2, bottom: -2 },
  thumb: { position: 'absolute', left: 0, top: 0, overflow: 'hidden' },
  cover: { position: 'absolute', left: 0, bottom: 0 },
  remove: { position: 'absolute', right: 0, top: 0 },
});

export default Composer;
