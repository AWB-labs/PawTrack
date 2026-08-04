/**
 * Petal — Avatar.
 *
 * The face of every pet and person in the app. Four things it gets right that
 * a bare `<Image/>` in a round `View` does not:
 *
 *   1. **The fallback is authored, not empty.** Initials sit on a deterministic
 *      tint derived from the name, so Buddy's avatar is the same warm ochre on
 *      every screen and every launch — recognisable before you read it.
 *   2. **The photo arrives, it doesn't pop.** The initials are always rendered
 *      underneath; the photo fades and settles over them. A failed load simply
 *      never uncovers, so there is no broken-image state to design.
 *   3. **Identity ring.** `theme.speciesColor()` gives each species a stable
 *      hue. On a caregiver's Today screen — three pets, three colours — that
 *      ring does more work than any label.
 *   4. **`live`** pulses a ring for a pet someone is actively sitting. It's the
 *      one piece of ambient motion in a list, so it respects `reduceMotion` and
 *      degrades to a static ring rather than disappearing.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { Image } from 'expo-image';

import { initials as toInitials } from '@/lib/format';
import { useTheme, type SpeciesKey, type Theme, type TypeVariant } from '@/theme';
import { Icon, type IconName } from './Icon';
import { resolveColor, Text, type ColorProp } from './Text';
import { Touchable } from './Touchable';

/* -------------------------------------------------------------------- types */

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl';

/** Corner status marker. `sitting` is Petal-specific: a caregiver is on duty. */
export type AvatarStatus = 'online' | 'sitting' | 'away' | 'attention' | 'alert';

