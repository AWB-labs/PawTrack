/**
 * Petal — ScreenHeader.
 *
 * The large title collapses into a compact centred one as you scroll, and the
 * blurred chrome fades in underneath it. Everything is driven from the Screen's
 * `scrollY` shared value, so the whole choreography runs on the UI thread and
 * never re-renders React while you flick.
 *
 * The sequencing is deliberate:
 *
 *   0.00 → 0.55  the large title fades and lifts (the subtitle leaves slightly
 *                faster, which reads as depth rather than a single flat slab)
 *   0.02 → 0.40  the chrome fades in, still at full height, so content passing
 *                beneath never shows through the departing title
 *   0.40 → 1.00  the chrome retracts to the bar
 *   0.45 → 0.95  the compact title rises into place
 *
 * The overlaps matter more than the numbers: no frame exists where content is
 * visible through the header, and no frame exists where both titles are fully
 * opaque.
 */

import React, { useCallback, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  clamp,
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { useRouter } from 'expo-router';

import { useTheme, type TypeVariant } from '@/theme';
import { IconButton, type IconButtonVariant } from './IconButton';
import { useScreenScroll } from './Screen';
import { Row } from './Stack';
import { Text, type ColorProp } from './Text';

/* -------------------------------------------------------------------- types */

export type ScreenHeaderProps = {
  title: string;
  subtitle?: string;
  /** Collapsing large title. Off gives a plain compact bar. */
  large?: boolean;
  /** Defaults to whether the router has somewhere to go back to. */
  showBack?: boolean;
  onBack?: () => void;
  backAccessibilityLabel?: string;
  /** Replaces the back button — an avatar, a close control, a pet switcher. */
  leading?: ReactNode;
  /** Right-hand controls. Usually one or two `<IconButton/>`s. */
  actions?: ReactNode;
  /** Sits under the large title and collapses with it — search, segments, stats. */
  accessory?: ReactNode;
  /** Blur + hairline that fade in on scroll. Off for screens with their own hero. */
  chrome?: boolean;
  controlVariant?: IconButtonVariant;
  titleVariant?: TypeVariant;
  titleColor?: ColorProp;
  blurIntensity?: number;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/** Scroll distance that reveals the chrome when there's no large title to travel. */
const COMPACT_REVEAL = 16;

/* ---------------------------------------------------------------- component */

export function ScreenHeader({
  title,
  subtitle,
  large = true,
  showBack,
  onBack,
  backAccessibilityLabel = 'Go back',
  leading,
  actions,
  accessory,
  chrome = true,
  controlVariant = 'ghost',
  titleVariant,
  titleColor = 'text',
  blurIntensity = 28,
  testID,
}: ScreenHeaderProps) {
  const t = useTheme();
  const router = useRouter();
  const { scrollY, setHeaderHeight, topInset } = useScreenScroll();

  const fullHeight = useSharedValue(0);
  /** Distance over which the header collapses — the large block's own height. */
  const range = useSharedValue(large ? 0 : COMPACT_REVEAL);

  const barTotal = topInset + t.minTarget;
  const lift = t.spacing.base;
  const reduce = t.reduceMotion;

  const handleContainerLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { height } = event.nativeEvent.layout;
      fullHeight.value = height;
      setHeaderHeight(height);
    },
    [fullHeight, setHeaderHeight],
  );

  const handleLargeLayout = useCallback(
    (event: LayoutChangeEvent) => {
      range.value = Math.max(COMPACT_REVEAL, event.nativeEvent.layout.height);
    },
    [range],
  );

  const chromeStyle = useAnimatedStyle(() => {
    const c = clamp(scrollY.value / Math.max(COMPACT_REVEAL, range.value), 0, 1);
    return {
      opacity: chrome ? interpolate(c, [0.02, 0.4], [0, 1], Extrapolation.CLAMP) : 0,
      height: interpolate(
        c,
        [0.4, 1],
        [Math.max(fullHeight.value, barTotal), barTotal],
        Extrapolation.CLAMP,
      ),
    };
  });

  const largeStyle = useAnimatedStyle(() => {
    const c = clamp(scrollY.value / Math.max(COMPACT_REVEAL, range.value), 0, 1);
    return {
      opacity: interpolate(c, [0, 0.55], [1, 0], Extrapolation.CLAMP),
      transform: reduce ? [] : [{ translateY: interpolate(c, [0, 1], [0, -lift], Extrapolation.CLAMP) }],
    };
  });

  const subtitleStyle = useAnimatedStyle(() => {
    const c = clamp(scrollY.value / Math.max(COMPACT_REVEAL, range.value), 0, 1);
    return {
      opacity: interpolate(c, [0, 0.35], [1, 0], Extrapolation.CLAMP),
      // Leaves a touch faster than the title — parallax, not a flat slab.
      transform: reduce ? [] : [{ translateY: interpolate(c, [0, 1], [0, -lift * 0.4], Extrapolation.CLAMP) }],
    };
  });

  const compactStyle = useAnimatedStyle(() => {
    if (!large) return { opacity: 1, transform: [] };
    const c = clamp(scrollY.value / Math.max(COMPACT_REVEAL, range.value), 0, 1);
    return {
      opacity: interpolate(c, [0.45, 0.95], [0, 1], Extrapolation.CLAMP),
      transform: reduce
        ? []
        : [{ translateY: interpolate(c, [0.45, 0.95], [t.spacing.sm, 0], Extrapolation.CLAMP) }],
    };
  });

  const canGoBack = showBack ?? router.canGoBack();
  const handleBack = useCallback(() => {
    if (onBack) onBack();
    else router.back();
  }, [onBack, router]);

  return (
    <View
      onLayout={handleContainerLayout}
      pointerEvents="box-none"
      style={{ paddingTop: topInset }}
      testID={testID}
    >
      <Animated.View style={[styles.chrome, chromeStyle]} pointerEvents="none">
        {/* The blur is laid out at full height and clipped by the animated
            container, so it never re-renders at a new size mid-scroll. */}
        <BlurView
          intensity={blurIntensity}
          tint={t.scheme === 'dark' ? 'dark' : 'light'}
          style={StyleSheet.absoluteFill}
        />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: t.color.chrome }]} />
        <View
          style={[
            styles.hairline,
            { height: t.borderWidth.hairline, backgroundColor: t.color.chromeBorder },
          ]}
        />
      </Animated.View>

      <Row
        justify="between"
        style={{ height: t.minTarget, paddingHorizontal: t.spacing.sm }}
        gap="xs"
      >
        <Row gap="xs" style={styles.side}>
          {leading ??
            (canGoBack ? (
              <IconButton
                icon="chevron-back"
                accessibilityLabel={backAccessibilityLabel}
                onPress={handleBack}
                variant={controlVariant}
                tone="neutral"
                size="md"
              />
            ) : null)}
        </Row>
        <Row gap="xs" justify="end" style={styles.side}>
          {actions}
        </Row>
      </Row>

      {/* Compact title floats over the bar so it can be perfectly centred
          regardless of how wide the controls on either side are. */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.compact,
          { top: topInset, height: t.minTarget, paddingHorizontal: t.minTarget + t.spacing.sm },
          compactStyle,
        ]}
        // With a large title present this is a duplicate; VoiceOver reads the
        // real one below.
        accessibilityElementsHidden={large}
        importantForAccessibility={large ? 'no-hide-descendants' : 'yes'}
      >
        <Text variant="headline" color={titleColor} numberOfLines={1} align="center">
          {title}
        </Text>
      </Animated.View>

      {large ? (
        <Animated.View
          onLayout={handleLargeLayout}
          pointerEvents="box-none"
          style={[
            {
              paddingHorizontal: t.gutter,
              paddingTop: t.spacing.sm,
              paddingBottom: t.spacing.base,
              gap: t.spacing.xxs,
            },
            largeStyle,
          ]}
        >
          <Text
            variant={titleVariant ?? 'display'}
            color={titleColor}
            numberOfLines={2}
            accessibilityRole="header"
          >
            {title}
          </Text>
          {subtitle ? (
            <Animated.View style={subtitleStyle}>
              <Text variant="callout" color="textSecondary">
                {subtitle}
              </Text>
            </Animated.View>
          ) : null}
          {accessory ? <View style={{ paddingTop: t.spacing.sm }}>{accessory}</View> : null}
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chrome: { position: 'absolute', top: 0, left: 0, right: 0, overflow: 'hidden' },
  hairline: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  compact: { position: 'absolute', left: 0, right: 0, alignItems: 'center', justifyContent: 'center' },
  side: { minWidth: 0, flexShrink: 1 },
});

export default ScreenHeader;
