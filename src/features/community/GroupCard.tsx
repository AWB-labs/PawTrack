/**
 * Petal — GroupCard, and the join control that goes with it.
 *
 * A group is a place, so the card is built like a place: an accent wash across
 * the top with the group's paw watermarking it, then the name, then the two
 * numbers that actually decide whether you join (how many people, how much is
 * being said), then the description.
 *
 * `GroupJoinButton` is exported alongside it because joining happens in three
 * places — the discovery card, the group's own header, and the composer's group
 * rail — and a join that animates differently in each of them would read as
 * three different products. It is fully optimistic: `useToggleGroupMembership`
 * patches every cached copy of the group on mutate, so the pill fills and the
 * member count ticks before the request leaves the device, and rolls back with a
 * toast if the network disagrees.
 */

import { LinearGradient } from 'expo-linear-gradient';
import React, { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  interpolate,
  interpolateColor,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  type WithSpringConfig,
} from 'react-native-reanimated';
import Svg from 'react-native-svg';

import { useToggleGroupMembership } from '@/data/queries/useCommunity';
import type { Group } from '@/data/types';
import { formatCount, pluralWord } from '@/lib/format';
import haptics from '@/lib/haptics';
import { spring, useTheme } from '@/theme';
import { Icon, ICON_SIZE, PawGlyph, PAW_VIEWBOX, Surface, Text, Touchable } from '@/ui';
import { groupTint, GROUP_KIND_META, membersLabel } from './GroupChip';

/* -------------------------------------------------------------------- types */

export type GroupJoinButtonSize = 'sm' | 'md';

export type GroupJoinButtonProps = {
  group: Group;
  size?: GroupJoinButtonSize;
  /** Stretch to the container — the group page's header wants a full-width pill. */
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export type GroupCardProps = {
  group: Group;
  onPress?: () => void;
  /** Position in the list, for the entrance stagger. The caller caps it. */
  index?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/** See `@/ui/Touchable` — the theme's `springWith` helper doesn't type-check yet. */
const FILL_SPRING: WithSpringConfig = { ...spring.snappy, reduceMotion: ReduceMotion.System };
const POP_IN: WithSpringConfig = { ...spring.bouncy, reduceMotion: ReduceMotion.System };
const POP_OUT: WithSpringConfig = { ...spring.gentle, reduceMotion: ReduceMotion.System };

/** How far the pill overshoots when membership flips. */
const POP_SCALE = 0.12;

/** Wash strength at the top of the card and where it fades out. */
const WASH_TOP = 0.3;
const WASH_BOTTOM = 0.02;

/** Watermark paw, as a fraction of the wash band's height. */
const WATERMARK_RATIO = 1.45;
const WATERMARK_OPACITY = 0.22;

/** Entrance stagger cap — past this the list feels slow rather than alive. */
const STAGGER_CAP = 8;

/* --------------------------------------------------------------- join pill */

export function GroupJoinButton({
  group,
  size = 'md',
  fullWidth = false,
  style,
  testID,
}: GroupJoinButtonProps) {
  const t = useTheme();
  const toggle = useToggleGroupMembership();
  const joined = group.joined;

  const fill = useSharedValue(joined ? 1 : 0);
  const pop = useSharedValue(0);
  /** The first render is a state, not a change — it must not pop. */
  const settled = useRef(false);

  useEffect(() => {
    fill.value = withSpring(joined ? 1 : 0, FILL_SPRING);
    if (!settled.current) {
      settled.current = true;
      return;
    }
    pop.value = withSequence(withSpring(1, POP_IN), withSpring(0, POP_OUT));
  }, [fill, joined, pop]);

  const restFill = t.color.primary;
  const onRest = t.color.onPrimary;
  const joinedFill = t.color.primarySoft;
  const joinedBorder = t.color.primarySoftBorder;
  const onJoined = t.color.onPrimarySoft;

  const pillStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(fill.value, [0, 1], [restFill, joinedFill]),
    borderColor: interpolateColor(fill.value, [0, 1], [restFill, joinedBorder]),
    transform: [{ scale: 1 + pop.value * POP_SCALE }],
  }));

  const iconBox = ICON_SIZE[size === 'md' ? 'sm' : 'xs'];
  const checkStyle = useAnimatedStyle(() => ({
    width: interpolate(fill.value, [0, 1], [0, iconBox + t.spacing.xs]),
    opacity: fill.value,
    transform: [{ scale: 0.6 + fill.value * 0.4 }],
  }));

  const joinLabelStyle = useAnimatedStyle(() => ({ opacity: 1 - fill.value }));
  const joinedLabelStyle = useAnimatedStyle(() => ({ opacity: fill.value }));

  const onPress = useCallback(() => {
    // Leaving is quieter than joining on purpose: the tick is a reward, and a
    // reward haptic for walking out of a room is a lie.
    if (joined) haptics.tap();
    else haptics.success();
    toggle.mutate({ groupId: group.id, joined: !joined });
  }, [group.id, joined, toggle]);

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={joined ? `Leave ${group.name}` : `Join ${group.name}`}
      accessibilityHint={
        joined
          ? 'Removes this group from your feed.'
          : 'Adds this group to your feed and to your groups filter.'
      }
      accessibilityState={{ selected: joined, busy: toggle.isPending }}
      haptic="none"
      onPress={onPress}
      pressScale="medium"
      style={[fullWidth ? styles.stretch : styles.hug, style]}
      testID={testID}
    >
      <Animated.View
        style={[
          styles.pill,
          {
            gap: t.spacing.hair,
            paddingVertical: size === 'md' ? t.spacing.md : t.spacing.sm,
            paddingHorizontal: size === 'md' ? t.spacing.lg : t.spacing.base,
            borderRadius: t.radius.pill,
            borderWidth: t.borderWidth.hairline,
          },
          pillStyle,
        ]}
      >
        <Animated.View style={[styles.check, checkStyle]}>
          <Icon name="checkmark" size={size === 'md' ? 'sm' : 'xs'} color={onJoined} />
        </Animated.View>

        {/* Two inks, cross-faded: Reanimated can't tween a plain Text's colour,
            and two stacked labels are cheaper than an animated text node. */}
        <View>
          <Animated.View style={joinLabelStyle}>
            <Text variant={size === 'md' ? 'button' : 'buttonSmall'} color={onRest} numberOfLines={1}>
              Join
            </Text>
          </Animated.View>
          <Animated.View
            style={[StyleSheet.absoluteFill, styles.center, joinedLabelStyle]}
            pointerEvents="none"
            importantForAccessibility="no-hide-descendants"
          >
            <Text variant={size === 'md' ? 'button' : 'buttonSmall'} color={onJoined} numberOfLines={1}>
              Joined
            </Text>
          </Animated.View>
        </View>
      </Animated.View>
    </Touchable>
  );
}

