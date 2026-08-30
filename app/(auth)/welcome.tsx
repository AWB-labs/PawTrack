/**
 * Welcome — the first thing anyone sees.
 *
 * Four pages, each making one promise rather than listing one feature. The
 * motion does three specific jobs:
 *
 *   · **Parallax gives the pages depth.** The illustration lags behind the
 *     swipe and the words run slightly ahead of it, so the two read as separate
 *     planes instead of one flat card sliding by. Both are driven from a single
 *     `scrollX` shared value on the UI thread — four pages, one animation.
 *   · **The art idles.** A slow vertical bob keeps the scene alive while
 *     somebody reads, which is the difference between an illustration and a
 *     screenshot.
 *   · **It advances itself, once.** The carousel walks forward on its own so a
 *     first-time user sees there's more than one page — and stops for good the
 *     instant they touch it, because after that they're driving.
 *
 * All three are decoration, so all three are off under reduced motion; the copy
 * and the dots still say everything the movement was saying.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useRouter } from 'expo-router';
import Animated, {
  Extrapolation,
  FadeIn,
  FadeInDown,
  ReduceMotion,
  cancelAnimation,
  interpolate,
  interpolateColor,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { AuthAtmosphere } from '@/features/auth/AuthScaffold';
import { TERMS_VERSION } from '@/features/legal/agreement';
import { toHref } from '@/lib/deeplinks';
import { usePreferences } from '@/stores/preferences';
import { useTheme } from '@/theme';
import { Button, Column, Screen, Text, Touchable } from '@/ui';
import {
  EmptyActivity,
  EmptyCaregivers,
  EmptyMedicine,
  WelcomePets,
  type IllustrationProps,
} from '@/ui/illustrations';

/* -------------------------------------------------------------------- types */

type WelcomePage = {
  key: string;
  eyebrow: string;
  headline: string;
  body: string;
  Art: React.ComponentType<IllustrationProps>;
};

/* ---------------------------------------------------------------- constants */

/**
 * Four promises, in the order they matter to someone who has just downloaded
 * this: it's all here, it tells you when, you can share it safely, and you find
 * out what happened while you were out.
 */
const PAGES: readonly WelcomePage[] = [
  {
    key: 'together',
    eyebrow: 'One place',
    headline: 'Everyone you look after, together',
    body: 'Meals, medicine and vet visits for every animal in the house — on one screen, so none of it has to live in your head.',
    Art: WelcomePets,
  },
  {
    key: 'reminders',
    eyebrow: 'Nothing missed',
    headline: 'A nudge at exactly the right moment',
    body: 'Petal knows dinner is at six and the joint tablet goes with it. You get a tap on the shoulder, not another list to check.',
    Art: EmptyMedicine,
  },
  {
    key: 'sharing',
    eyebrow: 'Shared, safely',
    headline: 'Hand over without the handover note',
    body: 'Your sitter sees the schedule for the days they’re helping and nothing else. The vet records stay yours, and access ends when the sit does.',
    Art: EmptyCaregivers,
  },
  {
    key: 'activity',
    eyebrow: 'Peace of mind',
    headline: 'Come home to the whole story',
    body: 'Every meal, dose and walk they logged while you were away, waiting for you. No group chat required.',
    Art: EmptyActivity,
  },
];

/** How far the art lags the swipe, and how far the words run ahead of it. */
const ART_PARALLAX = 0.34;
const COPY_PARALLAX = -0.12;

/** Idle bob, as a fraction of the illustration's height. */
const BOB = 0.02;

/**
 * Only the one method this screen drives. Reanimated's animated ScrollView ref
 * type isn't exported from the package root, and a structural handle is both
 * honest about what we use and immune to that changing.
 */
type Pager = { scrollTo: (options: { x: number; animated?: boolean }) => void };

/* ----------------------------------------------------------------- one page */

