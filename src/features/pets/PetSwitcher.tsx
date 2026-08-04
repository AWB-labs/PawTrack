/**
 * Petal — PetSwitcher.
 *
 * A household is two to four faces, so the fastest way to change context is to
 * look at them. This is the strip that sits under the Today header and above any
 * per-pet list: portraits, a ring that springs onto the active one, and names
 * that lift from tertiary to primary ink as they take over.
 *
 * The ring is drawn here rather than handed to `Avatar`'s own `ring` prop
 * because it has to *move* — a border that blinks between two portraits reads as
 * a re-render, where a ring that settles reads as a choice being made. The
 * portrait itself never scales, so a strip of five faces stays optically level.
 *
 * `includeAll` is what makes this work for the Today screen: a caregiver with
 * three pets wants "everything" first and one pet second.
 */

import React, { useCallback } from 'react';
import { ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useDerivedValue,
  withSpring,
  type WithSpringConfig,
} from 'react-native-reanimated';

import type { Pet } from '@/data/types';
import { spring, useTheme } from '@/theme';
import {
  Avatar,
  AVATAR_SIZE,
  Icon,
  Skeleton,
  SkeletonCircle,
  SkeletonGroup,
  Text,
  Touchable,
  type AvatarSize,
} from '@/ui';

/* -------------------------------------------------------------------- types */

export type PetSwitcherProps = {
  pets: readonly Pet[];
  /** `null` means "every pet", and only appears when `includeAll` is on. */
  selectedId: string | null;
  onSelect: (petId: string | null) => void;
  /** Leading item that clears the filter. */
  includeAll?: boolean;
  allLabel?: string;
  /** Trailing dashed item. Omit to hide it. */
  onAddPet?: () => void;
  size?: AvatarSize | number;
  /** Pets someone is actively sitting — their portrait breathes. */
  liveIds?: readonly string[];
  loading?: boolean;
  /** Announced for the strip — "Choose a pet". */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

type SlotProps = {
  label: string;
  selected: boolean;
  diameter: number;
  ringColor: string;
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  children: React.ReactNode;
};

/* ---------------------------------------------------------------- constants */

/** See `Touchable` — the theme's `springWith` helper doesn't type-check yet. */
const RING_SPRING: WithSpringConfig = { ...spring.snappy, reduceMotion: ReduceMotion.System };

/** The ring arrives from slightly wide, so it settles onto the portrait. */
const RING_FROM = 1.1;

const SKELETON_SLOTS = 3;

/* ---------------------------------------------------------------- component */

export function PetSwitcher({
  pets,
  selectedId,
  onSelect,
  includeAll = false,
  allLabel = 'All pets',
  onAddPet,
  size = 'lg',
  liveIds = [],
  loading = false,
  accessibilityLabel = 'Choose a pet',
  style,
  testID,
}: PetSwitcherProps) {
  const t = useTheme();
  const px = typeof size === 'number' ? size : AVATAR_SIZE[size];
  const gap = t.spacing.xs;
  const diameter = px + gap * 2;

  const handleSelect = useCallback((petId: string | null) => () => onSelect(petId), [onSelect]);

  if (loading) {
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        scrollEnabled={false}
        contentContainerStyle={{ paddingHorizontal: t.gutter, gap: t.spacing.base }}
        style={style}
        testID={testID}
      >
        <SkeletonGroup
          label="Loading your pets"
          style={[styles.row, { gap: t.spacing.base }]}
        >
          {Array.from({ length: SKELETON_SLOTS }, (_, index) => (
            <View key={index} style={[styles.slot, { gap: t.spacing.xs }]}>
              <SkeletonCircle size={diameter} />
              <Skeleton w={t.spacing.xxxl} h={t.type.caption.fontSize} r="xs" dim />
            </View>
          ))}
        </SkeletonGroup>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      contentContainerStyle={{ paddingHorizontal: t.gutter, gap: t.spacing.base }}
      style={style}
      testID={testID}
    >
      {includeAll ? (
        <Slot
          label={allLabel}
          selected={selectedId === null}
          diameter={diameter}
          ringColor={t.color.primary}
          onPress={handleSelect(null)}
          accessibilityLabel={allLabel}
          accessibilityHint="Shows every pet together"
        >
          <View
            style={[
              styles.center,
              { width: px, height: px, borderRadius: t.radius.pill, backgroundColor: t.color.primarySoft },
            ]}
          >
            <Icon name="paw" size="lg" color="onPrimarySoft" />
          </View>
        </Slot>
      ) : null}

      {pets.map((pet) => (
        <Slot
          key={pet.id}
          label={pet.name}
          selected={selectedId === pet.id}
          diameter={diameter}
          ringColor={t.speciesColor(pet.species).base}
          onPress={handleSelect(pet.id)}
          accessibilityLabel={pet.name}
          accessibilityHint={`Shows only ${pet.name}`}
        >
          <Avatar
            uri={pet.photoUrl}
            name={pet.name}
            species={pet.species}
            size={px}
            live={liveIds.includes(pet.id)}
          />
        </Slot>
      ))}

      {onAddPet ? <AddSlot diameter={diameter} inner={px} onPress={onAddPet} /> : null}
    </ScrollView>
  );
}

/* -------------------------------------------------------------------- slot */

function Slot({
  label,
  selected,
  diameter,
  ringColor,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  children,
}: SlotProps) {
  const t = useTheme();
  const reduce = t.reduceMotion;

  const progress = useDerivedValue(() => withSpring(selected ? 1 : 0, RING_SPRING), [selected]);

  const ringStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: reduce ? 1 : RING_FROM - progress.value * (RING_FROM - 1) }],
  }));

  return (
    <Touchable
      accessibilityRole="tab"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected }}
      haptic="select"
      onPress={onPress}
      pressScale="small"
      style={[styles.slot, { gap: t.spacing.xs }]}
    >
      <View style={[styles.center, { width: diameter, height: diameter }]}>
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              borderRadius: t.radius.pill,
              borderWidth: t.borderWidth.thick,
              borderColor: ringColor,
            },
            ringStyle,
          ]}
        />
        {children}
      </View>

      <Text
        variant={selected ? 'captionStrong' : 'caption'}
        color={selected ? 'text' : 'textTertiary'}
        numberOfLines={1}
        align="center"
        style={{ maxWidth: diameter + t.spacing.sm }}
      >
        {label}
      </Text>
    </Touchable>
  );
}

/* ---------------------------------------------------------------- add slot */

function AddSlot({
  diameter,
  inner,
  onPress,
}: {
  diameter: number;
  inner: number;
  onPress: () => void;
}) {
  const t = useTheme();

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel="Add a pet"
      accessibilityHint="Starts the new pet flow"
      haptic="tap"
      onPress={onPress}
      pressScale="small"
      style={[styles.slot, { gap: t.spacing.xs }]}
    >
      <View style={[styles.center, { width: diameter, height: diameter }]}>
        <View
          style={[
            styles.center,
            {
              width: inner,
              height: inner,
              borderRadius: t.radius.pill,
              borderWidth: t.borderWidth.thin,
              borderColor: t.color.borderStrong,
              borderStyle: 'dashed',
              backgroundColor: t.color.surfaceAlt,
            },
          ]}
        >
          <Icon name="add" size="lg" color="primaryText" />
        </View>
      </View>
      <Text
        variant="caption"
        color="textTertiary"
        numberOfLines={1}
        align="center"
        style={{ maxWidth: diameter + t.spacing.sm }}
      >
        Add
      </Text>
    </Touchable>
  );
}

/* ------------------------------------------------------------------ styles */

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  slot: { alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
});

export default PetSwitcher;
