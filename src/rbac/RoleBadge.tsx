/**
 * Petal — role indicator.
 *
 * The same person owns Buddy and sits for Mochi, so "which hat am I wearing
 * right now" has to be answerable in a glance, on any screen, without reading.
 * That means two things: distinct *hue* (moss for owner, blossom for sitter —
 * not two greys with different words in them) and a distinct *glyph*, because
 * roughly one man in twelve can't lean on the hue alone.
 *
 * The optional second segment carries the sitting window, which is the other
 * half of "what am I allowed to do": a sitter whose dates start on Monday is
 * functionally read-only today, and the badge should say so before they tap
 * something and get a denial sheet.
 */

import { Ionicons } from '@expo/vector-icons';
import { differenceInCalendarDays, format, isSameYear } from 'date-fns';
import { useEffect, type ComponentProps } from 'react';
import {
  StyleSheet,
  Text as RNText,
  View,
  type StyleProp,
  type TextProps as RNTextProps,
  type ViewStyle,
} from 'react-native';
import Animated, {
  FadeIn,
  LinearTransition,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { windowState, type Membership, type MembershipRole } from '@/rbac/permissions';
import { useNow } from '@/rbac/usePermission';
import { makeStyles, useTheme, type Theme, type TypeVariant } from '@/theme';

/* ------------------------------------------------------------------- types */

export type RoleBadgeSize = 'sm' | 'md';

export type RoleBadgeProps = {
  role: MembershipRole;
  size?: RoleBadgeSize;
  /** Supply to append the window segment ("Sitting until Fri", "Ended"). */
  membership?: Membership | null;
  /** Set false to keep the badge to the role alone. */
  showWindow?: boolean;
  style?: StyleProp<ViewStyle>;
};

type IconName = ComponentProps<typeof Ionicons>['name'];

/** How the window reads emotionally, which decides its colour. */
type WindowTone = 'live' | 'soon' | 'over';

type WindowInfo = { text: string; tone: WindowTone };

/* --------------------------------------------------------------- constants */

const ROLE_META: Record<MembershipRole, { label: string; icon: IconName }> = {
  owner: { label: 'Owner', icon: 'shield-checkmark' },
  caregiver: { label: 'Sitter', icon: 'home' },
};

/** Breathing rate for the "currently sitting" dot. */
const PULSE_DIVISOR = 3;
const DOT_MIN_OPACITY = 0.4;
const DOT_MIN_SCALE = 0.82;

/* ---------------------------------------------------------------- helpers */

function shortDay(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const delta = differenceInCalendarDays(date, now);
  if (delta === 0) return 'today';
  if (delta === 1) return 'tomorrow';
  if (delta === -1) return 'yesterday';
  if (Math.abs(delta) < 7) return format(date, 'EEE');
  return format(date, isSameYear(date, now) ? 'd MMM' : "d MMM ''yy");
}

function describeWindow(
  membership: Membership,
  now: Date,
  size: RoleBadgeSize,
): WindowInfo | null {
  // Ownership is the root grant — it is never time-boxed, so a window segment
  // on an owner badge would be a lie.
  if (membership.role === 'owner') return null;

  if (membership.status === 'pending') return { text: 'Invite pending', tone: 'soon' };
  if (membership.status === 'revoked') return { text: 'Access removed', tone: 'over' };
  if (membership.status === 'expired') return { text: 'Ended', tone: 'over' };

  const compact = size === 'sm';

  switch (windowState(membership, now)) {
    case 'upcoming':
      return membership.startsAt
        ? { text: `Starts ${shortDay(membership.startsAt, now)}`, tone: 'soon' }
        : null;
    case 'ended':
      return { text: 'Ended', tone: 'over' };
    case 'open-ended':
      return { text: compact ? 'Ongoing' : 'No end date', tone: 'live' };
    default:
      return membership.endsAt
        ? {
            text: `${compact ? 'Until' : 'Sitting until'} ${shortDay(membership.endsAt, now)}`,
            tone: 'live',
          }
        : { text: 'Ongoing', tone: 'live' };
  }
}

function windowColors(t: Theme, tone: WindowTone): { fill: string; ink: string } {
  switch (tone) {
    case 'soon':
      return { fill: t.color.warningSoft, ink: t.color.onWarningSoft };
    case 'over':
      return { fill: t.color.dangerSoft, ink: t.color.onDangerSoft };
    default:
      return { fill: t.color.successSoft, ink: t.color.onSuccessSoft };
  }
}

/* --------------------------------------------------------------- local UI */

/** Stand-in for `@/ui/Text` while the primitives land — same ramp, same caps. */
type LabelProps = RNTextProps & { variant?: TypeVariant; color?: string };

function Label({ variant = 'body', color, style, ...rest }: LabelProps) {
  const t = useTheme();
  const { maxFontSizeMultiplier, ...typeStyle } = t.type[variant];
  return (
    <RNText
      {...rest}
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      style={[typeStyle, color ? { color } : null, style]}
    />
  );
}

/* -------------------------------------------------------------- component */

export function RoleBadge({
  role,
  size = 'md',
  membership,
  showWindow = true,
  style,
}: RoleBadgeProps) {
  const t = useTheme();
  const styles = useStyles();
  const now = useNow();

  const meta = ROLE_META[role];
  const info = showWindow && membership ? describeWindow(membership, now, size) : null;
  const tone = info ? windowColors(t, info.tone) : null;
  const isLive = info?.tone === 'live';

  const pulse = useSharedValue(0);

  useEffect(() => {
    if (!isLive || t.reduceMotion) {
      cancelAnimation(pulse);
      pulse.value = 1;
      return;
    }
    pulse.value = withRepeat(
      withTiming(1, t.motion.timing(t.motion.duration.ambient / PULSE_DIVISOR, 'smooth')),
      -1,
      true,
    );
    return () => cancelAnimation(pulse);
  }, [isLive, t.reduceMotion, t.motion, pulse]);

  const dotStyle = useAnimatedStyle(() => ({
    opacity: DOT_MIN_OPACITY + pulse.value * (1 - DOT_MIN_OPACITY),
    transform: [{ scale: DOT_MIN_SCALE + pulse.value * (1 - DOT_MIN_SCALE) }],
  }));

  const compact = size === 'sm';
  const iconSize = compact ? t.spacing.md : t.spacing.base;
  const textVariant: TypeVariant = compact ? 'caption' : 'subheadStrong';

  const roleFill = role === 'owner' ? t.color.primarySoft : t.color.accentSoft;
  const roleInk = role === 'owner' ? t.color.onPrimarySoft : t.color.onAccentSoft;

  const spoken = info
    ? `${meta.label}. ${info.text}.`
    : role === 'owner'
      ? 'Owner of this pet'
      : 'Sitter for this pet';

  return (
    <Animated.View
      layout={LinearTransition.duration(t.motion.duration.base)}
      accessible
      accessibilityRole="text"
      accessibilityLabel={spoken}
      style={[styles.shell, style]}
    >
      <View
        style={[
          styles.segment,
          compact ? styles.segmentSm : styles.segmentMd,
          { backgroundColor: roleFill },
        ]}
      >
        <Ionicons name={meta.icon} size={iconSize} color={roleInk} />
        <Label variant={textVariant} color={roleInk} numberOfLines={1}>
          {meta.label}
        </Label>
      </View>

      {info && tone ? (
        <Animated.View
          entering={FadeIn.duration(t.motion.duration.base)}
          layout={LinearTransition.duration(t.motion.duration.base)}
          style={[
            styles.segment,
            compact ? styles.segmentSm : styles.segmentMd,
            styles.windowSegment,
            { backgroundColor: tone.fill },
          ]}
        >
          {isLive ? (
            <Animated.View style={[styles.dot, { backgroundColor: tone.ink }, dotStyle]} />
          ) : null}
          <Label
            variant={textVariant}
            color={tone.ink}
            numberOfLines={1}
            style={styles.windowText}
          >
            {info.text}
          </Label>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

export default RoleBadge;

/* ----------------------------------------------------------------- styles */

const useStyles = makeStyles((t: Theme) =>
  StyleSheet.create({
    shell: {
      flexDirection: 'row',
      alignItems: 'stretch',
      alignSelf: 'flex-start',
      borderRadius: t.radius.pill,
      overflow: 'hidden',
      maxWidth: '100%',
    },
    segment: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    segmentSm: {
      gap: t.spacing.xxs,
      paddingVertical: t.spacing.xxs,
      paddingHorizontal: t.spacing.sm,
    },
    segmentMd: {
      gap: t.spacing.xs,
      paddingVertical: t.spacing.xs,
      paddingHorizontal: t.spacing.md,
    },
    windowSegment: {
      flexShrink: 1,
      borderLeftWidth: t.borderWidth.hairline,
      borderLeftColor: t.color.surface,
    },
    windowText: {
      flexShrink: 1,
    },
    dot: {
      width: t.spacing.xs,
      height: t.spacing.xs,
      borderRadius: t.radius.pill,
    },
  }),
);