/* ---------------------------------------------------------------- component */

export function GroupCard({ group, onPress, index = 0, style, testID }: GroupCardProps) {
  const t = useTheme();
  const kind = GROUP_KIND_META[group.kind];

  const band = t.spacing.giant;
  const watermark = band * WATERMARK_RATIO;
  const wash: readonly [string, string] = [
    groupTint(group.accent, WASH_TOP),
    groupTint(group.accent, WASH_BOTTOM),
  ];

  const delay = Math.min(index, STAGGER_CAP) * t.motion.stagger.base;
  const entering = t.reduceMotion
    ? FadeIn.duration(t.motion.duration.base).delay(delay)
    : FadeInDown.duration(t.motion.duration.slow).delay(delay).easing(t.motion.easing.decelerate);

  return (
    <Animated.View entering={entering} style={style}>
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={`${group.name}. ${kind.label}. ${membersLabel(group.memberCount)}. ${group.description}`}
        accessibilityHint={`Opens the ${group.name} group.`}
        haptic="tap"
        onPress={onPress}
        pressScale="large"
        testID={testID}
      >
        <Surface elevation={1} radius="xl" padding="none" style={styles.clip}>
          <View style={{ height: band }}>
            <LinearGradient
              colors={wash}
              start={GRADIENT_START}
              end={GRADIENT_END}
              style={StyleSheet.absoluteFill}
            />
            {/* The group's own paw, pressed into the wash. Bleeding it off the
                right edge stops it reading as a centred logo. */}
            <View style={[styles.watermark, { right: -watermark * 0.22 }]} pointerEvents="none">
              <Svg width={watermark} height={watermark} viewBox={`0 0 ${PAW_VIEWBOX} ${PAW_VIEWBOX}`}>
                <PawGlyph
                  size={PAW_VIEWBOX}
                  color={group.accent}
                  opacity={WATERMARK_OPACITY}
                  rotation={-14}
                />
              </Svg>
            </View>

            <View style={[styles.kind, { top: t.spacing.md, left: t.spacing.base, gap: t.spacing.xxs }]}>
              <Icon name={kind.icon} size="xs" color="textSecondary" />
              <Text variant="overline" color="textSecondary">
                {kind.label}
              </Text>
            </View>
          </View>

          <View style={{ padding: t.spacing.base, gap: t.spacing.xs }}>
            <Text variant="title3" numberOfLines={1}>
              {group.name}
            </Text>

            <Text variant="caption" color="textTertiary" numberOfLines={1}>
              {membersLabel(group.memberCount)} · {formatCount(group.postCount)}{' '}
              {pluralWord(group.postCount, 'post')}
            </Text>

            <Text
              variant="footnote"
              color="textSecondary"
              numberOfLines={2}
              style={{ marginTop: t.spacing.xxs }}
            >
              {group.description}
            </Text>

            <View style={[styles.actions, { paddingTop: t.spacing.sm }]}>
              <GroupJoinButton group={group} size="sm" />
            </View>
          </View>
        </Surface>
      </Touchable>
    </Animated.View>
  );
}

/* ----------------------------------------------------------------- statics */

const GRADIENT_START = { x: 0.1, y: 0 } as const;
const GRADIENT_END = { x: 0.9, y: 1 } as const;

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  pill: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  // Clipping is what turns the width tween into a slide rather than a squash.
  check: { overflow: 'hidden', flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  hug: { alignSelf: 'flex-start' },
  stretch: { alignSelf: 'stretch' },
  watermark: { position: 'absolute', top: 0, bottom: 0, justifyContent: 'center' },
  kind: { position: 'absolute', flexDirection: 'row', alignItems: 'center' },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start' },
});

export default GroupCard;
