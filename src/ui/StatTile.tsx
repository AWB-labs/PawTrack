/**
 * Petal — StatTile.
 *
 * One number, said well. Weight, adherence, streak, doses left.
 *
 * The number *rolls* rather than swapping. When a caregiver logs a dose while
 * you're looking at the medicine screen, "84%" counting up to "88%" is the only
 * thing that tells you something just happened — a silent swap reads as a
 * re-render, and a re-render reads as a glitch.
 *
 * The roll is driven from a shared value but only pushes to React when the
 * *rounded* value changes. A 600ms count over 4 percentage points is four
 * re-renders of one `<Text/>`, not sixty of the whole tile.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { runOnJS } from 'react-native-worklets';

import { useTheme, type Theme, type TypeVariant } from '@/theme';
import { Icon, type IconName } from './Icon';
import { Sparkline } from './Sparkline';
import { Row } from './Stack';
import { Surface } from './Surface';
import { Text, type ColorProp } from './Text';
import { Touchable } from './Touchable';

/* -------------------------------------------------------------------- types */

export type StatDeltaTone = 'auto' | 'positive' | 'negative' | 'neutral';

export type StatDelta = {
  /** Signed change. Zero renders the flat state. */
  value: number;
  /** Rendered inside the chip — pass a formatted string, e.g. "+0.3 kg". */
  label: string;
  tone?: StatDeltaTone;
};

