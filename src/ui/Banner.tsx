/**
 * Petal — Banner.
 *
 * Contextual, in-flow messaging: the line above a feeding list that says a
 * caregiver's access ends on Sunday, the note on a medicine card that two doses
 * are left. It sits *in* the content because it is about that content — a toast
 * would fly away before it had been read, and a sheet would be an interruption.
 *
 * Dismissal collapses the height rather than snapping the layout, so the rows
 * below rise into the space instead of jumping. The parent still owns
 * visibility: we animate, then call `onDismiss`, and the parent unmounts us.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { runOnJS } from 'react-native-worklets';

import haptics from '@/lib/haptics';
import { useTheme, type Theme } from '@/theme';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';
import { Touchable } from './Touchable';

/* -------------------------------------------------------------------- types */

export type BannerTone = 'info' | 'warning' | 'danger' | 'success';
export type BannerEmphasis = 'quiet' | 'loud';

export type BannerAction = {
  label: string;
  onPress: () => void;
  icon?: IconName;
};

export type BannerProps = {
  message: string;
  /** Optional lead line. Without it the message carries the weight itself. */
  title?: string;
  tone?: BannerTone;
  icon?: IconName;
  action?: BannerAction;
  /** Adds a close control. Called *after* the collapse finishes. */
  onDismiss?: () => void;
  dismissLabel?: string;
  /** `loud` fills with the tone colour — for things that must not be scrolled past. */
  emphasis?: BannerEmphasis;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

type Skin = { background: string; ink: string; border: string; chip: string; onChip: string };

/* ---------------------------------------------------------------- constants */

const TONE_ICON: Record<BannerTone, IconName> = {
  info: 'information-circle-outline',
  warning: 'alert-circle-outline',
  danger: 'warning-outline',
  success: 'checkmark-circle-outline',
};

/** The banner shrinks slightly as it collapses, so it reads as leaving. */
const EXIT_SCALE = 0.04;

/* ------------------------------------------------------------------ helpers */

function toneSkin(t: Theme, tone: BannerTone, emphasis: BannerEmphasis): Skin {
  const map: Record<BannerTone, { fill: string; onFill: string; soft: string; onSoft: string }> = {
    info: {
      fill: t.color.info,
      onFill: t.color.onInfo,
      soft: t.color.infoSoft,
      onSoft: t.color.onInfoSoft,
    },
    warning: {
      fill: t.color.warning,
      onFill: t.color.onWarning,
      soft: t.color.warningSoft,
      onSoft: t.color.onWarningSoft,
    },
    danger: {
      fill: t.color.danger,
      onFill: t.color.onDanger,
      soft: t.color.dangerSoft,
      onSoft: t.color.onDangerSoft,
    },
    success: {
      fill: t.color.success,
      onFill: t.color.onSuccess,
      soft: t.color.successSoft,
      onSoft: t.color.onSuccessSoft,
    },
  };
  const c = map[tone];
  return emphasis === 'loud'
    ? { background: c.fill, ink: c.onFill, border: c.fill, chip: c.onFill, onChip: c.fill }
    : { background: c.soft, ink: c.onSoft, border: c.soft, chip: c.fill, onChip: c.onFill };
}

/* ---------------------------------------------------------------- component */

export function Banner({
  message,
  title,
  tone = 'info',
  icon,
  action,
  onDismiss,
  dismissLabel = 'Dismiss',
  emphasis = 'quiet',
  style,
  testID,
}: BannerProps) {
  const t = useTheme();
  const skin = toneSkin(t, tone, emphasis);
  const reduceMotion = t.reduceMotion;

  const [height, setHeight] = useState<number | null>(null);
  const [closing, setClosing] = useState(false);
  const measured = useSharedValue(0);
  const collapse = useSharedValue(0);

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const next = event.nativeEvent.layout.height;
      if (closing) return;
      measured.value = next;
      // Ignore sub-pixel noise from rotation and font-scale changes.
      setHeight((prev) => (prev !== null && Math.abs(prev - next) < 1 ? prev : next));
    },
    [closing, measured],
  );

  useEffect(() => {
    if (!closing || !onDismiss) return;
    collapse.value = withTiming(
      1,
      t.motion.timing(t.motion.duration.base, 'accelerate'),
      (finished) => {
        'worklet';
        if (finished) runOnJS(onDismiss)();
      },
    );
  }, [closing, collapse, onDismiss, t.motion]);

  const collapseStyle = useAnimatedStyle(() => ({
    height: measured.value * (1 - collapse.value),
    opacity: 1 - collapse.value,
    transform: [{ scale: 1 - collapse.value * EXIT_SCALE }],
  }));

  const handleDismiss = useCallback(() => {
    if (!onDismiss) return;
    haptics.tap();
    setClosing(true);
  }, [onDismiss]);

  const chip = t.spacing.xl + t.spacing.xxs;

  return (
    <Animated.View
      entering={
        reduceMotion
          ? FadeIn.duration(t.motion.duration.base)
          : FadeInDown.duration(t.motion.duration.base).easing(t.motion.easing.decelerate)
      }
      // No animated height until the first measurement — otherwise the banner
      // has to guess its own size and flashes at the wrong one.
      style={[height === null ? null : collapseStyle, styles.clip]}
      pointerEvents={closing ? 'none' : 'auto'}
      testID={testID}
    >
      <View
        onLayout={onLayout}
        accessibilityRole="alert"
        accessibilityLabel={title ? `${title}. ${message}` : message}
        style={[
          styles.row,
          {
            gap: t.spacing.md,
            padding: t.spacing.md,
            borderRadius: t.radius.lg,
            backgroundColor: skin.background,
            borderWidth: emphasis === 'quiet' ? t.borderWidth.hairline : 0,
            borderColor: skin.border,
          },
          style,
        ]}
      >
        <View
          style={[
            styles.center,
            { width: chip, height: chip, borderRadius: chip / 2, backgroundColor: skin.chip },
          ]}
        >
          <Icon name={icon ?? TONE_ICON[tone]} size="sm" color={skin.onChip} />
        </View>

        <View style={[styles.grow, { gap: t.spacing.hair }]}>
          {title ? (
            <Text variant="subheadStrong" color={skin.ink}>
              {title}
            </Text>
          ) : null}
          <Text variant={title ? 'footnote' : 'subhead'} color={skin.ink}>
            {message}
          </Text>

          {action ? (
            <Touchable
              accessibilityRole="button"
              accessibilityLabel={action.label}
              haptic="tap"
              onPress={action.onPress}
              pressScale="small"
              style={[styles.row, { gap: t.spacing.xxs, marginTop: t.spacing.xs }]}
            >
              {action.icon ? <Icon name={action.icon} size="xs" color={skin.ink} /> : null}
              <Text variant="buttonSmall" color={skin.ink} style={styles.underline}>
                {action.label}
              </Text>
            </Touchable>
          ) : null}
        </View>

        {onDismiss ? (
          // A Touchable rather than IconButton: the close glyph has to inherit
          // the banner's ink to stay legible on the `loud` fill.
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={dismissLabel}
            accessibilityHint="Hides this message."
            haptic="none"
            onPress={handleDismiss}
            pressScale="small"
            style={[styles.center, { padding: t.spacing.xxs, opacity: t.opacity.muted }]}
          >
            <Icon name="close" size="sm" color={skin.ink} />
          </Touchable>
        ) : null}
      </View>
    </Animated.View>
  );
}

/* ----------------------------------------------------------------- styles */

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  center: { alignItems: 'center', justifyContent: 'center' },
  grow: { flex: 1 },
  // The action reads as a link inside a paragraph, not as a second button.
  underline: { textDecorationLine: 'underline' },
});

export default Banner;
