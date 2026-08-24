/**
 * Settings — Appearance.
 *
 * The signature of this screen is the preview, and the preview is not a
 * screenshot: it is a real miniature pet card drawn from the *two* palettes at
 * once and interpolated between them by a spring. Picking a theme applies it to
 * the whole app instantly (the provider reads the same store), but the card
 * takes a beat to travel — so you watch the colour move rather than watching
 * the screen blink.
 *
 * Three decisions behind that:
 *
 *   · **Both palettes are read directly.** `lightPalette` and `darkPalette` are
 *     the same objects the theme resolves from, so the preview can never drift
 *     from the real thing the way a hand-picked pair of hex values would.
 *   · **It shows their pet, not a stock one.** A preview of *Biscuit's* dinner
 *     is worth reading; a grey rectangle isn't. With no pets on the account yet
 *     it falls back to a sample and says so on the badge.
 *   · **Colour springs, geometry doesn't.** The recolour is a cross-fade and is
 *     safe under reduced motion; the little settle the card does on top of it is
 *     decoration, so that is what gets dropped.
 */

import React, { useCallback, useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  ReduceMotion,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
  type WithSpringConfig,
} from 'react-native-reanimated';

import { usePets } from '@/data/queries/usePets';
import { SPECIES_META } from '@/data/types';
import { SettingsGroup } from '@/features/settings/SettingsGroup';
import { SettingsRow } from '@/features/settings/SettingsRow';
import { initials, possessive } from '@/lib/format';
import haptics from '@/lib/haptics';
import { usePreferences, type ThemePreference, type WeightUnit } from '@/stores/preferences';
import { darkPalette, lightPalette, spring, useTheme, type SpeciesKey } from '@/theme';
import {
  Badge,
  Column,
  Icon,
  Row,
  Screen,
  ScreenHeader,
  SegmentedControl,
  Skeleton,
  SkeletonCircle,
  SkeletonGroup,
  Surface,
  Text,
  type Segment,
} from '@/ui';
import { AnimatedText } from '@/ui/FormField';

/* ---------------------------------------------------------------- constants */

/** See `Touchable` — the theme's `springWith` helper doesn't type-check yet. */
const RECOLOUR_SPRING: WithSpringConfig = { ...spring.gentle, reduceMotion: ReduceMotion.System };
const SETTLE_SPRING: WithSpringConfig = { ...spring.snappy, reduceMotion: ReduceMotion.System };

/** How far the card lifts as the new palette lands. Barely there, on purpose. */
const SETTLE_LIFT = 0.02;

const THEME_SEGMENTS: Segment<ThemePreference>[] = [
  { value: 'system', label: 'System', icon: 'phone-portrait-outline', accessibilityLabel: 'Match my phone' },
  { value: 'light', label: 'Light', icon: 'sunny-outline', accessibilityLabel: 'Always light' },
  { value: 'dark', label: 'Dark', icon: 'moon-outline', accessibilityLabel: 'Always dark' },
];

const UNIT_SEGMENTS: Segment<WeightUnit>[] = [
  { value: 'kg', label: 'Kilograms' },
  { value: 'lb', label: 'Pounds' },
];

const THEME_FOOTNOTE: Record<ThemePreference, string> = {
  system: 'Furry Tracker turns dark whenever your phone does, and back again in the morning.',
  light: 'Warm paper and moss green, whatever your phone is doing.',
  dark: 'A warm near-black rather than a hard one — kinder at 3am, when the doses tend to be.',
};

/** The stand-in when there is no pet on the account yet. */
const SAMPLE = { name: 'Biscuit', species: 'dog' as SpeciesKey };

/* ---------------------------------------------------------------- component */

