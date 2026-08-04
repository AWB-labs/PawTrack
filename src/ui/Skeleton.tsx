/**
 * Petal — Skeleton.
 *
 * Loading states in this app are never spinners (contract rule 5). A spinner
 * says "wait"; a skeleton says "here is the shape of what's coming", which is
 * why the perceived wait is shorter even when the real one isn't.
 *
 * Three decisions worth knowing:
 *
 *   · **One sweep, one clock.** The shimmer is a translucent band riding a
 *     single looping phase. `<SkeletonGroup>` hands that same phase to each of
 *     its children with a growing offset, so a list *ripples* top to bottom
 *     instead of strobing in unison — the difference between "loading" and
 *     "broken".
 *   · **The sweep pauses.** The band crosses in the first ~65% of the loop and
 *     rests for the remainder. A band that re-enters the instant it leaves
 *     reads as a barber's pole.
 *   · **Reduced motion keeps the loop, drops the travel.** The same phase
 *     drives a cosine opacity breath instead of a translation, so the surface
 *     still says "working" without anything sliding across the screen.
 *
 * `SkeletonText` sizes each bar against a real type variant's line height, so a
 * three-line skeleton occupies exactly the space the paragraph will.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import {
  StyleSheet,
  View,
  type DimensionValue,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  cancelAnimation,
  Extrapolation,
  interpolate,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { useTheme, type TypeVariant } from '@/theme';
import type { RadiusToken, SpacingToken } from './Stack';

/* -------------------------------------------------------------------- types */

export type SkeletonProps = {
  /** Width. Defaults to filling the row — the common case for text bars. */
  w?: DimensionValue;
  /** Height. Percentages are allowed so a bar can stretch inside a sized box. */
  h?: DimensionValue;
  r?: RadiusToken | number;
  /** Drops the fill to the muted step, for secondary lines inside a block. */
  dim?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export type SkeletonTextProps = {
  lines?: number;
  /** Match the variant the real copy uses so the block reserves the right height. */
  variant?: TypeVariant;
  gap?: SpacingToken | number;
  /** Fraction of the width for the final line — real paragraphs don't end flush. */
  lastLineWidth?: number;
  width?: DimensionValue;
  dim?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export type SkeletonCircleProps = {
  size: number;
  dim?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export type SkeletonGroupProps = {
  children: ReactNode;
  /**
   * Announced to screen readers while the real content loads. One announcement
   * for the whole block — the individual bars are hidden.
   */
  label?: string;
  gap?: SpacingToken | number;
  /**
   * Extra phase delay per child, as a fraction of one sweep. Defaults to the
   * motion system's loose stagger.
   */
  stagger?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** Shared sweep clock plus this subtree's place in the ripple. */
type Ripple = { phase: SharedValue<number>; offset: number };

/* ---------------------------------------------------------------- constants */

/** Band width as a fraction of the element — wide enough to read as light. */
const BAND_RATIO = 0.85;

/** The sweep finishes here; the rest of the loop is deliberate rest. */
const SWEEP_PORTION = 0.65;

/** A breath is roughly half the pace of a sweep — calmer, less insistent. */
const PULSE_FACTOR = 2;

/** Floor of the reduced-motion opacity breath. Never fades to nothing. */
const PULSE_FLOOR = 0.45;

/** Bars sit shorter than their line box; a full-height bar reads as a block. */
const TEXT_BAR_RATIO = 0.6;

/** Cap the ripple so item 30 isn't a full cycle behind item 1 (contract). */
const MAX_RIPPLE_STEPS = 8;

/** Deterministic width variance so a paragraph looks written, not generated. */
const LINE_WIDTHS = [1, 0.96, 1, 0.92, 0.98] as const;

const RippleContext = createContext<Ripple | null>(null);

/* ------------------------------------------------------------------ helpers */

/**
 * The transparent end-stops of the sheen. Fading to the literal `transparent`
 * keyword fades through *black* on Android, which puts a grey bruise in the
 * middle of every skeleton; matching the sheen's own channels avoids it.
 */
function fadeOut(color: string): string {
  const rgba = /^rgba?\(([^)]+)\)$/i.exec(color);
  if (!rgba?.[1]) return 'transparent';
  const [r, g, b] = rgba[1].split(',');
  return r && g && b ? `rgba(${r.trim()},${g.trim()},${b.trim()},0)` : 'transparent';
}

/**
 * Subscribe to the group's sweep, or run a private one when there's no group
 * above. Both shared values always exist — hooks can't be conditional — but
 * only the unparented loop is ever started.
 */
function useSweep(): Ripple {
  const t = useTheme();
  const group = useContext(RippleContext);
  const own = useSharedValue(0);

  useEffect(() => {
    if (group) return;
    own.value = withRepeat(
      withTiming(1, {
        duration: t.reduceMotion ? t.motion.duration.shimmer * PULSE_FACTOR : t.motion.duration.shimmer,
        easing: t.motion.easing.linear,
        // Deliberate: this loop *is* the reduced-motion affordance. Handing it
        // ReduceMotion.System would collapse the timing to zero and spin.
        reduceMotion: ReduceMotion.Never,
      }),
      -1,
      false,
    );
    return () => cancelAnimation(own);
  }, [group, own, t.motion, t.reduceMotion]);

  return group ?? { phase: own, offset: 0 };
}

/* --------------------------------------------------------------- components */

export function Skeleton({ w = '100%', h, r = 'sm', dim = false, style, testID }: SkeletonProps) {
  const t = useTheme();
  const { phase, offset } = useSweep();
  const width = useSharedValue(0);

  const reduceMotion = t.reduceMotion;
  const height = h ?? t.spacing.md;
  const radius = typeof r === 'number' ? r : t.radius[r];
  const rest = dim ? t.opacity.muted : 1;

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      width.value = event.nativeEvent.layout.width;
    },
    [width],
  );

  const boxStyle = useAnimatedStyle(() => {
    if (!reduceMotion) return { opacity: rest };
    const p = (phase.value + 1 - offset) % 1;
    // Cosine keeps the breath seamless — no visible restart at the wrap point.
    const wave = 0.5 + 0.5 * Math.cos(2 * Math.PI * p);
    return { opacity: rest * (PULSE_FLOOR + (1 - PULSE_FLOOR) * wave) };
  }, [reduceMotion, rest, offset]);

  const sheenStyle = useAnimatedStyle(() => {
    const box = width.value;
    if (reduceMotion || box === 0) return { width: 0, opacity: 0, transform: [{ translateX: 0 }] };
    const band = box * BAND_RATIO;
    const p = (phase.value + 1 - offset) % 1;
    return {
      width: band,
      opacity: 1,
      transform: [
        { translateX: interpolate(p, [0, SWEEP_PORTION, 1], [-band, box, box], Extrapolation.CLAMP) },
      ],
    };
  }, [reduceMotion, offset]);

  const sheen = t.color.skeletonSheen;
  const edge = useMemo(() => fadeOut(sheen), [sheen]);

  return (
    <Animated.View
      onLayout={onLayout}
      testID={testID}
      // The group above announces "loading"; every bar inside is decoration.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          width: w,
          height,
          borderRadius: radius,
          backgroundColor: t.color.skeleton,
          overflow: 'hidden',
        },
        boxStyle,
        style,
      ]}
    >
      <Animated.View style={[styles.band, sheenStyle]} pointerEvents="none">
        <LinearGradient
          colors={[edge, sheen, edge]}
          locations={[0, 0.5, 1]}
          start={GRADIENT_START}
          end={GRADIENT_END}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </Animated.View>
  );
}