function Page({
  page,
  index,
  scrollX,
  width,
  artSize,
}: {
  page: WelcomePage;
  index: number;
  scrollX: SharedValue<number>;
  width: number;
  artSize: number;
}) {
  const t = useTheme();
  const bob = useSharedValue(0);

  useEffect(() => {
    if (t.reduceMotion) {
      cancelAnimation(bob);
      bob.value = 0;
      return;
    }
    bob.value = withRepeat(
      withTiming(1, {
        duration: t.motion.duration.ambient,
        easing: t.motion.easing.smooth,
        reduceMotion: ReduceMotion.System,
      }),
      -1,
      true,
    );
    return () => cancelAnimation(bob);
  }, [bob, t.motion, t.reduceMotion]);

  const range = [(index - 1) * width, index * width, (index + 1) * width];
  const still = t.reduceMotion;

  const artStyle = useAnimatedStyle(() => {
    const opacity = interpolate(scrollX.value, range, [0.2, 1, 0.2], Extrapolation.CLAMP);
    if (still) return { opacity };
    return {
      opacity,
      transform: [
        { translateX: interpolate(scrollX.value, range, [-width * ART_PARALLAX, 0, width * ART_PARALLAX]) },
        { translateY: -bob.value * artSize * BOB },
        { scale: interpolate(scrollX.value, range, [0.84, 1, 0.84], Extrapolation.CLAMP) },
        { rotate: `${interpolate(scrollX.value, range, [5, 0, -5], Extrapolation.CLAMP)}deg` },
      ],
    };
  });

  const copyStyle = useAnimatedStyle(() => {
    const opacity = interpolate(scrollX.value, range, [0, 1, 0], Extrapolation.CLAMP);
    if (still) return { opacity };
    return {
      opacity,
      transform: [
        { translateX: interpolate(scrollX.value, range, [-width * COPY_PARALLAX, 0, width * COPY_PARALLAX]) },
      ],
    };
  });

  return (
    <View style={[styles.page, { width, paddingHorizontal: t.gutter, gap: t.spacing.xl }]}>
      <Animated.View style={artStyle}>
        <page.Art size={artSize} />
      </Animated.View>

      <Animated.View style={[copyStyle, { gap: t.spacing.sm }]}>
        <Text variant="overline" color="primaryText" align="center">
          {page.eyebrow}
        </Text>
        <Text variant="title1" align="center" accessibilityRole="header">
          {page.headline}
        </Text>
        <Text variant="callout" color="textSecondary" align="center">
          {page.body}
        </Text>
      </Animated.View>
    </View>
  );
}

/* --------------------------------------------------------------------- dots */

function Dot({
  index,
  scrollX,
  width,
  active,
  onPress,
}: {
  index: number;
  scrollX: SharedValue<number>;
  width: number;
  active: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const range = [(index - 1) * width, index * width, (index + 1) * width];
  const dot = t.spacing.sm;
  const stretched = t.spacing.xxl;

  const style = useAnimatedStyle(() => ({
    width: interpolate(scrollX.value, range, [dot, stretched, dot], Extrapolation.CLAMP),
    backgroundColor: interpolateColor(
      scrollX.value,
      range,
      [t.color.borderStrong, t.color.primary, t.color.borderStrong],
    ),
  }));

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={`Page ${index + 1} of ${PAGES.length}`}
      accessibilityState={{ selected: active }}
      haptic="select"
      onPress={onPress}
      pressScale="small"
      style={styles.dotTarget}
    >
      <Animated.View style={[{ height: dot, borderRadius: t.radius.pill }, style]} />
    </Touchable>
  );
}

/* -------------------------------------------------------------------- screen */

