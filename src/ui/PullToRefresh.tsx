/**
 * Petal — pull to refresh, with paws.
 *
 * The stock `RefreshControl` is a grey system spinner. It is also the single
 * most-repeated gesture in an app people open six times a day, which makes it
 * the highest-leverage twenty lines of delight in the whole product — so this
 * replaces it with a trail of paw prints that appears one print at a time as
 * you pull, springs when you've pulled far enough, and then walks in a loop
 * while the data comes back.
 *
 * How it works: a `Pan` gesture composed *simultaneously* with the scrollable's
 * own native gesture. When the list is already at the top, the pan translates
 * the whole scroll view down and reveals the indicator behind it; the native
 * gesture keeps handling everything else, so scrolling is untouched.
 *
 * Accessibility: replacing the native control loses its screen-reader refresh
 * affordance, so the indicator carries `onAccessibilityTap` — VoiceOver and
 * TalkBack users find a "Refresh" button at the top of the list.
 *
 * Reduced motion: the pull itself is finger-driven and stays (it's feedback,
 * not decoration); the walking loop is replaced by a steady, unmoving trail.
 */

import React, { useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector, type SimultaneousGesture } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  ReduceMotion,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  type AnimatedScrollViewProps,
  type FlatListPropsWithLayout,
  type SharedValue,
  type WithSpringConfig,
} from 'react-native-reanimated';
import { runOnJS } from 'react-native-worklets';
import { Circle, Ellipse, G, Svg } from 'react-native-svg';

import haptics from '@/lib/haptics';
import { spring, useTheme } from '@/theme';

/* -------------------------------------------------------------------- types */

export type PullToRefreshProps = {
  refreshing: boolean;
  onRefresh: () => void;
  /**
   * Mirror the scroll offset into a `Screen`'s shared value so a floating
   * header keeps reacting: `scrollY={useScreenScroll().scrollY}`.
   */
  scrollY?: SharedValue<number>;
  /** Clearance for a floating header sitting above the list. */
  indicatorOffset?: number;
  /** Paw colour. Defaults to the brand ink. */
  tint?: string;
  enabled?: boolean;
};

export type RefreshableScrollViewProps = Omit<AnimatedScrollViewProps, 'onScroll' | 'refreshControl'> &
  PullToRefreshProps & { children?: ReactNode };

export type RefreshableFlatListProps<ItemT> = Omit<
  FlatListPropsWithLayout<ItemT>,
  'onScroll' | 'refreshControl'
> &
  PullToRefreshProps;

type PullKit = {
  gesture: SimultaneousGesture;
  onScroll: ReturnType<typeof useAnimatedScrollHandler>;
  // `ReturnType<typeof useAnimatedStyle>` alone can't infer the generic from any
  // call site, so it resolves to the unconstrained default — which, as of
  // Reanimated 4.1.7's types, includes the react-native-web CSS transition
  // properties and no longer structurally matches a plain `ViewStyle` slot.
  // Pin it to what `containerStyle` actually is (see the `{ transform: [...] }`
  // literal below).
  containerStyle: ReturnType<typeof useAnimatedStyle<ViewStyle>>;
  indicator: ReactNode;
};

/* ---------------------------------------------------------------- constants */

/** Four prints read as a walk. Three reads as a stumble, five as a centipede. */
const PAW_COUNT = 4;

/** Phase offset between prints while the trail loops. */
const WALK_OFFSET = 0.16;

/** See Touchable: the theme's `springWith` helper doesn't type-check yet. */
const SETTLE: WithSpringConfig = { ...spring.snappy, reduceMotion: ReduceMotion.System };
const POP_IN: WithSpringConfig = { ...spring.bouncy, reduceMotion: ReduceMotion.System };
const POP_OUT: WithSpringConfig = { ...spring.gentle, reduceMotion: ReduceMotion.System };

/** How much further than the trigger point the rubber band will stretch. */
const OVERPULL = 1.9;

/** One full pass of the walking trail. */
const WALK_DIVISOR = 3;

/* ------------------------------------------------------------------- glyph */

/** A single print. Angled so a row of them reads as a path, not a ladder. */
function Paw({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <G fill={color}>
        <Ellipse cx={12} cy={16.2} rx={6.2} ry={5.1} />
        <Circle cx={4.9} cy={10.4} r={2.5} />
        <Circle cx={9.4} cy={6.3} r={2.6} />
        <Circle cx={14.9} cy={6.3} r={2.6} />
        <Circle cx={19.2} cy={10.6} r={2.4} />
      </G>
    </Svg>
  );
}

