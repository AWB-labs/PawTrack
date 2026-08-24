/**
 * Petal — auth screen shell.
 *
 * Every signed-out screen shares this so the whole entrance feels like one
 * place rather than four forms that happen to be adjacent.
 *
 * Three things it owns:
 *
 *   · **The atmosphere.** Three soft colour masses drifting behind the content,
 *     built from `expo-linear-gradient` inside rounded views rather than a blur
 *     — a real blur over a full screen costs frames on Android for an effect
 *     nobody consciously notices. Each mass is one shared value and one
 *     transform, so the whole background is three animations, not thirty.
 *   · **The rhythm.** Brand mark, eyebrow, title, subtitle, content, footer —
 *     always in that order, always with the same gaps, arriving one beat apart
 *     so the eye is led down the screen instead of shown everything at once.
 *   · **The keyboard.** `Screen` already avoids it; what's added here is that
 *     the content scrolls rather than compresses, so a small phone with a large
 *     type size never squeezes the title into two lines of nothing.
 *
 * The drift is decorative, so under reduced motion it stops entirely and the
 * masses simply fade in — the colour is the point, the movement is a bonus.
 */

import React, { useEffect, type ReactNode } from 'react';
import { StyleSheet, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import Animated, {
  FadeIn,
  FadeInDown,
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useTheme, type Theme } from '@/theme';
import { Column, IconButton, PawPrint, Row, Screen, Text } from '@/ui';

/* -------------------------------------------------------------------- types */

export type AuthScaffoldProps = {
  children?: ReactNode;
  /** Small label above the title — "Step two", "Welcome back". */
  eyebrow?: string;
  title: string;
  subtitle?: string;
  /** Defaults to whether the router has anywhere to go back to. */
  showBack?: boolean;
  onBack?: () => void;
  backLabel?: string;
  /** Right of the back control — a "Sign in" shortcut, a help affordance. */
  headerAction?: ReactNode;
  /** Pinned to the bottom of the scroll area, below a flexible gap. */
  footer?: ReactNode;
  /** Drop the paw mark on screens that already carry a hero. */
  brand?: boolean;
  /** Centre the title block — used by the single-purpose screens. */
  centerTitle?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
};

export type BrandMarkProps = {
  /** Edge length of the tile. Defaults to a comfortable auth-header size. */
  size?: number;
  /** Set the wordmark beside the tile. */
  wordmark?: boolean;
  style?: StyleProp<ViewStyle>;
};

export type AuthAtmosphereProps = {
  /** Dials the whole field up or down — the welcome screen runs it warmer. */
  intensity?: number;
};

type BlobSpec = {
  color: string;
  /** Diameter and position as fractions of the window's width/height. */
  size: number;
  x: number;
  y: number;
  driftX: number;
  driftY: number;
  /** Multiplier on `duration.ambient` — different paces stop them pulsing in sync. */
  pace: number;
  delay: number;
};

/* ---------------------------------------------------------------- constants */

/** The mass loses this much scale at the far end of its drift. */
const BREATH = 0.08;

/** Enough colour to feel warm, never enough to fight the text on top of it. */
const BASE_OPACITY = 0.9;

/* --------------------------------------------------------------- atmosphere */

function blobsFor(t: Theme): BlobSpec[] {
  return [
    { color: t.color.primarySoft, size: 1.15, x: -0.32, y: -0.12, driftX: 0.06, driftY: 0.04, pace: 1, delay: 0 },
    { color: t.color.accentSoft, size: 0.95, x: 0.52, y: 0.16, driftX: -0.05, driftY: 0.07, pace: 1.35, delay: 400 },
    { color: t.color.infoSoft, size: 1.05, x: -0.12, y: 0.62, driftX: 0.07, driftY: -0.05, pace: 1.7, delay: 800 },
  ];
}

function Blob({ spec, intensity }: { spec: BlobSpec; intensity: number }) {
  const t = useTheme();
  const { width, height } = useWindowDimensions();
  const drift = useSharedValue(0);
  const fade = useSharedValue(0);

  useEffect(() => {
    fade.value = withDelay(spec.delay, withTiming(1, t.motion.timing(t.motion.duration.slower, 'decelerate')));
  }, [fade, spec.delay, t.motion]);

  useEffect(() => {
    if (t.reduceMotion) {
      cancelAnimation(drift);
      drift.value = 0;
      return;
    }
    drift.value = withDelay(
      spec.delay,
      withRepeat(
        withTiming(1, {
          duration: t.motion.duration.ambient * spec.pace,
          easing: t.motion.easing.smooth,
          reduceMotion: ReduceMotion.System,
        }),
        -1,
        true,
      ),
    );
    return () => cancelAnimation(drift);
  }, [drift, spec.delay, spec.pace, t.motion, t.reduceMotion]);

  const diameter = width * spec.size;

  const style = useAnimatedStyle(() => ({
    opacity: fade.value * BASE_OPACITY * intensity,
    transform: [
      { translateX: drift.value * width * spec.driftX },
      { translateY: drift.value * height * spec.driftY },
      { scale: 1 - BREATH / 2 + drift.value * BREATH },
    ],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: 'absolute',
          left: width * spec.x,
          top: height * spec.y,
          width: diameter,
          height: diameter,
          borderRadius: diameter / 2,
        },
        style,
      ]}
    >
      <LinearGradient
        colors={[spec.color, 'transparent']}
        start={ATMOSPHERE_START}
        end={ATMOSPHERE_END}
        style={[StyleSheet.absoluteFill, { borderRadius: diameter / 2 }]}
      />
    </Animated.View>
  );
}

/**
 * The drifting colour field behind every auth screen. Exported because the
 * welcome carousel draws its own layout on top of the same background and the
 * two must not diverge.
 */
