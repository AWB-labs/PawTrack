/**
 * Petal — DoseButton.
 *
 * The control that says "this went in". It is the most repeated *consequential*
 * tap in the app — a mis-tap here is a double dose — so it earns more care than
 * anything else in the library.
 *
 * Two ways to commit, chosen by the caller rather than by the user:
 *
 *   · **Tap**, for the ordinary case. The tick *draws itself* along its own
 *     stroke, the pill cross-fades from brand to success, and the whole control
 *     pops once and settles a hair smaller — the visual equivalent of something
 *     being put down.
 *   · **Hold**, for doses that shouldn't be possible by accident (an early dose,
 *     a second one the same day). A ring fills around the glyph for the length
 *     of the hold; letting go early unwinds it. You feel the arm at the start
 *     and the success at the end, and nothing in between, so the gesture has a
 *     shape.
 *
 * Everything visible is a function of the `state` prop, not of what the finger
 * did. That matters: the mutation behind this is optimistic, so if the write
 * fails and the cache rolls back, the tick un-draws itself instead of lying.
 *
 * A hold is invisible to a screen reader, so when one is running the same
 * control commits on a single activation and says so in its hint.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  interpolate,
  interpolateColor,
  ReduceMotion,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
  type WithSpringConfig,
} from 'react-native-reanimated';
import { runOnJS } from 'react-native-worklets';
import { Circle, G, Path, Svg, type CircleProps, type PathProps } from 'react-native-svg';

import haptics from '@/lib/haptics';
import { spring, useTheme, type Theme } from '@/theme';
import { Column, Icon, IconButton, Row, Text, Touchable, type IconName } from '@/ui';
import { AnimatedText } from '@/ui/FormField';

/* -------------------------------------------------------------------- types */

export type DoseButtonState = 'pending' | 'given' | 'skipped' | 'missed';
export type DoseButtonSize = 'sm' | 'md';

export type DoseButtonProps = {
  state?: DoseButtonState;
  /** Pending label. Defaults to "Give dose". */
  label?: string;
  /** Settled label — "Given 8:04am". Defaults to the state's own word. */
  doneLabel?: string;
  /** Second line while pending — "With food", "Half a tablet". */
  hint?: string;
  onGive: () => void;
  /** Rendered as a separate control beside the pill once the dose is settled. */
  onUndo?: () => void;
  /** Press-and-hold to confirm instead of a plain tap. */
  hold?: boolean;
  holdLabel?: string;
  /** Milliseconds of hold. Defaults to two `slower` beats. */
  holdDuration?: number;
  /** `quiet` for a dose that isn't due yet; `high` for the one due now. */
  emphasis?: 'high' | 'quiet';
  size?: DoseButtonSize;
  disabled?: boolean;
  /** Needs `medicine.log`; looks off, still explains itself on tap. */
  disabledReason?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

type Skin = { fill: string; ink: string; track: string };

/* ---------------------------------------------------------------- constants */

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath = Animated.createAnimatedComponent(Path);

/** See `Touchable` — the theme's `springWith` helper doesn't type-check yet. */
const REWARD: WithSpringConfig = { ...spring.bouncy, reduceMotion: ReduceMotion.System };
const SETTLE: WithSpringConfig = { ...spring.gentle, reduceMotion: ReduceMotion.System };

/** Long enough to be deliberate, short enough not to feel like a punishment. */
const HOLD_BEATS = 2;

/** The tick, in the 24×24 viewBox, and its stroke length for the draw-on. */
const TICK_PATH = 'M6 12.6 L10.3 16.8 L18 8.2';
const TICK_LENGTH = 18;

/** How far the pill pops on commit, and how much it settles below rest after. */
const POP_SCALE = 0.05;
const SETTLE_SCALE = 0.015;

const SETTLED_WORD: Record<DoseButtonState, string> = {
  pending: 'Give dose',
  given: 'Given',
  skipped: 'Skipped',
  missed: 'Missed',
};

/** The glyph that replaces the tick when the dose didn't happen. */
function settledGlyphFor(state: DoseButtonState): IconName | null {
  if (state === 'skipped') return 'remove';
  if (state === 'missed') return 'alert';
  return null;
}

/* ------------------------------------------------------------------ helpers */

/**
 * Whether VoiceOver / TalkBack is running. A press-and-hold has no gesture a
 * screen reader can produce, so the control has to know.
 */
function useScreenReader(): boolean {
  const [on, setOn] = useState(false);

  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isScreenReaderEnabled()
      .then((value) => {
        if (alive) setOn(value);
      })
      .catch(() => {
        /* older Androids can reject this; assuming "off" is the safe default */
      });
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', setOn);
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);

  return on;
}

function pendingSkin(t: Theme, emphasis: 'high' | 'quiet'): Skin {
  return emphasis === 'high'
    ? { fill: t.color.primary, ink: t.color.onPrimary, track: t.color.primaryPressed }
    : { fill: t.color.primarySoft, ink: t.color.onPrimarySoft, track: t.color.primarySoftBorder };
}

