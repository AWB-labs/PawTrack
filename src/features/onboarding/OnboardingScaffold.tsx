/**
 * Petal — onboarding step shell.
 *
 * Four short steps that have to feel like one movement, so everything
 * structural lives here and each step supplies only its middle.
 *
 *   · **The rail is the whole navigation.** No numbers, no "3/4" — the cell you
 *     are on stretches and lights up, the ones behind it stay filled, the ones
 *     ahead sit as quiet stubs. It reads at a glance and it costs two shared
 *     values per cell.
 *   · **Back and skip sit either side of it**, never in a chrome bar, so the
 *     weight of the screen stays on the question being asked.
 *   · **One rhythm.** Title, body, content, then a flexible gap, then the
 *     actions. A short step puts its button at the bottom of the screen; a long
 *     one puts it after the content. Neither ever pins a bar over the answer
 *     the user is halfway through typing.
 */

import React, { useEffect, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  FadeIn,
  FadeInDown,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type WithSpringConfig,
} from 'react-native-reanimated';

import { spring, useTheme } from '@/theme';
import { Button, Column, IconButton, Row, Screen, Spacer, Text, Touchable, type IconName } from '@/ui';

/* -------------------------------------------------------------------- types */

export type OnboardingAction = {
  label: string;
  onPress: () => void;
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
};

export type OnboardingScaffoldProps = {
  children?: ReactNode;
  /** 1-based position in the flow. */
  step: number;
  totalSteps?: number;
  eyebrow?: string;
  title: string;
  body?: string;
  /** The one thing this step is for. Rendered as the screen's hero button. */
  primary?: OnboardingAction;
  /** The quieter alternative — "Not now", "I'd rather do this later". */
  secondary?: OnboardingAction;
  onBack?: () => void;
  onSkip?: () => void;
  skipLabel?: string;
  /** Anything under the actions — a reassurance line, a legal note. */
  footnote?: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
};

export type StepRailProps = {
  step: number;
  total: number;
};

/* ---------------------------------------------------------------- constants */

export const ONBOARDING_STEPS = 4;

/** See `Touchable` — the theme's `springWith` helper doesn't type-check yet. */
const RAIL_SPRING: WithSpringConfig = { ...spring.gentle, reduceMotion: ReduceMotion.System };

/** How much wider the live cell is than a resting one. */
const RAIL_STRETCH = 2.6;

/* -------------------------------------------------------------------- rail */

function RailCell({ index, step }: { index: number; step: number }) {
  const t = useTheme();

  const done = index < step;
  const live = index === step - 1;

  const fill = useSharedValue(done ? 1 : 0);
  const focus = useSharedValue(live ? 1 : 0);

  useEffect(() => {
    // The system moved this, not a finger — timing, decelerating into place.
    fill.value = withTiming(done ? 1 : 0, t.motion.timing(t.motion.duration.slow, 'decelerate'));
  }, [done, fill, t.motion]);

  useEffect(() => {
    focus.value = withSpring(live ? 1 : 0, RAIL_SPRING);
  }, [focus, live]);

  const rest = t.spacing.lg;
  const stretched = rest * RAIL_STRETCH;

  const trackStyle = useAnimatedStyle(() => ({
    width: rest + focus.value * (stretched - rest),
  }));

  const fillStyle = useAnimatedStyle(() => ({
    width: (rest + focus.value * (stretched - rest)) * fill.value,
  }));

  return (
    <Animated.View
      style={[
        {
          height: t.spacing.xs,
          borderRadius: t.radius.pill,
          backgroundColor: t.color.surfaceAlt,
          overflow: 'hidden',
        },
        trackStyle,
      ]}
    >
      <Animated.View
        style={[
          styles.fill,
          { borderRadius: t.radius.pill, backgroundColor: t.color.primary },
          fillStyle,
        ]}
      />
    </Animated.View>
  );
}

/** The progress indicator. Exported so a step can render it in its own hero. */
export function StepRail({ step, total }: StepRailProps) {
  const t = useTheme();
  const cells = Array.from({ length: total }, (_, index) => index);

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Setup progress"
      accessibilityValue={{ min: 1, max: total, now: step, text: `Step ${step} of ${total}` }}
      style={[styles.rail, { gap: t.spacing.xs }]}
    >
      {cells.map((index) => (
        <RailCell key={index} index={index} step={step} />
      ))}
    </View>
  );
}