/* -------------------------------------------------------------------- hook */

function usePullToRefresh({
  refreshing,
  onRefresh,
  scrollY,
  indicatorOffset = 0,
  tint,
  enabled = true,
}: PullToRefreshProps): PullKit {
  const t = useTheme();
  const reduceMotion = t.reduceMotion;

  const pull = useSharedValue(0);
  const offset = useSharedValue(0);
  const armed = useSharedValue(0);
  const active = useSharedValue(refreshing ? 1 : 0);
  const walk = useSharedValue(0);
  const pop = useSharedValue(0);

  /** Trigger distance, resting distance, and the ceiling of the rubber band. */
  const threshold = t.spacing.giant + t.spacing.md;
  const rest = t.spacing.giant;
  const ceiling = threshold * OVERPULL;
  const pawSize = t.spacing.lg;
  const color = tint ?? t.color.primaryText;

  const onScroll = useAnimatedScrollHandler((event) => {
    offset.value = event.contentOffset.y;
    if (scrollY) scrollY.value = event.contentOffset.y;
  });

  // The bounce when you cross the trigger point, sprung so it feels physical.
  useAnimatedReaction(
    () => armed.value,
    (current, previous) => {
      if (current === 1 && previous === 0) {
        pop.value = withSequence(withSpring(1, POP_IN), withSpring(0, POP_OUT));
      }
    },
  );

  useEffect(() => {
    active.value = refreshing ? 1 : 0;
    if (refreshing) {
      pull.value = withSpring(rest, SETTLE);
      if (!reduceMotion) {
        walk.value = withRepeat(
          withTiming(1, {
            duration: t.motion.duration.ambient / WALK_DIVISOR,
            easing: t.motion.easing.linear,
            // The loop is the "still working" signal; the style drops the
            // movement under reduced motion instead of stopping the clock.
            reduceMotion: ReduceMotion.Never,
          }),
          -1,
          false,
        );
      }
      return;
    }
    cancelAnimation(walk);
    walk.value = 0;
    armed.value = 0;
    // A beat before it retracts, so the settle reads as "done", not "cancelled".
    pull.value = withDelay(t.motion.duration.fast, withSpring(0, SETTLE));
  }, [active, armed, pull, reduceMotion, refreshing, rest, t.motion, walk]);

  const gesture = useMemo(() => {
    const native = Gesture.Native();
    const pan = Gesture.Pan()
      .enabled(enabled)
      .onUpdate((event) => {
        if (active.value === 1) return;
        // Only from the very top, and only downwards.
        if (offset.value > 1 || event.translationY <= 0) {
          pull.value = 0;
          armed.value = 0;
          return;
        }
        // Exponential rubber band: generous at first, immovable at the end.
        const next = ceiling * (1 - Math.exp(-event.translationY / ceiling));
        pull.value = next;
        const nowArmed = next >= threshold ? 1 : 0;
        if (nowArmed !== armed.value) {
          armed.value = nowArmed;
          if (nowArmed === 1) runOnJS(haptics.threshold)();
        }
      })
      .onEnd(() => {
        if (active.value === 1) return;
        if (armed.value === 1) {
          armed.value = 0;
          pull.value = withSpring(rest, SETTLE);
          runOnJS(onRefresh)();
        } else {
          pull.value = withSpring(0, SETTLE);
        }
      });

    // Simultaneous, not exclusive: the list must keep scrolling normally.
    return Gesture.Simultaneous(pan, native);
  }, [active, armed, ceiling, enabled, offset, onRefresh, pull, rest, threshold]);

  const containerStyle = useAnimatedStyle(() => ({ transform: [{ translateY: pull.value }] }));

  const indicatorStyle = useAnimatedStyle(() => {
    const reveal = Math.min(1, pull.value / threshold);
    return { opacity: active.value === 1 ? 1 : reveal };
  });

  const indicator = (
    <Animated.View
      pointerEvents="none"
      // The native control's refresh action goes with it, so put it back here.
      accessible
      accessibilityRole="button"
      accessibilityLabel="Refresh"
      accessibilityHint="Reloads this list."
      accessibilityState={{ busy: refreshing }}
      onAccessibilityTap={onRefresh}
      style={[
        styles.indicator,
        { top: indicatorOffset, height: rest, gap: t.spacing.sm },
        indicatorStyle,
      ]}
    >
      {Array.from({ length: PAW_COUNT }, (_, index) => (
        <Print
          key={index}
          index={index}
          pull={pull}
          walk={walk}
          active={active}
          pop={pop}
          threshold={threshold}
          lift={t.spacing.xs}
          size={pawSize}
          color={color}
          reduceMotion={reduceMotion}
        />
      ))}
    </Animated.View>
  );

  return { gesture, onScroll, containerStyle, indicator };
}