export function AuthAtmosphere({ intensity = 1 }: AuthAtmosphereProps) {
  const t = useTheme();
  const wash: readonly [string, string, string] = [t.color.bg, t.color.bg, t.color.bgSunken];

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <LinearGradient colors={wash} start={WASH_START} end={WASH_END} style={StyleSheet.absoluteFill} />
      {blobsFor(t).map((spec) => (
        <Blob key={spec.color} spec={spec} intensity={intensity} />
      ))}
    </View>
  );
}

/* --------------------------------------------------------------- brand mark */

/**
 * The paw tile. It breathes very slightly — one percent of scale over four
 * seconds — which is below the threshold of "that's animating" and above the
 * threshold of "this screen is alive".
 */
export function BrandMark({ size, wordmark = true, style }: BrandMarkProps) {
  const t = useTheme();
  const tile = size ?? t.spacing.huge;
  const breath = useSharedValue(0);

  useEffect(() => {
    if (t.reduceMotion) {
      cancelAnimation(breath);
      breath.value = 0;
      return;
    }
    breath.value = withRepeat(
      withTiming(1, {
        duration: t.motion.duration.ambient,
        easing: t.motion.easing.smooth,
        reduceMotion: ReduceMotion.System,
      }),
      -1,
      true,
    );
    return () => cancelAnimation(breath);
  }, [breath, t.motion, t.reduceMotion]);

  const breatheStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + breath.value * 0.03 }, { rotate: `${-2 + breath.value * 4}deg` }],
  }));

  const brandWash: readonly [string, string] = [t.color.primary, t.color.primaryHover];

  return (
    <Row gap="md" style={style} accessible accessibilityRole="header" accessibilityLabel="Furry Tracker">
      <Animated.View
        style={[
          t.elevation(2),
          t.glow(t.color.primary),
          { width: tile, height: tile, borderRadius: t.radius.xl },
          breatheStyle,
        ]}
      >
        <LinearGradient
          colors={brandWash}
          start={BRAND_START}
          end={BRAND_END}
          style={[StyleSheet.absoluteFill, styles.center, { borderRadius: t.radius.xl }]}
        >
          <PawPrint size={tile * 0.52} color={t.color.onPrimary} />
        </LinearGradient>
      </Animated.View>

      {wordmark ? (
        <Text variant="title1" color="text">
          Furry Tracker
        </Text>
      ) : null}
    </Row>
  );
}

/* ---------------------------------------------------------------- component */

export function AuthScaffold({
  children,
  eyebrow,
  title,
  subtitle,
  showBack,
  onBack,
  backLabel = 'Go back',
  headerAction,
  footer,
  brand = true,
  centerTitle = false,
  contentStyle,
  testID,
}: AuthScaffoldProps) {
  const t = useTheme();
  const router = useRouter();

  const canGoBack = router.canGoBack();
  const backVisible = showBack ?? canGoBack;

  const handleBack = () => {
    if (onBack) {
      onBack();
      return;
    }
    if (canGoBack) router.back();
  };

  // Each block lands one stagger step after the one above it, so the screen
  // reads top-to-bottom rather than appearing all at once.
  const enter = (index: number) =>
    t.reduceMotion
      ? FadeIn.duration(t.motion.duration.base).delay(index * t.motion.stagger.tight)
      : FadeInDown.duration(t.motion.duration.slow)
          .delay(index * t.motion.stagger.base)
          .easing(t.motion.easing.decelerate);

  const align = centerTitle ? 'center' : 'start';

  return (
    <View style={[styles.flex, { backgroundColor: t.color.bg }]} testID={testID}>
      <AuthAtmosphere />

      <Screen scroll background="transparent" contentContainerStyle={[{ gap: t.spacing.xl }, contentStyle]}>
        {backVisible || headerAction ? (
          <Row justify="between" style={{ marginTop: t.spacing.sm }}>
            {backVisible ? (
              <IconButton
                icon="chevron-back"
                accessibilityLabel={backLabel}
                variant="tonal"
                tone="neutral"
                onPress={handleBack}
              />
            ) : (
              <View />
            )}
            {headerAction ?? null}
          </Row>
        ) : null}

        <Column gap="lg" align={align}>
          {brand ? (
            <Animated.View entering={enter(0)}>
              <BrandMark />
            </Animated.View>
          ) : null}

          <Animated.View entering={enter(1)} style={{ gap: t.spacing.sm, alignSelf: 'stretch' }}>
            {eyebrow ? (
              <Text variant="overline" color="primaryText" align={centerTitle ? 'center' : 'auto'}>
                {eyebrow}
              </Text>
            ) : null}
            <Text variant="display" accessibilityRole="header" align={centerTitle ? 'center' : 'auto'}>
              {title}
            </Text>
            {subtitle ? (
              <Text variant="callout" color="textSecondary" align={centerTitle ? 'center' : 'auto'}>
                {subtitle}
              </Text>
            ) : null}
          </Animated.View>
        </Column>

        <Animated.View entering={enter(2)} style={styles.flexGrow}>
          {children}
        </Animated.View>

        {footer ? (
          <Animated.View entering={enter(3)} style={{ paddingBottom: t.spacing.sm }}>
            {footer}
          </Animated.View>
        ) : null}
      </Screen>
    </View>
  );
}

/* ----------------------------------------------------------------- statics */

const WASH_START = { x: 0, y: 0 } as const;
const WASH_END = { x: 0.6, y: 1 } as const;
const ATMOSPHERE_START = { x: 0.25, y: 0 } as const;
const ATMOSPHERE_END = { x: 0.85, y: 1 } as const;
const BRAND_START = { x: 0, y: 0 } as const;
const BRAND_END = { x: 1, y: 1 } as const;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  flexGrow: { flexGrow: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
});

export default AuthScaffold;
