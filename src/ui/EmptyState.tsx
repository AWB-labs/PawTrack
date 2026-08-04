/**
 * Petal — EmptyState.
 *
 * "Nothing here yet" is a design opportunity, not a gap (contract rule 5). Every
 * empty state names the gap in plain words, explains what the user gets by
 * filling it, and offers exactly one obvious way to do that.
 *
 * The default illustration is a petal bloom drawn in SVG rather than a stock
 * icon in a grey circle: it carries the brand, tints per tone, and costs
 * nothing in Expo Go. Pass `illustration` when a screen has something better —
 * a species portrait, an empty chart, a photograph.
 *
 * Motion: the bloom settles with a spring while the words fade up behind it in
 * sequence, so the eye lands on the picture, reads the headline, then finds the
 * button. Under reduced motion the same sequence plays as a plain cross-fade.
 */

import React, { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
  type WithSpringConfig,
} from 'react-native-reanimated';
import { Circle, Defs, Ellipse, G, LinearGradient, Path, Stop, Svg } from 'react-native-svg';

import { spring, useTheme, type Theme } from '@/theme';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

/* -------------------------------------------------------------------- types */

export type EmptyStateVariant = 'full' | 'compact';
export type EmptyStateTone = 'primary' | 'accent' | 'info' | 'warning' | 'danger' | 'neutral';

export type EmptyStateAction = {
  label: string;
  onPress: () => void;
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  /** Looks disabled but still explains itself — the RBAC affordance. */
  disabledReason?: string;
  accessibilityHint?: string;
};

/**
 * The heading, under either name. `headline` says what this line *is*; `title`
 * is the spelling most call sites reach for first. Exactly one is required, and
 * the union is what makes "neither" a compile error rather than a blank screen.
 */
export type EmptyStateHeading =
  | { headline: string; title?: never }
  | { title: string; headline?: never };