/* -------------------------------------------------------------------- print */

function Print({
  index,
  pull,
  walk,
  active,
  pop,
  threshold,
  lift,
  size,
  color,
  reduceMotion,
}: {
  index: number;
  pull: SharedValue<number>;
  walk: SharedValue<number>;
  active: SharedValue<number>;
  pop: SharedValue<number>;
  threshold: number;
  lift: number;
  size: number;
  color: string;
  reduceMotion: boolean;
}) {
  const last = index === PAW_COUNT - 1;
  // Alternating tilt and baseline: a walk, not a row of stamps.
  const tilt = index % 2 === 0 ? -12 : 12;
  const base = index % 2 === 0 ? 0 : lift / 2;

  const style = useAnimatedStyle(() => {
    if (active.value === 1) {
      if (reduceMotion) {
        return { opacity: 1, transform: [{ translateY: base }, { scale: 1 }, { rotate: `${tilt}deg` }] };
      }
      const phase = (walk.value + 1 - index * WALK_OFFSET) % 1;
      const wave = 0.5 + 0.5 * Math.cos(2 * Math.PI * phase);
      return {
        opacity: 0.3 + 0.7 * wave,
        transform: [
          { translateY: base - wave * lift },
          { scale: 0.86 + 0.24 * wave },
          { rotate: `${tilt}deg` },
        ],
      };
    }

    // Pulling: prints appear one at a time, and the last one springs on arrival.
    const reveal = Math.min(1, pull.value / threshold);
    const local = Math.min(1, Math.max(0, reveal * PAW_COUNT - index));
    const bounce = last ? pop.value * 0.3 : 0;
    return {
      opacity: local,
      transform: [
        { translateY: base },
        { scale: 0.55 + 0.45 * local + bounce },
        { rotate: `${tilt}deg` },
      ],
    };
  }, [reduceMotion, index, tilt, base, last]);

  return (
    <Animated.View style={style}>
      <Paw size={size} color={color} />
    </Animated.View>
  );
}

/* --------------------------------------------------------------- components */

export function RefreshableScrollView({
  refreshing,
  onRefresh,
  scrollY,
  indicatorOffset,
  tint,
  enabled,
  children,
  style,
  ...rest
}: RefreshableScrollViewProps) {
  const kit = usePullToRefresh({ refreshing, onRefresh, scrollY, indicatorOffset, tint, enabled });

  return (
    <View style={styles.flex}>
      {kit.indicator}
      <GestureDetector gesture={kit.gesture}>
        <Animated.ScrollView
          {...rest}
          style={[styles.flex, style, kit.containerStyle]}
          onScroll={kit.onScroll}
          scrollEventThrottle={16}
          // The custom pull replaces the platform overscroll; two at once fight.
          bounces={false}
          overScrollMode="never"
        >
          {children}
        </Animated.ScrollView>
      </GestureDetector>
    </View>
  );
}

export function RefreshableFlatList<ItemT>({
  refreshing,
  onRefresh,
  scrollY,
  indicatorOffset,
  tint,
  enabled,
  style,
  ...rest
}: RefreshableFlatListProps<ItemT>) {
  const kit = usePullToRefresh({ refreshing, onRefresh, scrollY, indicatorOffset, tint, enabled });

  return (
    <View style={styles.flex}>
      {kit.indicator}
      <GestureDetector gesture={kit.gesture}>
        <Animated.FlatList<ItemT>
          {...rest}
          style={[styles.flex, style, kit.containerStyle]}
          onScroll={kit.onScroll}
          scrollEventThrottle={16}
          bounces={false}
          overScrollMode="never"
        />
      </GestureDetector>
    </View>
  );
}

/* ----------------------------------------------------------------- styles */

const styles = StyleSheet.create({
  flex: { flex: 1 },
  indicator: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default RefreshableScrollView;