export type AvatarProps = {
  /** Remote or local photo. Null falls back to initials. */
  uri?: string | null;
  /** Drives both the initials and the deterministic tint. */
  name?: string | null;
  /** Colours the identity ring and the fallback tint. */
  species?: SpeciesKey;
  size?: AvatarSize | number;
  shape?: 'circle' | 'rounded';
  /** Species identity ring. */
  ring?: boolean;
  /** Overrides the species-derived ring colour — e.g. a role or status hue. */
  ringColor?: ColorProp;
  /** Pulsing ring for a pet currently being sat. */
  live?: boolean;
  status?: AvatarStatus;
  /** The surface the avatar sits on — the status dot punches a hole in it. */
  surfaceColor?: ColorProp;
  /** Shown instead of initials when there's no name (a group, a clinic). */
  fallbackIcon?: IconName;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

export const AVATAR_SIZE: Record<AvatarSize, number> = {
  xs: 24,
  sm: 32,
  md: 40,
  lg: 56,
  xl: 80,
  xxl: 112,
};

/** Step, and the type variant whose cap-height fills that circle. */
const INITIALS_VARIANT: readonly [number, TypeVariant][] = [
  [28, 'caption'],
  [36, 'captionStrong'],
  [48, 'subheadStrong'],
  [68, 'headline'],
  [96, 'title2'],
  [Number.POSITIVE_INFINITY, 'display'],
];

/** Two rings, half a cycle apart, so the pulse never has a dead beat. */
const PULSE_PHASES = [0, 0.5] as const;
const PULSE_SCALE = 0.42;

/* ------------------------------------------------------------------ helpers */

/**
 * FNV-1a over code points. Any stable hash would do; what matters is that it
 * runs on the *name*, so the same pet keeps its colour across devices and
 * across a reinstall — no persisted seed to lose.
 */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (const ch of value) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function statusColor(t: Theme, status: AvatarStatus): string {
  switch (status) {
    case 'sitting':
      return t.color.accent;
    case 'away':
      return t.color.textTertiary;
    case 'attention':
      return t.color.warning;
    case 'alert':
      return t.color.danger;
    case 'online':
    default:
      return t.color.success;
  }
}

const STATUS_LABEL: Record<AvatarStatus, string> = {
  online: 'Online',
  sitting: 'Being sat right now',
  away: 'Away',
  attention: 'Needs attention',
  alert: 'Overdue',
};

/* ---------------------------------------------------------------- component */

export function Avatar({
  uri,
  name,
  species,
  size = 'md',
  shape = 'circle',
  ring = false,
  ringColor,
  live = false,
  status,
  surfaceColor = 'surface',
  fallbackIcon,
  onPress,
  onLongPress,
  accessibilityLabel,
  accessibilityHint,
  style,
  testID,
}: AvatarProps) {
  const t = useTheme();
  const px = typeof size === 'number' ? size : AVATAR_SIZE[size];

  const speciesKeys = useMemo(() => Object.keys(t.color.species) as SpeciesKey[], [t.color.species]);
  const identity = useMemo(() => {
    if (species) return t.speciesColor(species);
    const key = speciesKeys[hash(name ?? '') % speciesKeys.length] ?? 'other';
    return t.speciesColor(key);
  }, [name, species, speciesKeys, t]);

  const accent = ringColor === undefined ? identity.base : resolveColor(t.color, ringColor, identity.base);

  /* ---- photo reveal ---------------------------------------------------- */

  const reveal = useSharedValue(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // A new photo must start hidden, or the outgoing one cross-fades into the
    // incoming one mid-scroll on a recycled row.
    reveal.value = 0;
    setFailed(false);
  }, [reveal, uri]);

  const reduce = t.reduceMotion;
  const photoStyle = useAnimatedStyle(() => ({
    opacity: reveal.value,
    // A hair of settle, so the photo lands rather than blinking on.
    transform: reduce ? [] : [{ scale: 1.04 - reveal.value * 0.04 }],
  }));

  /* ---- live pulse ------------------------------------------------------ */

  const pulse = useSharedValue(0);
  useEffect(() => {
    if (!live || reduce) {
      cancelAnimation(pulse);
      pulse.value = 0;
      return;
    }
    pulse.value = 0;
    pulse.value = withRepeat(
      withTiming(1, t.motion.timing(t.motion.duration.ambient / 2, 'linear')),
      -1,
      false,
    );
    return () => cancelAnimation(pulse);
  }, [live, pulse, reduce, t.motion]);

  /* ---- geometry -------------------------------------------------------- */

  const ringWidth = t.borderWidth.thick;
  const ringGap = t.spacing.hair;
  const hasRing = ring || live;
  const inset = hasRing ? ringWidth + ringGap : 0;
  const outer = px + inset * 2;
  const radius = shape === 'circle' ? outer : Math.max(t.radius.sm, px * 0.28);
  const innerRadius = shape === 'circle' ? px : Math.max(t.radius.xs, px * 0.24);

  const variant = INITIALS_VARIANT.find(([step]) => px < step)?.[1] ?? 'headline';
  const label = toInitials(name ?? '');
  const dot = Math.min(t.spacing.base, Math.max(t.spacing.sm, Math.round(px * 0.28)));

  const description =
    accessibilityLabel ??
    (name ? (status ? `${name}. ${STATUS_LABEL[status]}` : name) : undefined);

  const body = (
    <View style={[{ width: outer, height: outer }, onPress ? null : style]} testID={testID}>
      {live
        ? PULSE_PHASES.map((phase) => (
            <PulseRing
              key={phase}
              phase={phase}
              progress={pulse}
              color={accent}
              radius={radius}
              width={ringWidth}
              frozen={reduce}
            />
          ))
        : null}

      <View
        style={{
          width: outer,
          height: outer,
          borderRadius: radius,
          padding: inset,
          borderWidth: hasRing ? ringWidth : 0,
          borderColor: hasRing ? accent : undefined,
        }}
      >
        <View
          style={{
            flex: 1,
            borderRadius: innerRadius,
            overflow: 'hidden',
            backgroundColor: identity.tint,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {fallbackIcon && !label ? (
            <Icon name={fallbackIcon} size={Math.round(px * 0.46)} color={identity.base} />
          ) : (
            <Text
              variant={variant}
              color={identity.base}
              numberOfLines={1}
              // The circle is a fixed size; letting initials grow 2× would
              // clip them. The name itself reaches VoiceOver via the label.
              maxFontSizeMultiplier={1.2}
              importantForAccessibility="no-hide-descendants"
            >
              {label}
            </Text>
          )}

          {uri && !failed ? (
            <Animated.View style={[StyleSheet.absoluteFill, photoStyle]}>
              <Image
                source={{ uri }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                cachePolicy="memory-disk"
                // The reveal is ours — expo-image's own transition would
                // double-fade and fight the settle.
                transition={0}
                recyclingKey={uri}
                accessible={false}
                onLoad={() => {
                  reveal.value = withTiming(1, t.motion.timing(t.motion.duration.base, 'decelerate'));
                }}
                onError={() => setFailed(true)}
              />
            </Animated.View>
          ) : null}
        </View>
      </View>

      {status ? (
        <View
          style={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            width: dot,
            height: dot,
            borderRadius: dot / 2,
            backgroundColor: statusColor(t, status),
            borderWidth: t.borderWidth.thick,
            borderColor: resolveColor(t.color, surfaceColor, t.color.surface),
          }}
        />
      ) : null}
    </View>
  );

  if (!onPress && !onLongPress) {
    return (
      <View
        accessible={description !== undefined}
        accessibilityRole={description === undefined ? 'none' : 'image'}
        accessibilityLabel={description}
        importantForAccessibility={description === undefined ? 'no-hide-descendants' : 'yes'}
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
      haptic="tap"
      onPress={onPress}
      onLongPress={onLongPress}
      pressScale="small"
      style={style}
    >
      {body}
    </Touchable>
  );
}

/* ------------------------------------------------------------------- pulse */

function PulseRing({
  phase,
  progress,
  color,
  radius,
  width,
  frozen,
}: {
  phase: number;
  progress: SharedValue<number>;
  color: string;
  radius: number;
  width: number;
  frozen: boolean;
}) {
  const style = useAnimatedStyle(() => {
    if (frozen) {
      // Reduced motion still needs the "live" signal, just held still.
      return { opacity: phase === 0 ? 0.32 : 0, transform: [{ scale: 1.12 }] };
    }
    const p = (progress.value + phase) % 1;
    return {
      opacity: 0.5 * (1 - p),
      transform: [{ scale: 1 + PULSE_SCALE * p }],
    };
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        { borderRadius: radius, borderWidth: width, borderColor: color },
        style,
      ]}
    />
  );
}

export default Avatar;