function settledSkin(t: Theme, state: DoseButtonState): Skin {
  switch (state) {
    case 'skipped':
      return { fill: t.color.warningSoft, ink: t.color.onWarningSoft, track: t.color.warningSoft };
    case 'missed':
      return { fill: t.color.dangerSoft, ink: t.color.onDangerSoft, track: t.color.dangerSoft };
    case 'given':
    default:
      return { fill: t.color.successSoft, ink: t.color.onSuccessSoft, track: t.color.successSoft };
  }
}

/* ---------------------------------------------------------------- component */

export function DoseButton({
  state = 'pending',
  label,
  doneLabel,
  hint,
  onGive,
  onUndo,
  hold = false,
  holdLabel = 'Hold to confirm',
  holdDuration,
  emphasis = 'high',
  size = 'md',
  disabled = false,
  disabledReason,
  accessibilityLabel,
  accessibilityHint,
  style,
  testID,
}: DoseButtonProps) {
  const t = useTheme();
  const screenReader = useScreenReader();

  const settled = state !== 'pending';
  const pending = pendingSkin(t, emphasis);
  const finished = settledSkin(t, state);
  const inert = disabled || disabledReason !== undefined;
  const reduceMotion = t.reduceMotion;

  const ring = size === 'md' ? t.spacing.xxl : t.spacing.xl + t.spacing.xxs;
  const stroke = t.borderWidth.focus;
  const radius = (ring - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const holdMs = holdDuration ?? t.motion.duration.slower * HOLD_BEATS;

  /* ---- animation state -------------------------------------------------- */

  const progress = useSharedValue(0);
  const done = useSharedValue(settled ? 1 : 0);
  const draw = useSharedValue(state === 'given' ? 1 : 0);
  const pop = useSharedValue(0);

  /** Set by this control's own commit, so an external log doesn't buzz. */
  const initiated = useRef(false);

  useEffect(() => {
    const target = settled ? 1 : 0;
    progress.value = 0;

    if (target === 1) {
      done.value = withTiming(1, t.motion.timing(t.motion.duration.base, 'smooth'));
      // The tick draws along its own stroke; under reduced motion the dash is
      // simply already complete and the layer's opacity carries the change.
      draw.value =
        state === 'given'
          ? reduceMotion
            ? 1
            : withTiming(1, t.motion.timing(t.motion.duration.base, 'decelerate'))
          : 0;
      if (!reduceMotion) {
        pop.value = withSequence(withSpring(1, REWARD), withSpring(0, SETTLE));
      }
      if (initiated.current && state === 'given') haptics.success();
      else if (initiated.current) haptics.commit();
    } else {
      done.value = withTiming(0, t.motion.timing(t.motion.duration.fast, 'accelerate'));
      draw.value = withTiming(0, t.motion.timing(t.motion.duration.fast, 'accelerate'));
      pop.value = withTiming(0, t.motion.timing(t.motion.duration.fast, 'smooth'));
    }

    initiated.current = false;
  }, [done, draw, pop, progress, reduceMotion, settled, state, t.motion]);

  useEffect(() => () => cancelAnimation(progress), [progress]);

  /* ---- commit ----------------------------------------------------------- */

  const commit = useCallback(() => {
    initiated.current = true;
    onGive();
  }, [onGive]);

  const startHold = useCallback(() => {
    if (inert || settled) return;
    // The arm tick is what tells you the gesture started, before the ring has
    // travelled far enough to see.
    haptics.threshold();
    progress.value = 0;
    progress.value = withTiming(
      1,
      {
        duration: holdMs,
        easing: t.motion.easing.linear,
        // The fill *is* the affordance; zeroing it under reduce motion would
        // commit the dose the instant a finger landed.
        reduceMotion: ReduceMotion.Never,
      },
      (complete) => {
        'worklet';
        if (complete) runOnJS(commit)();
      },
    );
  }, [commit, holdMs, inert, progress, settled, t.motion.easing.linear]);

  const cancelHold = useCallback(() => {
    cancelAnimation(progress);
    progress.value = withTiming(0, t.motion.timing(t.motion.duration.fast, 'accelerate'));
  }, [progress, t.motion]);

  const handlePress = useCallback(() => {
    if (disabled) return;
    // Blocked by a permission, but never mute: the caller's handler is what
    // opens the explanation, so the tap has to reach it.
    if (disabledReason !== undefined) {
      onGive();
      return;
    }
    if (settled) return;
    // A held button commits from its timer; the tap path only exists for screen
    // readers, which have no way to express a hold.
    if (hold && !screenReader) return;
    commit();
  }, [commit, disabled, disabledReason, hold, onGive, screenReader, settled]);

  /* ---- styles ----------------------------------------------------------- */

  const pillStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(done.value, [0, 1], [pending.fill, finished.fill]),
    transform: [{ scale: (1 + pop.value * POP_SCALE) * (1 - done.value * SETTLE_SCALE) }],
  }));

  const inkStyle = useAnimatedStyle(() => ({
    color: interpolateColor(done.value, [0, 1], [pending.ink, finished.ink]),
  }));

  const hintStyle = useAnimatedStyle(() => ({
    color: interpolateColor(done.value, [0, 1], [pending.ink, finished.ink]),
    opacity: (1 - done.value * 0.15) * (1 - pop.value * 0.3),
  }));

  const pendingLayerStyle = useAnimatedStyle(() => ({ opacity: 1 - done.value }));
  const settledLayerStyle = useAnimatedStyle(() => ({
    opacity: done.value,
    transform: [{ scale: interpolate(done.value, [0, 1], [0.72, 1]) }],
  }));

  const arcProps = useAnimatedProps<CircleProps>(() => ({
    strokeDashoffset: circumference * (1 - progress.value),
  }));

  const tickProps = useAnimatedProps<PathProps>(() => ({
    strokeDashoffset: TICK_LENGTH * (1 - draw.value),
  }));

  /* ---- copy ------------------------------------------------------------- */

  const settledGlyph = settledGlyphFor(state);
  const primaryLabel = settled ? (doneLabel ?? SETTLED_WORD[state]) : (label ?? 'Give dose');

  const secondaryLabel = settled ? null : hold && !screenReader ? holdLabel : (hint ?? null);

  const spokenHint = useMemo(() => {
    if (disabledReason) return disabledReason;
    if (accessibilityHint) return accessibilityHint;
    if (settled) return 'Already logged.';
    if (hold && !screenReader) return 'Press and hold until the ring fills.';
    return 'Logs this dose as given.';
  }, [accessibilityHint, disabledReason, hold, screenReader, settled]);

  const padY = size === 'md' ? t.spacing.md : t.spacing.sm;
  const padX = size === 'md' ? t.spacing.base : t.spacing.md;
  const typeVariant = size === 'md' ? 'button' : 'buttonSmall';

  return (
    <Row gap="sm" align="center" style={style} testID={testID}>
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? primaryLabel}
        accessibilityHint={spokenHint}
        // `disabled` stays off once settled: the Touchable would fade the whole
        // pill to 38%, and a logged dose is a result, not a dead control.
        accessibilityState={{ disabled: disabled || settled, selected: settled }}
        disabled={disabled}
        disabledReason={disabledReason}
        // Every buzz this control makes is earned: the arm on hold, the success
        // on commit. A press-in tick would blur both.
        haptic="none"
        onPress={handlePress}
        onPressIn={hold && !screenReader ? startHold : undefined}
        onPressOut={hold && !screenReader ? cancelHold : undefined}
        pressScale="medium"
        style={styles.grow}
      >
        <Animated.View
          style={[
            styles.pill,
            {
              gap: t.spacing.md,
              paddingVertical: padY,
              paddingHorizontal: padX,
              borderRadius: t.radius.pill,
            },
            pillStyle,
          ]}
        >
          <View style={{ width: ring, height: ring }}>
            <Animated.View style={[StyleSheet.absoluteFill, pendingLayerStyle]}>
              <Svg width={ring} height={ring}>
                <Circle
                  cx={ring / 2}
                  cy={ring / 2}
                  r={radius}
                  stroke={pending.track}
                  strokeWidth={stroke}
                  fill="none"
                />
                {/* Twelve o'clock is where a fill should start; SVG starts at three. */}
                <G rotation={-90} origin={`${ring / 2}, ${ring / 2}`}>
                  <AnimatedCircle
                    cx={ring / 2}
                    cy={ring / 2}
                    r={radius}
                    stroke={pending.ink}
                    strokeWidth={stroke}
                    strokeDasharray={circumference}
                    strokeLinecap="round"
                    fill="none"
                    animatedProps={arcProps}
                  />
                </G>
              </Svg>
              <View style={[StyleSheet.absoluteFill, styles.center]}>
                <Icon name="medical" size={size === 'md' ? 'sm' : 'xs'} color={pending.ink} />
              </View>
            </Animated.View>

            <Animated.View style={[StyleSheet.absoluteFill, styles.center, settledLayerStyle]}>
              {state === 'given' ? (
                <Svg width={ring} height={ring} viewBox="0 0 24 24">
                  <AnimatedPath
                    d={TICK_PATH}
                    stroke={finished.ink}
                    strokeWidth={t.borderWidth.focus}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                    strokeDasharray={TICK_LENGTH}
                    animatedProps={tickProps}
                  />
                </Svg>
              ) : settledGlyph ? (
                <Icon name={settledGlyph} size={size === 'md' ? 'md' : 'sm'} color={finished.ink} />
              ) : null}
            </Animated.View>
          </View>

          <Column flex gap="hair">
            <AnimatedText variant={typeVariant} numberOfLines={1} style={inkStyle}>
              {primaryLabel}
            </AnimatedText>
            {secondaryLabel ? (
              <AnimatedText variant="caption" numberOfLines={1} style={hintStyle}>
                {secondaryLabel}
              </AnimatedText>
            ) : null}
          </Column>
        </Animated.View>
      </Touchable>

      {onUndo && settled ? (
        <IconButton
          icon="arrow-undo-outline"
          accessibilityLabel="Undo this dose"
          accessibilityHint="Puts the dose back on the list and the tablet back in the packet."
          variant="tonal"
          tone="neutral"
          size={size}
          onPress={onUndo}
        />
      ) : null}
    </Row>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center' },
});

export default DoseButton;
