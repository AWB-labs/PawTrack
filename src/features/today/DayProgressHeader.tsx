/**
 * Petal — DayProgressHeader.
 *
 * The first thing anyone sees, six times a day. It has one job: turn "you have
 * seven care tasks, four of which are complete" into a sentence a tired person
 * reads in half a second and feels something about.
 *
 * What makes it work:
 *
 *   · **The number is animated, the ring is animated, and they run on the same
 *     beat.** Ticking a meal off pushes the arc round *and* counts the numeral
 *     up, so the reward for a tap arrives in the place you were already looking.
 *     The count is stepped through integers on the JS thread — four re-renders
 *     over 340ms is cheaper than an animated text node and keeps the numeral on
 *     the app's own type ramp.
 *   · **The status line changes character, not just its number.** "All done —
 *     Buddy and Mochi are sorted for today" and "Two things slipped past" are
 *     different emotional registers, and a day where nothing is scheduled gets
 *     to be a good day rather than a zero.
 *   · **A finished day stops being a gauge.** At 100% the centre of the ring
 *     drops the fraction and springs a paw print in — there is nothing left to
 *     measure, so it stops measuring.
 */

import { format } from 'date-fns';
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  ReduceMotion,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
  type WithSpringConfig,
} from 'react-native-reanimated';
import { runOnJS } from 'react-native-worklets';

import type { DayProgress } from '@/data/queries/useCareTasks';
import { friendlyDate } from '@/lib/date';
import { joinWithAnd, pluralWord } from '@/lib/format';
import { spring, useTheme } from '@/theme';
import { Column, PawPrint, ProgressRing, Row, Surface, Text, type ProgressRingTone } from '@/ui';

/* -------------------------------------------------------------------- types */

export type DayProgressHeaderProps = {
  /** The signed-in person. Null while the profile is still hydrating. */
  userName: string | null;
  progress: DayProgress;
  /** Pets currently in scope — the status line names them. */
  petNames: readonly string[];
  /** The day on screen. */
  date: Date;
  /** False once the strip has moved off today; the greeting steps aside. */
  isToday: boolean;
  now: Date;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/** Rewards only — this is one of the few genuine ones in the app. */
const REWARD: WithSpringConfig = { ...spring.bouncy, reduceMotion: ReduceMotion.System };

/** How far the numeral swells when it ticks up. */
const COUNT_POP = 1.14;

/** Names before the line collapses to "and 2 more". */
const NAMED = 2;

/** Written-out numbers read warmer than numerals in a sentence this short. */
const SPELLED = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
] as const;

/* ------------------------------------------------------------------ helpers */