/* ---------------------------------------------------------------- component */

export function OnboardingScaffold({
  children,
  step,
  totalSteps = ONBOARDING_STEPS,
  eyebrow,
  title,
  body,
  primary,
  secondary,
  onBack,
  onSkip,
  skipLabel = 'Skip',
  footnote,
  contentStyle,
  testID,
}: OnboardingScaffoldProps) {
  const t = useTheme();

  const enter = (index: number) =>
    t.reduceMotion
      ? FadeIn.duration(t.motion.duration.base).delay(index * t.motion.stagger.tight)
      : FadeInDown.duration(t.motion.duration.slow)
          .delay(index * t.motion.stagger.base)
          .easing(t.motion.easing.decelerate);

  const wash: readonly [string, string] = [t.color.primarySoft, 'transparent'];

  return (
    <View style={[styles.flex, { backgroundColor: t.color.bg }]} testID={testID}>
      {/* A single soft wash behind the header ties the four steps together
          without competing with whatever each one is asking for. */}
      <LinearGradient
        colors={wash}
        start={WASH_START}
        end={WASH_END}
        style={[StyleSheet.absoluteFill, styles.wash]}
        pointerEvents="none"
      />

      <Screen scroll background="transparent" contentContainerStyle={[{ gap: t.spacing.xl }, contentStyle]}>
        <Row gap="md" style={{ marginTop: t.spacing.sm }}>
          {onBack ? (
            <IconButton
              icon="chevron-back"
              accessibilityLabel="Back a step"
              variant="tonal"
              tone="neutral"
              size="sm"
              onPress={onBack}
            />
          ) : null}

          <View style={styles.grow}>
            <StepRail step={step} total={totalSteps} />
          </View>

          {onSkip ? (
            <Touchable
              accessibilityRole="button"
              accessibilityLabel={skipLabel}
              accessibilityHint="Moves on without finishing this step."
              haptic="tap"
              onPress={onSkip}
              pressScale="small"
              style={{ paddingHorizontal: t.spacing.sm, paddingVertical: t.spacing.xs }}
            >
              <Text variant="buttonSmall" color="textSecondary">
                {skipLabel}
              </Text>
            </Touchable>
          ) : null}
        </Row>

        <Animated.View entering={enter(0)} style={{ gap: t.spacing.sm }}>
          {eyebrow ? (
            <Text variant="overline" color="primaryText">
              {eyebrow}
            </Text>
          ) : null}
          <Text variant="display" accessibilityRole="header">
            {title}
          </Text>
          {body ? (
            <Text variant="callout" color="textSecondary">
              {body}
            </Text>
          ) : null}
        </Animated.View>

        <Animated.View entering={enter(1)}>{children}</Animated.View>

        <Spacer />

        {primary || secondary || footnote ? (
          <Animated.View entering={enter(2)} style={{ gap: t.spacing.md, paddingBottom: t.spacing.sm }}>
            {primary ? (
              <Button
                label={primary.label}
                onPress={primary.onPress}
                leftIcon={primary.icon}
                loading={primary.loading}
                disabled={primary.disabled}
                size="lg"
                hero
                fullWidth
                haptic="commit"
              />
            ) : null}

            {secondary ? (
              <Button
                label={secondary.label}
                onPress={secondary.onPress}
                leftIcon={secondary.icon}
                loading={secondary.loading}
                disabled={secondary.disabled}
                variant="ghost"
                size="md"
                fullWidth
              />
            ) : null}

            {footnote ? <Column align="center">{footnote}</Column> : null}
          </Animated.View>
        ) : null}
      </Screen>
    </View>
  );
}

/* ----------------------------------------------------------------- statics */

const WASH_START = { x: 0.1, y: 0 } as const;
const WASH_END = { x: 0.9, y: 1 } as const;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  grow: { flex: 1 },
  // The wash only occupies the top third; below that the ground is plain.
  wash: { bottom: '62%' },
  rail: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  fill: { height: '100%' },
});

export default OnboardingScaffold;
