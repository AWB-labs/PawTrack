/**
 * Petal — Confetti.
 *
 * A celebration burst for the handful of moments that have earned one: the
 * first pet added, a week's streak, the last dose of a course. Paw prints,
 * petals and dots in brand colours, thrown from a point and pulled back down.
 *
 * Rules it keeps so it stays a treat rather than a tax:
 *
 *   · **Forty particles, hard cap.** One shared value drives the whole burst —
 *     every particle derives its own position from the same clock, so the cost
 *     is one animation, not forty.
 *   · **It cleans up after itself.** The particles unmount the moment the
 *     timeline ends; nothing lingers in the tree between celebrations.
 *   · **Reduced motion skips it entirely.** This is pure decoration. Degrading
 *     it to a fade would be worse than not showing it — the haptic and the
 *     toast already carry the message.
 *
 * Fire it globally with `confetti.fire()` (there's a `<ConfettiHost/>` at the
 * app root), or mount `<Confetti ref={…}/>` inside a card to burst locally.
 */

import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { runOnJS } from 'react-native-worklets';
import { Circle, Ellipse, G, Path, Svg } from 'react-native-svg';

import haptics from '@/lib/haptics';
import { useTheme, type Theme } from '@/theme';

/* -------------------------------------------------------------------- types */

export type ConfettiShape = 'paw' | 'petal' | 'dot';

export type ConfettiOptions = {
  /** Burst origin, in points relative to the host. Defaults to its centre. */
  origin?: { x: number; y: number };
  count?: number;
  colors?: readonly string[];
  /** Cone half-angle in radians. `Math.PI` throws in every direction. */
  spread?: number;
  /** Multiplier on how far particles travel. */
  power?: number;
  /** Fire the celebration haptic alongside. */
  haptic?: boolean;
};

export type ConfettiHandle = {
  fire: (options?: ConfettiOptions) => void;
};

export type ConfettiProps = {
  /** Default particle count. Individual bursts can ask for fewer. */
  count?: number;
  colors?: readonly string[];
  style?: StyleProp<ViewStyle>;
  ref?: Ref<ConfettiHandle>;
  testID?: string;
};

export type ConfettiHostProps = {
  count?: number;
  colors?: readonly string[];
};

type Particle = {
  shape: ConfettiShape;
  color: string;
  size: number;
  /** Travel, as a fraction of the host's smaller dimension. */
  vx: number;
  vy: number;
  spin: number;
  /** Fraction of the timeline before this particle launches. */
  delay: number;
  sway: number;
};

type Burst = {
  id: number;
  origin: { x: number; y: number };
  particles: Particle[];
  reach: number;
};

/* ---------------------------------------------------------------- constants */

/** Hard ceiling. Past this it stops reading as celebration and starts as lag. */
const MAX_PARTICLES = 40;
const DEFAULT_COUNT = 30;

/** Downward pull, as a fraction of reach over the timeline. */
const GRAVITY = 1.35;

/** Shape mix. Dots are plain views, so they carry the density cheaply. */
const SHAPES: readonly ConfettiShape[] = ['dot', 'petal', 'dot', 'paw', 'dot', 'petal'];

/** Burst length, derived from the ambient loop. */
const TIMELINE_FACTOR = 0.55;

let burstSeq = 0;
const listeners = new Set<(options?: ConfettiOptions) => void>();

/* ---------------------------------------------------------------------- api */

/**
 * Fire the app-level burst. No queueing: a celebration that arrives before the
 * host mounts is a celebration nobody was looking at.
 */
export const confetti = {
  fire(options?: ConfettiOptions): void {
    for (const listener of listeners) listener(options);
  },
};

/* ------------------------------------------------------------------ helpers */

function brandPalette(t: Theme): string[] {
  return [
    t.color.primary,
    t.color.accent,
    t.color.warning,
    t.color.species.dog.base,
    t.color.species.cat.base,
    t.color.primaryText,
  ];
}

/**
 * Deterministic-ish spread: particles are laid out around the cone by index
 * with a small pseudo-random jitter, so a burst never clumps the way pure
 * `Math.random()` does.
 */
function makeParticles(
  count: number,
  palette: readonly string[],
  spread: number,
  power: number,
  unit: number,
): Particle[] {
  const particles: Particle[] = [];
  for (let index = 0; index < count; index += 1) {
    const jitter = pseudoRandom(index);
    const t = count === 1 ? 0.5 : index / (count - 1);
    // Up and outwards: -90° ± spread.
    const angle = -Math.PI / 2 + (t - 0.5) * 2 * spread + (jitter - 0.5) * 0.3;
    const speed = (0.55 + jitter * 0.45) * power;
    particles.push({
      shape: SHAPES[index % SHAPES.length] ?? 'dot',
      color: palette[index % palette.length] ?? palette[0] ?? '#000000',
      size: unit * (0.55 + pseudoRandom(index + 7) * 0.55),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      spin: (pseudoRandom(index + 3) - 0.5) * 4,
      delay: pseudoRandom(index + 11) * 0.18,
      sway: (pseudoRandom(index + 5) - 0.5) * 0.18,
    });
  }
  return particles;
}