export function SkeletonText({
  lines = 3,
  variant = 'body',
  gap,
  lastLineWidth = 0.62,
  width = '100%',
  dim = false,
  style,
  testID,
}: SkeletonTextProps) {
  const t = useTheme();
  const spec = t.type[variant];
  const lineBox = spec.lineHeight ?? (spec.fontSize ?? t.spacing.base) * 1.4;
  const bar = Math.round(lineBox * TEXT_BAR_RATIO);
  const gapPx = gap === undefined ? t.spacing.xs : typeof gap === 'number' ? gap : t.spacing[gap];
  const count = Math.max(1, lines);

  return (
    <View style={[{ width, gap: gapPx }, style]} testID={testID}>
      {Array.from({ length: count }, (_, index) => {
        const isLast = index === count - 1;
        const factor = isLast && count > 1 ? lastLineWidth : (LINE_WIDTHS[index % LINE_WIDTHS.length] ?? 1);
        return (
          // The row keeps the real line box so the block reserves true height,
          // while the bar inside sits at text weight rather than filling it.
          <View key={index} style={[styles.line, { height: lineBox }]}>
            <Skeleton w={`${Math.round(factor * 100)}%`} h={bar} r="xs" dim={dim} />
          </View>
        );
      })}
    </View>
  );
}

export function SkeletonCircle({ size, dim = false, style, testID }: SkeletonCircleProps) {
  return <Skeleton w={size} h={size} r={size / 2} dim={dim} style={style} testID={testID} />;
}

export function SkeletonGroup({
  children,
  label = 'Loading',
  gap,
  stagger,
  style,
  testID,
}: SkeletonGroupProps) {
  const t = useTheme();
  const parent = useContext(RippleContext);
  const own = useSharedValue(0);

  useEffect(() => {
    if (parent) return;
    own.value = withRepeat(
      withTiming(1, {
        duration: t.reduceMotion ? t.motion.duration.shimmer * PULSE_FACTOR : t.motion.duration.shimmer,
        easing: t.motion.easing.linear,
        reduceMotion: ReduceMotion.Never,
      }),
      -1,
      false,
    );
    return () => cancelAnimation(own);
  }, [own, parent, t.motion, t.reduceMotion]);

  const phase = parent?.phase ?? own;
  const base = parent?.offset ?? 0;
  const step = stagger ?? t.motion.stagger.loose / t.motion.duration.shimmer;
  const gapPx = gap === undefined ? undefined : typeof gap === 'number' ? gap : t.spacing[gap];

  const items = React.Children.toArray(children);

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityState={BUSY}
      testID={testID}
      style={[gapPx === undefined ? null : { gap: gapPx }, style]}
    >
      {items.map((child, index) => (
        <RippleProvider
          key={index}
          phase={phase}
          offset={base + Math.min(index, MAX_RIPPLE_STEPS) * step}
        >
          {child}
        </RippleProvider>
      ))}
    </View>
  );
}

/** Memoised so a re-render of the group doesn't rebuild every child's context. */
function RippleProvider({
  phase,
  offset,
  children,
}: {
  phase: SharedValue<number>;
  offset: number;
  children: ReactNode;
}) {
  const value = useMemo<Ripple>(() => ({ phase, offset }), [phase, offset]);
  return <RippleContext.Provider value={value}>{children}</RippleContext.Provider>;
}

/* ----------------------------------------------------------------- statics */

const BUSY = { busy: true } as const;
const GRADIENT_START = { x: 0, y: 0 } as const;
const GRADIENT_END = { x: 1, y: 0 } as const;

const styles = StyleSheet.create({
  band: { position: 'absolute', top: 0, bottom: 0, left: 0 },
  line: { justifyContent: 'center' },
});

export default Skeleton;