export default function AppearanceScreen() {
  const t = useTheme();

  const theme = usePreferences((s) => s.theme);
  const setTheme = usePreferences((s) => s.setTheme);
  const weightUnit = usePreferences((s) => s.weightUnit);
  const setWeightUnit = usePreferences((s) => s.setWeightUnit);
  const hapticsOn = usePreferences((s) => s.haptics);
  const setHaptics = usePreferences((s) => s.setHaptics);
  const appReduceMotion = usePreferences((s) => s.reduceMotion);
  const setReduceMotion = usePreferences((s) => s.setReduceMotion);

  const petsQuery = usePets();
  const pet = petsQuery.data?.[0];

  /**
   * The OS switch and the in-app one both feed `t.reduceMotion`. When the phone
   * is already asking for stillness, saying so is more use than a switch that
   * looks like it does nothing.
   */
  const osReduceMotion = t.reduceMotion && !appReduceMotion;

  const handleTheme = useCallback(
    (next: ThemePreference) => {
      setTheme(next);
    },
    [setTheme],
  );

  const handleHaptics = useCallback(
    (next: boolean) => {
      setHaptics(next);
      // The preference is read at call time, so this lands only when it's on —
      // which makes it a demonstration rather than a notification.
      if (next) haptics.success();
    },
    [setHaptics],
  );

  const handleReduceMotion = useCallback(
    (next: boolean) => {
      setReduceMotion(next);
      haptics.select();
    },
    [setReduceMotion],
  );

  const enter = useCallback(
    (index: number) =>
      t.reduceMotion
        ? FadeIn.duration(t.motion.duration.base).delay(index * t.motion.stagger.tight)
        : FadeInDown.duration(t.motion.duration.slow)
            .delay(index * t.motion.stagger.base)
            .easing(t.motion.easing.decelerate),
    [t.motion, t.reduceMotion],
  );

  const header = (
    <ScreenHeader
      title="Appearance"
      subtitle="How Furry Tracker looks in your hand, and how much it moves while you use it."
    />
  );

  return (
    <Screen
      header={header}
      scroll
      contentContainerStyle={{ gap: t.spacing.xl, paddingBottom: t.spacing.xxl }}
    >
      <Animated.View entering={enter(0)}>
        {petsQuery.isPending ? (
          <PreviewSkeleton />
        ) : (
          <ThemePreview
            petName={pet?.name ?? SAMPLE.name}
            species={pet?.species ?? SAMPLE.species}
            isSample={pet === undefined}
          />
        )}
      </Animated.View>

      <Animated.View entering={enter(1)}>
        <SettingsGroup title="Theme" icon="contrast-outline" animate={false} footer={THEME_FOOTNOTE[theme]}>
          <View style={{ padding: t.spacing.md }}>
            <SegmentedControl
              segments={THEME_SEGMENTS}
              value={theme}
              onChange={handleTheme}
              accessibilityLabel="Theme"
            />
          </View>
        </SettingsGroup>
      </Animated.View>

      <Animated.View entering={enter(2)}>
        <SettingsGroup
          title="Weight"
          icon="barbell-outline"
          animate={false}
          footer="Every weight is stored in kilograms, so switching here only changes what you read — never what’s on record."
        >
          <View style={{ padding: t.spacing.md }}>
            <SegmentedControl
              segments={UNIT_SEGMENTS}
              value={weightUnit}
              onChange={setWeightUnit}
              accessibilityLabel="Weight unit"
            />
          </View>
        </SettingsGroup>
      </Animated.View>

      <Animated.View entering={enter(3)}>
        <SettingsGroup
          title="Feel"
          icon="pulse-outline"
          animate={false}
          footer={
            osReduceMotion
              ? 'Your phone’s own Reduce Motion is on, so Furry Tracker is already keeping still. This switch stays here for when you turn that off.'
              : 'Reducing motion keeps every arrival and dismissal, it just fades them instead of sliding them. Nothing is hidden from you.'
          }
        >
          <SettingsRow
            icon="pulse-outline"
            tone="accent"
            title="Haptics"
            subtitle="A tick when you log a meal, a thud when something is deleted"
            checked={hapticsOn}
            onCheckedChange={handleHaptics}
            accessibilityHint="Turns Furry Tracker’s vibration feedback on or off."
          />
          <SettingsRow
            icon="accessibility-outline"
            tone="info"
            title="Reduce motion"
            subtitle={
              osReduceMotion
                ? 'Already on because your phone asked for it'
                : 'Fade things in instead of sliding them'
            }
            checked={appReduceMotion}
            onCheckedChange={handleReduceMotion}
            accessibilityHint="Swaps Furry Tracker’s decorative movement for a plain fade."
          />
        </SettingsGroup>
      </Animated.View>
    </Screen>
  );
}