export type StatTileProps = {
  label: string;
  /** Numbers roll; strings cross-fade. */
  value: number | string;
  /** Formats the rolling number. Also fixes the roll's precision. */
  format?: (value: number) => string;
  /** Decimal places the roll steps through. Defaults to 0. */
  precision?: number;
  /** Small trailing unit, set in the body ramp beside the metric. */
  unit?: string;
  delta?: StatDelta | null;
  /** For `tone: 'auto'` — is a rise good news? Weight loss usually isn't. */
  higherIsBetter?: boolean;
  icon?: IconName;
  iconColor?: ColorProp;
  /** Trend behind the number. */
  sparkline?: number[];
  sparklineColor?: ColorProp;
  /** One short line under the number — "since last vet visit". */
  caption?: string;
  size?: 'sm' | 'md';
  onPress?: () => void;
  disabledReason?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

const METRIC_VARIANT: Record<'sm' | 'md', TypeVariant> = { sm: 'metricSmall', md: 'metric' };

/* ------------------------------------------------------------------ helpers */

function deltaSkin(t: Theme, delta: StatDelta, higherIsBetter: boolean) {
  const tone = delta.tone ?? 'auto';
  const good = tone === 'auto' ? (delta.value > 0) === higherIsBetter : tone === 'positive';

  if (delta.value === 0 || tone === 'neutral') {
    return { fill: t.color.surfaceAlt, ink: t.color.textSecondary, icon: 'remove' as IconName };
  }
  const icon: IconName = delta.value > 0 ? 'arrow-up' : 'arrow-down';
  return good
    ? { fill: t.color.successSoft, ink: t.color.onSuccessSoft, icon }
    : { fill: t.color.warningSoft, ink: t.color.onWarningSoft, icon };
}

/* ---------------------------------------------------------------- component */

export function StatTile({
  label,
  value,
  format,
  precision = 0,
  unit,
  delta = null,
  higherIsBetter = true,
  icon,
  iconColor = 'primaryText',
  sparkline,
  sparklineColor,
  caption,
  size = 'md',
  onPress,
  disabledReason,
  accessibilityLabel,
  accessibilityHint,
  style,
  testID,
}: StatTileProps) {
  const t = useTheme();
  const numeric = typeof value === 'number';
  const quantum = 10 ** precision;

  /* ---- the roll -------------------------------------------------------- */

  const rolled = useSharedValue(numeric ? value : 0);
  const [shown, setShown] = useState(numeric ? value : 0);
  const nudge = useSharedValue(0);

  const settle = useCallback((next: number) => setShown(next), []);

  useEffect(() => {
    if (!numeric) return;
    if (t.reduceMotion) {
      rolled.value = value;
      setShown(value);
      return;
    }
    rolled.value = withTiming(
      value,
      t.motion.timing(t.motion.duration.slower, 'decelerate'),
      (finished) => {
        'worklet';
        // The reaction below only ever emits *rounded* steps; landing exactly
        // on the real value is what stops "4.4" sticking when it's 4.35.
        if (finished) runOnJS(settle)(value);
      },
    );
    // A half-beat lift under the digits: the number moves as well as changes,
    // which is what makes the update land as an event rather than a repaint.
    nudge.value = withSequence(
      withTiming(1, t.motion.timing(t.motion.duration.fast, 'accelerate')),
      withTiming(0, t.motion.timing(t.motion.duration.slow, 'decelerate')),
    );
  }, [nudge, numeric, rolled, settle, t.motion, t.reduceMotion, value]);

  useAnimatedReaction(
    () => Math.round(rolled.value * quantum) / quantum,
    (current, previous) => {
      if (previous !== null && current !== previous) runOnJS(settle)(current);
    },
  );

  const lift = t.spacing.xxs;
  const rollStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -nudge.value * lift }],
    opacity: 1 - nudge.value * 0.25,
  }));

  /* ---- presentation ---------------------------------------------------- */

  const text = numeric ? (format ? format(shown) : String(shown)) : String(value);
  const skin = delta ? deltaSkin(t, delta, higherIsBetter) : null;
  const metricVariant = METRIC_VARIANT[size];

  const description = useMemo(() => {
    const parts = [label, `${text}${unit ? ` ${unit}` : ''}`];
    if (delta) parts.push(delta.label);
    if (caption) parts.push(caption);
    return accessibilityLabel ?? parts.join(', ');
  }, [accessibilityLabel, caption, delta, label, text, unit]);

  const body = (
    <Surface
      variant="surface"
      elevation={1}
      radius="xl"
      padding={size === 'sm' ? 'md' : 'base'}
      style={{ gap: t.spacing.xs, flexGrow: 1, flexBasis: 'auto' }}
    >
      <Row justify="between" gap="sm">
        <Text variant="caption" color="textTertiary" numberOfLines={1} style={{ flexShrink: 1 }}>
          {label}
        </Text>
        {icon ? <Icon name={icon} size="sm" color={iconColor} /> : null}
      </Row>

      {/* Bottom-aligned rather than baseline-aligned: the numeral sits in an
          animated wrapper, and Yoga's baseline through a nested view is not
          something to bet a headline number on. */}
      <Row align="end" gap="xs">
        <Animated.View style={rollStyle}>
          <Text variant={metricVariant} tabular numberOfLines={1}>
            {text}
          </Text>
        </Animated.View>
        {unit ? (
          <Text
            variant={size === 'sm' ? 'caption' : 'subhead'}
            color="textTertiary"
            style={{ marginBottom: t.spacing.xxs }}
          >
            {unit}
          </Text>
        ) : null}
      </Row>

      {delta && skin ? (
        <Row gap="xxs" style={{ alignSelf: 'flex-start' }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: t.spacing.hair,
              paddingHorizontal: t.spacing.xs,
              paddingVertical: t.spacing.hair,
              borderRadius: t.radius.pill,
              backgroundColor: skin.fill,
            }}
          >
            <Icon name={skin.icon} size="xs" color={skin.ink} />
            <Text variant="caption" color={skin.ink} tabular numberOfLines={1}>
              {delta.label}
            </Text>
          </View>
        </Row>
      ) : null}

      {sparkline && sparkline.length > 0 ? (
        <Sparkline
          data={sparkline}
          height={size === 'sm' ? t.spacing.xxl : t.spacing.xxxl}
          color={sparklineColor ?? iconColor}
        />
      ) : null}

      {caption ? (
        <Text variant="caption" color="textTertiary" numberOfLines={2}>
          {caption}
        </Text>
      ) : null}
    </Surface>
  );

  if (!onPress && disabledReason === undefined) {
    return (
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={description}
        style={[{ flexGrow: 1, flexBasis: 'auto' }, style]}
        testID={testID}
      >
        {body}
      </View>
    );
  }

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={description}
      accessibilityHint={accessibilityHint}
      disabledReason={disabledReason}
      haptic="tap"
      onPress={onPress}
      pressScale="large"
      style={[{ flexGrow: 1, flexBasis: 'auto' }, style]}
      testID={testID}
    >
      {body}
    </Touchable>
  );
}

export default StatTile;