function spell(value: number): string {
  return value >= 0 && value < SPELLED.length ? (SPELLED[value] ?? String(value)) : String(value);
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * A greeting that knows what time it is. The two edges of the day get a
 * question rather than a wish — "Good evening" at 1am is a robot reading a
 * clock it doesn't understand.
 */
export function greetingFor(userName: string | null, now: Date): string {
  const first = userName?.trim().split(/\s+/)[0] ?? null;
  const hour = now.getHours();
  const phrase =
    hour < 5 ? 'Still up' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : hour < 22 ? 'Good evening' : 'Winding down';
  const asking = hour < 5 || hour >= 22;

  if (!first) return asking ? `${phrase}?` : phrase;
  return asking ? `${phrase}, ${first}?` : `${phrase}, ${first}`;
}

/** "Buddy, Mochi and 2 more" — never a list long enough to stop being a sentence. */
function nameList(names: readonly string[]): string {
  if (names.length === 0) return 'everyone';
  if (names.length <= NAMED + 1) return joinWithAnd(names, 'and');
  const rest = names.length - NAMED;
  return joinWithAnd([...names.slice(0, NAMED), `${rest} more`], 'and');
}

export function statusLineFor(
  progress: DayProgress,
  petNames: readonly string[],
  isToday: boolean,
): string {
  const who = nameList(petNames);
  const verb = petNames.length === 1 ? 'is' : 'are';

  if (progress.total === 0) {
    return isToday
      ? `Nothing on the list — enjoy the quiet with ${who}.`
      : 'Nothing scheduled that day.';
  }
  if (progress.remaining === 0) {
    return isToday ? `All done — ${who} ${verb} sorted for today.` : 'All done — every last thing.';
  }
  if (progress.overdue > 0) {
    return `${capitalise(spell(progress.overdue))} ${pluralWord(progress.overdue, 'thing')} slipped past — still worth doing.`;
  }
  if (progress.remaining === 1) {
    return isToday ? 'One last thing and today is done.' : 'One thing left.';
  }
  return `${capitalise(spell(progress.remaining))} things still to do.`;
}

function toneFor(progress: DayProgress): ProgressRingTone {
  if (progress.overdue > 0) return 'danger';
  if (progress.total > 0 && progress.remaining === 0) return 'success';
  return 'primary';
}

/* ---------------------------------------------------------------- component */

export function DayProgressHeader({
  userName,
  progress,
  petNames,
  date,
  isToday,
  now,
  style,
  testID,
}: DayProgressHeaderProps) {
  const t = useTheme();

  const complete = progress.total > 0 && progress.remaining === 0;
  const headline = isToday ? greetingFor(userName, now) : friendlyDate(date, now);
  const status = statusLineFor(progress, petNames, isToday);
  const tone = toneFor(progress);

  const diameter = t.spacing.colossal + t.spacing.xl;

  /* ---- the counting numeral --------------------------------------------- */

  const counter = useSharedValue(progress.done);
  const [shown, setShown] = useState(progress.done);
  const pop = useSharedValue(1);
  const seen = useRef(progress.done);

  useEffect(() => {
    counter.value = withTiming(
      progress.done,
      t.motion.timing(t.motion.duration.slow, 'decelerate'),
    );
    if (progress.done > seen.current) {
      pop.value = withSequence(
        withTiming(COUNT_POP, t.motion.timing(t.motion.duration.instant, 'decelerate')),
        withSpring(1, REWARD),
      );
    }
    seen.current = progress.done;
  }, [counter, pop, progress.done, t.motion]);

  // Only whole numbers ever reach React, so a seven-task day costs at most seven
  // renders across the whole sweep.
  useAnimatedReaction(
    () => Math.round(counter.value),
    (current, previous) => {
      if (current !== previous) runOnJS(setShown)(current);
    },
    [],
  );

  const countStyle = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }));

  /* ---- the finished-day paw --------------------------------------------- */

  const pawIn = useSharedValue(complete ? 1 : 0);
  useEffect(() => {
    pawIn.value = complete
      ? withSpring(1, REWARD)
      : withTiming(0, t.motion.timing(t.motion.duration.fast, 'accelerate'));
  }, [complete, pawIn, t.motion]);

  const reduce = t.reduceMotion;
  const pawStyle = useAnimatedStyle(() => ({
    opacity: pawIn.value,
    transform: reduce ? [] : [{ scale: 0.6 + pawIn.value * 0.4 }],
  }));

  /* ---- the empty-day leaf ------------------------------------------------ */

  const empty = progress.total === 0;

  return (
    <Surface
      elevation={1}
      radius="xxl"
      padding="base"
      style={[styles.clip, style]}
      testID={testID}
    >
      {/* A wash rather than a fill: the card should feel lit from the ring's
          corner, not painted. Both stops are opaque so Android never fades
          through black. */}
      <LinearGradient
        colors={[t.color.primarySoft, t.color.surface]}
        start={GRADIENT_START}
        end={GRADIENT_END}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      <Row gap="base" align="center">
        <Column flex gap="xxs">
          <Text variant="overline" color="textTertiary" numberOfLines={1}>
            {format(date, 'EEEE d MMMM')}
          </Text>
          <Text variant="title1" numberOfLines={2} accessibilityRole="header">
            {headline}
          </Text>
          <Text variant="callout" color="textSecondary">
            {status}
          </Text>
        </Column>

        <ProgressRing
          // A day with nothing on it isn't a finished day — an empty track says
          // "clear", a full arc would claim credit nobody earned.
          value={empty ? 0 : progress.ratio}
          size={diameter}
          thickness={t.spacing.sm}
          tone={tone}
          gradient={!complete && !empty}
          accessibilityLabel={
            empty
              ? 'Nothing scheduled today'
              : `${progress.done} of ${progress.total} care tasks done today`
          }
        >
          {complete ? (
            <Animated.View style={pawStyle}>
              <PawPrint size={t.spacing.xxxl} color={t.color.success} />
            </Animated.View>
          ) : empty ? (
            <Text variant="title2" color="textTertiary" accessibilityElementsHidden>
              —
            </Text>
          ) : (
            <View style={styles.center} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <Animated.View style={countStyle}>
                <Text variant="metric" tabular>
                  {shown}
                </Text>
              </Animated.View>
              <Text variant="caption" color="textTertiary" tabular>
                of {progress.total}
              </Text>
            </View>
          )}
        </ProgressRing>
      </Row>
    </Surface>
  );
}

/* ------------------------------------------------------------------ styles */

const GRADIENT_START = { x: 0.1, y: 0 } as const;
const GRADIENT_END = { x: 1, y: 1 } as const;

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  center: { alignItems: 'center', justifyContent: 'center' },
});

export default DayProgressHeader;