/* ------------------------------------------------------------------ preview */

type ThemePreviewProps = {
  petName: string;
  species: SpeciesKey;
  /** True when there's no pet yet and the card is showing a stand-in. */
  isSample: boolean;
};

/**
 * A pet card drawn twice over: every colour is an interpolation between the
 * light and dark palettes, driven by one shared value. Nothing here reads
 * `t.color`, which is the point — the card must be able to show a scheme the
 * app isn't currently in for the duration of the spring.
 */
function ThemePreview({ petName, species, isSample }: ThemePreviewProps) {
  const t = useTheme();
  const dark = t.scheme === 'dark';

  const tone = useSharedValue(dark ? 1 : 0);
  const settle = useSharedValue(0);
  const reduce = t.reduceMotion;

  useEffect(() => {
    tone.value = withSpring(dark ? 1 : 0, RECOLOUR_SPRING);
    if (reduce) return;
    // A single beat of lift as the new palette lands — the card acknowledges
    // the change rather than simply having changed. Set, then settle: the
    // spring picks up from wherever an interrupted one left off.
    settle.value = 1;
    settle.value = withSpring(0, SETTLE_SPRING);
  }, [dark, reduce, settle, tone]);

  const identity = useMemo(
    () => ({
      tint: [lightPalette.species[species].tint, darkPalette.species[species].tint] as const,
      base: [lightPalette.species[species].base, darkPalette.species[species].base] as const,
    }),
    [species],
  );

  const groundStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(tone.value, [0, 1], [lightPalette.bg, darkPalette.bg]),
    borderColor: interpolateColor(tone.value, [0, 1], [lightPalette.border, darkPalette.border]),
  }));

  const cardStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(tone.value, [0, 1], [lightPalette.surface, darkPalette.surface]),
    borderColor: interpolateColor(tone.value, [0, 1], [lightPalette.border, darkPalette.border]),
    transform: [{ scale: 1 + settle.value * SETTLE_LIFT }],
  }));

  const discStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(tone.value, [0, 1], [identity.tint[0], identity.tint[1]]),
  }));

  const initialStyle = useAnimatedStyle(() => ({
    color: interpolateColor(tone.value, [0, 1], [identity.base[0], identity.base[1]]),
  }));

  const titleStyle = useAnimatedStyle(() => ({
    color: interpolateColor(tone.value, [0, 1], [lightPalette.text, darkPalette.text]),
  }));

  const captionStyle = useAnimatedStyle(() => ({
    color: interpolateColor(tone.value, [0, 1], [lightPalette.textTertiary, darkPalette.textTertiary]),
  }));

  const pillStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      tone.value,
      [0, 1],
      [lightPalette.primarySoft, darkPalette.primarySoft],
    ),
  }));

  const pillInkStyle = useAnimatedStyle(() => ({
    color: interpolateColor(
      tone.value,
      [0, 1],
      [lightPalette.onPrimarySoft, darkPalette.onPrimarySoft],
    ),
  }));

  const trackStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      tone.value,
      [0, 1],
      [lightPalette.surfaceAlt, darkPalette.surfaceAlt],
    ),
  }));

  const fillStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(tone.value, [0, 1], [lightPalette.primary, darkPalette.primary]),
  }));

  const disc = t.spacing.xxxl;
  const bar = t.spacing.xs;

  const label = `Preview of ${possessive(petName)} card in ${dark ? 'dark' : 'light'} colours.`;

  return (
    <Surface variant="surfaceAlt" radius="xxl" padding="md" elevation={0} border>
      <View accessible accessibilityRole="image" accessibilityLabel={label}>
        <Animated.View
          style={[
            styles.ground,
            { borderRadius: t.radius.xl, padding: t.spacing.md, borderWidth: t.borderWidth.hairline },
            groundStyle,
          ]}
        >
          <Animated.View
            style={[
              t.elevation(1),
              {
                borderRadius: t.radius.lg,
                padding: t.spacing.md,
                gap: t.spacing.md,
                borderWidth: t.borderWidth.hairline,
              },
              cardStyle,
            ]}
          >
            <Row gap="md">
              <Animated.View
                style={[
                  styles.center,
                  { width: disc, height: disc, borderRadius: t.radius.pill },
                  discStyle,
                ]}
              >
                <AnimatedText variant="title3" style={initialStyle}>
                  {initials(petName, 1)}
                </AnimatedText>
              </Animated.View>

              <Column flex gap="hair">
                <AnimatedText variant="bodyStrong" numberOfLines={1} style={titleStyle}>
                  {petName}
                </AnimatedText>
                <AnimatedText variant="caption" numberOfLines={1} style={captionStyle}>
                  {SPECIES_META[species].label} · dinner at 6:00 pm
                </AnimatedText>
              </Column>

              <Animated.View
                style={[
                  {
                    borderRadius: t.radius.pill,
                    paddingHorizontal: t.spacing.sm,
                    paddingVertical: t.spacing.xxs,
                  },
                  pillStyle,
                ]}
              >
                <AnimatedText variant="captionStrong" style={pillInkStyle}>
                  2 of 3
                </AnimatedText>
              </Animated.View>
            </Row>

            <Animated.View
              style={[{ height: bar, borderRadius: t.radius.pill, overflow: 'hidden' }, trackStyle]}
            >
              <Animated.View style={[styles.fill, fillStyle]} />
            </Animated.View>
          </Animated.View>

          <View style={{ position: 'absolute', top: t.spacing.sm, right: t.spacing.sm }}>
            <SkyGlyph tone={tone} reduce={reduce} />
          </View>
        </Animated.View>
      </View>

      <Row justify="between" style={{ paddingTop: t.spacing.md }} gap="sm">
        <Text variant="footnote" color="textTertiary" style={styles.flex}>
          {isSample
            ? 'A stand-in until your first pet is on the account — the real one lands here after that.'
            : 'Live preview. Pick a theme and watch it travel.'}
        </Text>
        {isSample ? <Badge label="Example" tone="neutral" size="sm" /> : null}
      </Row>
    </Surface>
  );
}