/** Cheap hash-based noise — stable per index, no RNG state to reset. */
function pseudoRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/* --------------------------------------------------------------- components */

export function Confetti({ count = DEFAULT_COUNT, colors, style, ref, testID }: ConfettiProps) {
  const t = useTheme();
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [burst, setBurst] = useState<Burst | null>(null);
  const progress = useSharedValue(0);

  const clear = useCallback(() => setBurst(null), []);

  const fire = useCallback(
    (options?: ConfettiOptions) => {
      // Pure decoration: the haptic and the toast already say "well done".
      if (t.reduceMotion) return;
      const { width, height } = box;
      if (width === 0 || height === 0) return;

      const reach = Math.min(width, height);
      const origin = options?.origin ?? { x: width / 2, y: height * 0.42 };
      const particles = makeParticles(
        Math.min(MAX_PARTICLES, Math.max(1, options?.count ?? count)),
        options?.colors ?? colors ?? brandPalette(t),
        options?.spread ?? Math.PI * 0.42,
        options?.power ?? 1,
        t.spacing.base,
      );

      setBurst({ id: ++burstSeq, origin, particles, reach });
      if (options?.haptic !== false) haptics.celebrate();

      progress.value = 0;
      progress.value = withTiming(
        1,
        {
          duration: t.motion.duration.ambient * TIMELINE_FACTOR,
          easing: t.motion.easing.linear,
          // Physics, not easing — the parabola below does the shaping.
          reduceMotion: ReduceMotion.Never,
        },
        (finished) => {
          'worklet';
          if (finished) runOnJS(clear)();
        },
      );
    },
    [box, clear, colors, count, progress, t],
  );

  useImperativeHandle(ref, () => ({ fire }), [fire]);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setBox((prev) =>
      Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1
        ? prev
        : { width, height },
    );
  }, []);

  return (
    <View
      onLayout={onLayout}
      pointerEvents="none"
      testID={testID}
      style={[StyleSheet.absoluteFill, { zIndex: t.zIndex.tooltip }, style]}
      // Purely decorative, and it must never steal focus mid-celebration.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {burst
        ? burst.particles.map((particle, index) => (
            <Piece
              key={`${burst.id}-${index}`}
              particle={particle}
              origin={burst.origin}
              reach={burst.reach}
              progress={progress}
            />
          ))
        : null}
    </View>
  );
}

/**
 * Mount once, at the app root. Everything else calls `confetti.fire()`.
 */
export function ConfettiHost({ count, colors }: ConfettiHostProps = {}) {
  const handle = useRef<ConfettiHandle | null>(null);

  useEffect(() => {
    const listener = (options?: ConfettiOptions) => handle.current?.fire(options);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return <Confetti ref={handle} count={count} colors={colors} />;
}

/* ------------------------------------------------------------------- piece */

function Piece({
  particle,
  origin,
  reach,
  progress,
}: {
  particle: Particle;
  origin: { x: number; y: number };
  reach: number;
  progress: SharedValue<number>;
}) {
  const { delay, vx, vy, spin, sway, size } = particle;

  const style = useAnimatedStyle(() => {
    const p = interpolate(progress.value, [delay, 1], [0, 1], Extrapolation.CLAMP);
    const x = (vx * p + sway * Math.sin(p * Math.PI * 2)) * reach;
    // Launch, then gravity takes it — the arc is what makes it feel thrown.
    const y = (vy * p + GRAVITY * p * p) * reach;
    return {
      opacity:
        interpolate(p, [0, 0.08, 0.72, 1], [0, 1, 1, 0], Extrapolation.CLAMP),
      transform: [
        { translateX: x },
        { translateY: y },
        { rotate: `${spin * p * 360}deg` },
        { scale: interpolate(p, [0, 0.14, 1], [0.4, 1, 0.85], Extrapolation.CLAMP) },
      ],
    };
  });

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          left: origin.x - size / 2,
          top: origin.y - size / 2,
          width: size,
          height: size,
        },
        style,
      ]}
    >
      <Shape shape={particle.shape} color={particle.color} size={size} />
    </Animated.View>
  );
}

const Shape = React.memo(function Shape({
  shape,
  color,
  size,
}: {
  shape: ConfettiShape;
  color: string;
  size: number;
}) {
  // Dots are the bulk of the burst, so they stay a plain view — no SVG tax.
  if (shape === 'dot') {
    return (
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
    );
  }

  if (shape === 'petal') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path d="M12 1.5c4.4 4.2 6.8 8 6.8 11.1A6.8 6.8 0 0 1 5.2 12.6C5.2 9.5 7.6 5.7 12 1.5z" fill={color} />
      </Svg>
    );
  }

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <G fill={color}>
        <Ellipse cx={12} cy={16.4} rx={6.4} ry={5.2} />
        <Circle cx={4.9} cy={10.4} r={2.6} />
        <Circle cx={9.4} cy={6.4} r={2.7} />
        <Circle cx={14.9} cy={6.4} r={2.7} />
        <Circle cx={19.2} cy={10.6} r={2.5} />
      </G>
    </Svg>
  );
});

export default ConfettiHost;
