/**
 * Petal — GroupChip.
 *
 * A group's name, wherever it needs to be recognised in one glance: on a post
 * card, in the feed's rail, along the top of the composer.
 *
 * The one decision worth defending is how the group's accent is used. Every
 * group carries a deterministic hex (`Group.accent`) so "Golden Retrievers" is
 * the same ochre on every surface and every launch — but that hex was picked to
 * sit on a *light* ground, and painting a label in it would quietly fail
 * contrast in dark mode. So the accent is spent on a dot and a hairline tint,
 * both non-text, and the label always uses a semantic ink token. Identity
 * survives the scheme flip; legibility never depends on it.
 *
 * `groupTint()` lives here rather than in a helpers file because it exists for
 * exactly one reason — turning that stored hex into a wash — and every surface
 * that needs it is a group surface.
 */

import React, { useEffect } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  interpolateColor,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type WithSpringConfig,
} from 'react-native-reanimated';

import type { Group, GroupKind } from '@/data/types';
import { formatCount, pluralWord } from '@/lib/format';
import { spring, useTheme } from '@/theme';
import { Icon, Text, Touchable, type IconName } from '@/ui';

/* -------------------------------------------------------------------- types */

export type GroupChipSize = 'sm' | 'md';

export type GroupChipProps = {
  group: Group;
  size?: GroupChipSize;
  /** Omit for a read-only tag — it then announces as text, not a button. */
  onPress?: () => void;
  /** Filter/selection state. Fills the chip with the group's own tint. */
  selected?: boolean;
  /** Append "· 12.5k" — right for a discovery rail, noise on a post card. */
  showMembers?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/** See `@/ui/Touchable` — the theme's `springWith` helper doesn't type-check yet. */
const SELECT_SPRING: WithSpringConfig = { ...spring.snappy, reduceMotion: ReduceMotion.System };

/** Wash strength for a resting chip and a selected one. */
const TINT_REST = 0.1;
const TINT_SELECTED = 0.24;
const TINT_BORDER = 0.45;

export const GROUP_KIND_META: Record<GroupKind, { label: string; icon: IconName }> = {
  breed: { label: 'Breed', icon: 'paw-outline' },
  species: { label: 'Species', icon: 'ellipse-outline' },
  topic: { label: 'Topic', icon: 'bulb-outline' },
  local: { label: 'Nearby', icon: 'location-outline' },
};

/* ------------------------------------------------------------------ helpers */

/**
 * `#C97B1F` → `rgba(201, 123, 31, 0.24)`.
 *
 * Falls back to `'transparent'` rather than throwing: an accent is server data,
 * and a malformed one should cost a tint, not a screen.
 */
export function groupTint(accent: string, alpha: number): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(accent.trim());
  if (!match?.[1]) return 'transparent';
  const value = Number.parseInt(match[1], 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** "12.5k members" — the line under a group's name everywhere it appears. */
export function membersLabel(count: number): string {
  return `${formatCount(count)} ${pluralWord(count, 'member')}`;
}

/* ---------------------------------------------------------------- component */

export function GroupChip({
  group,
  size = 'sm',
  onPress,
  selected = false,
  showMembers = false,
  style,
  testID,
}: GroupChipProps) {
  const t = useTheme();

  const restFill = t.color.surfaceAlt;
  const restBorder = t.color.border;
  const activeFill = groupTint(group.accent, selected ? TINT_SELECTED : TINT_REST);
  const activeBorder = groupTint(group.accent, TINT_BORDER);

  const progress = useSharedValue(selected ? 1 : 0);
  useEffect(() => {
    progress.value = withSpring(selected ? 1 : 0, SELECT_SPRING);
  }, [progress, selected]);

  const skinStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [restFill, activeFill]),
    borderColor: interpolateColor(progress.value, [0, 1], [restBorder, activeBorder]),
  }));

  const dot = size === 'md' ? t.spacing.sm : t.spacing.xs;
  const label = showMembers ? `${group.name} · ${formatCount(group.memberCount)}` : group.name;
  const spoken = `${group.name}. ${membersLabel(group.memberCount)}.`;

  const body = (
    <Animated.View
      style={[
        styles.chip,
        {
          gap: t.spacing.xs,
          paddingVertical: size === 'md' ? t.spacing.sm : t.spacing.xxs,
          paddingHorizontal: size === 'md' ? t.spacing.md : t.spacing.sm,
          borderRadius: t.radius.pill,
          borderWidth: t.borderWidth.hairline,
        },
        skinStyle,
      ]}
    >
      <View
        style={{
          width: dot,
          height: dot,
          borderRadius: dot / 2,
          backgroundColor: group.accent,
        }}
      />
      <Text
        variant={size === 'md' ? 'subheadStrong' : 'captionStrong'}
        color={selected ? 'text' : 'textSecondary'}
        numberOfLines={1}
        style={styles.label}
      >
        {label}
      </Text>
      {onPress ? (
        <Icon name="chevron-forward" size="xs" color={selected ? 'textSecondary' : 'textTertiary'} />
      ) : null}
    </Animated.View>
  );

  if (!onPress) {
    return (
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={spoken}
        testID={testID}
        style={[styles.shrink, style]}
      >
        {body}
      </View>
    );
  }

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityHint={`Opens the ${group.name} group.`}
      accessibilityState={{ selected }}
      haptic="tap"
      onPress={onPress}
      pressScale="small"
      style={[styles.shrink, style]}
      testID={testID}
    >
      {body}
    </Touchable>
  );
}

/* ----------------------------------------------------------------- styles */

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' },
  // A long breed name must be allowed to ellipsis rather than push the card's
  // metadata column out of the row.
  label: { flexShrink: 1 },
  shrink: { flexShrink: 1 },
});

export default GroupChip;