/**
 * Sun and moon, cross-faded and turned over by the same shared value. Purely
 * decorative, so the rotation is dropped under reduced motion and the two
 * glyphs simply swap.
 */
function SkyGlyph({ tone, reduce }: { tone: SharedValue<number>; reduce: boolean }) {
  const sunStyle = useAnimatedStyle(() => ({ opacity: 1 - tone.value }));
  const moonStyle = useAnimatedStyle(() => ({ opacity: tone.value }));
  const turnStyle = useAnimatedStyle(() => ({
    transform: reduce ? [] : [{ rotate: `${interpolate(tone.value, [0, 1], [0, 180])}deg` }],
  }));

  return (
    <Animated.View style={turnStyle}>
      <Animated.View style={sunStyle}>
        <Icon name="sunny" size="sm" color={lightPalette.warning} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, moonStyle]}>
        <Icon name="moon" size="sm" color={darkPalette.info} />
      </Animated.View>
    </Animated.View>
  );
}

/** Matches the preview's shape so the swap-in doesn't move the page. */
function PreviewSkeleton() {
  const t = useTheme();

  return (
    <Surface variant="surfaceAlt" radius="xxl" padding="md" elevation={0} border>
      <SkeletonGroup label="Building your preview" gap="md">
        <Surface variant="surface" radius="xl" padding="md" elevation={0}>
          <Row gap="md">
            <SkeletonCircle size={t.spacing.xxxl} />
            <Column flex gap="xs">
              <Skeleton w="55%" h={t.spacing.base} r="sm" />
              <Skeleton w="80%" h={t.spacing.md} r="sm" dim />
            </Column>
          </Row>
          <View style={{ paddingTop: t.spacing.md }}>
            <Skeleton w="100%" h={t.spacing.xs} r="pill" dim />
          </View>
        </Surface>
      </SkeletonGroup>
    </Surface>
  );
}

/* ----------------------------------------------------------------- styles */

const styles = StyleSheet.create({
  ground: { overflow: 'hidden' },
  center: { alignItems: 'center', justifyContent: 'center' },
  // Two thirds done — the same shape the real day-progress bar takes.
  fill: { height: '100%', width: '66%' },
  flex: { flex: 1 },
});