export default function WelcomeScreen() {
  const t = useTheme();
  const router = useRouter();
  const { width, height } = useWindowDimensions();
  const markWelcomeSeen = usePreferences((s) => s.markWelcomeSeen);
  const acceptedTerms = usePreferences((s) => s.acceptedTermsVersion);

  const pagerRef = useRef<Pager | null>(null);
  const scrollX = useSharedValue(0);
  const [page, setPage] = useState(0);
  const [driving, setDriving] = useState(false);
  const pageRef = useRef(0);

  const onScroll = useAnimatedScrollHandler((event) => {
    scrollX.value = event.contentOffset.x;
  });

  const settleOn = useCallback((next: number) => {
    pageRef.current = next;
    setPage(next);
  }, []);

  const onMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      settleOn(Math.round(event.nativeEvent.contentOffset.x / width));
    },
    [settleOn, width],
  );

  const goTo = useCallback(
    (next: number) => {
      setDriving(true);
      pagerRef.current?.scrollTo({ x: next * width, animated: true });
      settleOn(next);
    },
    [settleOn, width],
  );

  // Auto-advance is a hint that there's more here, not a slideshow: it stops
  // permanently the moment the user takes over, and never starts under reduced
  // motion, where unrequested movement is exactly what was asked to stop.
  useEffect(() => {
    if (driving || t.reduceMotion) return;
    const timer = setInterval(() => {
      const next = (pageRef.current + 1) % PAGES.length;
      pagerRef.current?.scrollTo({ x: next * width, animated: true });
      settleOn(next);
    }, t.motion.duration.ambient);
    return () => clearInterval(timer);
  }, [driving, settleOn, t.motion.duration.ambient, t.reduceMotion, width]);

  /**
   * Both buttons go through the agreement first.
   *
   * Not a modal over the form and not a link under it: the App Store asks for
   * the terms to be *presented* before somebody registers or signs in, and a
   * screen you have to pass through is the only reading of that word nobody
   * argues with. Once this device has agreed to the current version it stops
   * appearing, so it costs a returning user nothing.
   */
  const leave = useCallback(
    (destination: 'sign-up' | 'sign-in') => {
      markWelcomeSeen();
      const path =
        acceptedTerms >= TERMS_VERSION ? `/${destination}` : `/agreement?next=${destination}`;
      router.push(toHref(path));
    },
    [acceptedTerms, markWelcomeSeen, router],
  );

  // Big enough to be the hero, never so big it pushes the copy off a small
  // phone — the height clamp is what keeps the four-inch case honest.
  const artSize = Math.min(width * 0.66, height * 0.3);

  return (
    <View style={[styles.flex, { backgroundColor: t.color.bg }]}>
      <AuthAtmosphere intensity={1.2} />

      <Screen padded={false} background="transparent" keyboardAvoiding={false}>
        <Animated.ScrollView
          ref={(node) => {
            pagerRef.current = node;
          }}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onScroll={onScroll}
          scrollEventThrottle={16}
          onScrollBeginDrag={() => setDriving(true)}
          onMomentumScrollEnd={onMomentumEnd}
          style={styles.flex}
        >
          {PAGES.map((item, index) => (
            <Page
              key={item.key}
              page={item}
              index={index}
              scrollX={scrollX}
              width={width}
              artSize={artSize}
            />
          ))}
        </Animated.ScrollView>

        <Animated.View
          entering={FadeIn.duration(t.motion.duration.slow).delay(t.motion.duration.base)}
          style={[styles.dots, { gap: t.spacing.xs, paddingVertical: t.spacing.lg }]}
        >
          {PAGES.map((item, index) => (
            <Dot
              key={item.key}
              index={index}
              scrollX={scrollX}
              width={width}
              active={page === index}
              onPress={() => goTo(index)}
            />
          ))}
        </Animated.View>

        <Animated.View
          entering={
            t.reduceMotion
              ? FadeIn.duration(t.motion.duration.slow)
              : FadeInDown.duration(t.motion.duration.slower)
                  .delay(t.motion.stagger.loose)
                  .easing(t.motion.easing.decelerate)
          }
          style={{ paddingHorizontal: t.gutter, paddingBottom: t.spacing.base }}
        >
          <Column gap="sm">
            <Button
              label="Create an account"
              onPress={() => leave('sign-up')}
              size="lg"
              hero
              fullWidth
              haptic="commit"
              accessibilityHint="Sets up a new Petal account."
            />
            <Button
              label="I already have one"
              onPress={() => leave('sign-in')}
              variant="ghost"
              size="md"
              fullWidth
            />
          </Column>
        </Animated.View>
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  page: { alignItems: 'center', justifyContent: 'center' },
  dots: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  dotTarget: { alignItems: 'center', justifyContent: 'center' },
});