export type EmptyStateProps = EmptyStateHeading & {
  /** One line on what filling the gap buys them. */
  body?: string;
  /** Replaces the default bloom. */
  illustration?: ReactNode;
  /** Glyph inside the bloom. */
  icon?: IconName;
  tone?: EmptyStateTone;
  variant?: EmptyStateVariant;
  action?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  /** Replaces both buttons, for callers that need bespoke controls. */
  actions?: ReactNode;
  /** Dashed outline — for a slot that is visibly waiting to be filled. */
  frame?: boolean;
  /** Anything below the actions: a hint, a caption, a link row. */
  footer?: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export type BloomProps = {
  size: number;
  icon: IconName;
  tone: EmptyStateTone;
};

type Spec = {
  bloom: number;
  gap: number;
  headline: 'title1' | 'title3';
  body: 'callout' | 'footnote';
  buttonSize: 'md' | 'lg';
  padding: number;
};

/* ---------------------------------------------------------------- constants */

/** See Touchable: the theme's `springWith` helper doesn't type-check yet. */
const SETTLE: WithSpringConfig = { ...spring.gentle, reduceMotion: ReduceMotion.System };

/** The bloom arrives from slightly small — never from zero, which reads as a pop. */
const BLOOM_FROM = 0.82;

/** Petal count. Six reads as a flower; five as a star, eight as a gear. */
const PETALS = [0, 60, 120, 180, 240, 300] as const;

/** Body copy is capped at four `colossal` steps — roughly 34 characters a line. */
const MEASURE_UNITS = 4;

/** SVG ids must be unique per mounted gradient and can't use React's `useId`
 *  (its colons are invalid inside a `url(#…)` reference). */
let bloomSeq = 0;

/* ------------------------------------------------------------------ helpers */

function toneInk(t: Theme, tone: EmptyStateTone): { soft: string; ink: string; deep: string } {
  switch (tone) {
    case 'accent':
      return { soft: t.color.accentSoft, ink: t.color.onAccentSoft, deep: t.color.accent };
    case 'info':
      return { soft: t.color.infoSoft, ink: t.color.onInfoSoft, deep: t.color.info };
    case 'warning':
      return { soft: t.color.warningSoft, ink: t.color.onWarningSoft, deep: t.color.warning };
    case 'danger':
      return { soft: t.color.dangerSoft, ink: t.color.onDangerSoft, deep: t.color.danger };
    case 'neutral':
      return { soft: t.color.surfaceAlt, ink: t.color.textSecondary, deep: t.color.borderStrong };
    case 'primary':
    default:
      return { soft: t.color.primarySoft, ink: t.color.onPrimarySoft, deep: t.color.primary };
  }
}

function specFor(t: Theme, variant: EmptyStateVariant): Spec {
  return variant === 'compact'
    ? {
        bloom: t.spacing.giant + t.spacing.md,
        gap: t.spacing.md,
        headline: 'title3',
        body: 'footnote',
        buttonSize: 'md',
        padding: t.spacing.lg,
      }
    : {
        bloom: t.spacing.colossal + t.spacing.huge,
        gap: t.spacing.base,
        headline: 'title1',
        body: 'callout',
        buttonSize: 'lg',
        padding: t.spacing.xl,
      };
}

/* --------------------------------------------------------------- components */

/**
 * The default illustration: six soft petals around a clean centre with the
 * screen's glyph sitting in it. Drawn rather than iconified so it can pick up
 * the tone colour and still look hand-made at 132pt.
 */
export function Bloom({ size, icon, tone }: BloomProps) {
  const t = useTheme();
  const skin = toneInk(t, tone);
  const [id] = useState(() => `petal-bloom-${++bloomSeq}`);
  const glyph = Math.round(size * 0.3);

  return (
    <View style={{ width: size, height: size }} pointerEvents="none">
      <Svg width={size} height={size} viewBox="0 0 120 120">
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={skin.soft} stopOpacity={1} />
            <Stop offset="1" stopColor={skin.deep} stopOpacity={t.scheme === 'dark' ? 0.32 : 0.24} />
          </LinearGradient>
        </Defs>

        <G>
          {PETALS.map((angle) => (
            <Ellipse
              key={angle}
              cx={60}
              cy={36}
              rx={18}
              ry={27}
              fill={`url(#${id})`}
              rotation={angle}
              origin="60, 60"
            />
          ))}
        </G>

        {/* A calm well for the glyph — without it the petals fight the icon. */}
        <Circle cx={60} cy={60} r={25} fill={t.color.surface} />
        <Circle cx={60} cy={60} r={25} fill={skin.soft} />

        {/* Two drifting seeds. Asymmetry is what stops it looking like clip-art. */}
        <Path
          d="M14 96c6-5 13-6 18-2"
          stroke={skin.deep}
          strokeOpacity={0.35}
          strokeWidth={3}
          strokeLinecap="round"
          fill="none"
        />
        <Circle cx={104} cy={26} r={4} fill={skin.deep} fillOpacity={0.3} />
      </Svg>

      <View style={[StyleSheet.absoluteFill, styles.center]}>
        <Icon name={icon} size={glyph} color={skin.ink} />
      </View>
    </View>
  );
}

export function EmptyState({
  headline,
  title,
  body,
  illustration,
  icon = 'paw-outline',
  tone = 'primary',
  variant = 'full',
  action,
  secondaryAction,
  actions,
  frame = false,
  footer,
  style,
  testID,
}: EmptyStateProps) {
  const t = useTheme();
  const spec = specFor(t, variant);
  const reduceMotion = t.reduceMotion;

  const settle = useSharedValue(reduceMotion ? 1 : 0);
  useEffect(() => {
    settle.value = reduceMotion
      ? withTiming(1, t.motion.timing(t.motion.duration.base, 'smooth'))
      : withDelay(t.motion.duration.instant, withSpring(1, SETTLE));
  }, [reduceMotion, settle, t.motion]);

  const bloomStyle = useAnimatedStyle(() => ({
    opacity: settle.value,
    transform: [{ scale: reduceMotion ? 1 : BLOOM_FROM + settle.value * (1 - BLOOM_FROM) }],
  }));

  // The words follow the picture, one beat apart, so the eye is led rather than
  // shown everything at once.
  const enter = (index: number) =>
    reduceMotion
      ? FadeIn.duration(t.motion.duration.base).delay(index * t.motion.stagger.tight)
      : FadeInDown.duration(t.motion.duration.slow)
          .delay(t.motion.duration.fast + index * t.motion.stagger.base)
          .easing(t.motion.easing.decelerate);

  const hasButtons = Boolean(actions ?? action ?? secondaryAction);

  return (
    <View
      testID={testID}
      style={[
        styles.center,
        { gap: spec.gap, padding: spec.padding },
        frame
          ? {
              borderRadius: t.radius.xl,
              borderWidth: t.borderWidth.thin,
              borderColor: t.color.border,
              borderStyle: 'dashed',
              backgroundColor: t.color.surfaceAlt,
            }
          : null,
        style,
      ]}
    >
      <Animated.View style={bloomStyle}>
        {illustration ?? <Bloom size={spec.bloom} icon={icon} tone={tone} />}
      </Animated.View>

      <Animated.View entering={enter(0)} style={styles.center}>
        <Text variant={spec.headline} align="center" accessibilityRole="header">
          {headline ?? title}
        </Text>
      </Animated.View>

      {body ? (
        <Animated.View
          entering={enter(1)}
          style={[
            styles.center,
            // A measure cap — centred copy stops being scannable past ~34
            // characters a line. The pull-up keeps it paired with the headline.
            { maxWidth: t.spacing.colossal * MEASURE_UNITS, marginTop: t.spacing.xs - spec.gap },
          ]}
        >
          <Text variant={spec.body} color="textSecondary" align="center">
            {body}
          </Text>
        </Animated.View>
      ) : null}

      {hasButtons ? (
        <Animated.View entering={enter(2)} style={[styles.actions, { gap: t.spacing.sm }]}>
          {actions ?? (
            <>
              {action ? (
                <Button
                  label={action.label}
                  onPress={action.onPress}
                  leftIcon={action.icon}
                  loading={action.loading}
                  disabled={action.disabled}
                  disabledReason={action.disabledReason}
                  accessibilityHint={action.accessibilityHint}
                  size={spec.buttonSize}
                  // The one thing to do on an otherwise empty screen.
                  hero={variant === 'full'}
                  haptic="commit"
                />
              ) : null}
              {secondaryAction ? (
                <Button
                  label={secondaryAction.label}
                  onPress={secondaryAction.onPress}
                  leftIcon={secondaryAction.icon}
                  loading={secondaryAction.loading}
                  disabled={secondaryAction.disabled}
                  disabledReason={secondaryAction.disabledReason}
                  accessibilityHint={secondaryAction.accessibilityHint}
                  variant="ghost"
                  size={spec.buttonSize === 'lg' ? 'md' : 'sm'}
                />
              ) : null}
            </>
          )}
        </Animated.View>
      ) : null}

      {footer ? (
        <Animated.View entering={enter(3)} style={styles.center}>
          {footer}
        </Animated.View>
      ) : null}
    </View>
  );
}

/* ----------------------------------------------------------------- styles */

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  actions: { alignItems: 'center' },
});

export default EmptyState;
