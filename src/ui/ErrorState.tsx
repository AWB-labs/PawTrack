/**
 * Petal — ErrorState.
 *
 * The failure twin of `EmptyState`, and built with the same care, because the
 * moment something breaks is exactly when a person decides whether they trust
 * an app with their pet's medical records.
 *
 * The copy is never improvised at the call site: `lib/errors.ts` classifies the
 * throwable and returns a headline, a plain-language body and the affordance
 * that actually helps. A screen only has to say what to retry.
 *
 *   · **Cause-specific.** "You're offline" and "That's taking a while" are
 *     different problems with different fixes, so they get different words,
 *     different glyphs and different tones.
 *   · **The retry button spins while it works** rather than swapping to a
 *     spinner, so the control you pressed is visibly the thing that's busy.
 *   · **Offline gets its own illustration** — a dropped cloud — because it's
 *     the one failure that isn't Petal's fault and shouldn't look like a crash.
 */

import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Circle, G, Path, Svg } from 'react-native-svg';

import { classifyError, toUserMessage, type AppErrorKind, type UserMessage } from '@/lib/errors';
import { useTheme } from '@/theme';
import { Bloom, EmptyState, type EmptyStateAction, type EmptyStateTone, type EmptyStateVariant } from './EmptyState';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';
import { Touchable } from './Touchable';

/* -------------------------------------------------------------------- types */

export type ErrorStateProps = {
  /** Anything throwable. Classified into copy by `lib/errors.ts`. */
  error?: unknown;
  /** Overrides the derived headline. Use sparingly — the derived copy is tested. */
  title?: string;
  body?: string;
  onRetry?: () => void | Promise<unknown>;
  /** Controlled busy state. Omit and a promise-returning `onRetry` drives it. */
  retrying?: boolean;
  retryLabel?: string;
  secondaryAction?: EmptyStateAction;
  /** Force the offline treatment — e.g. when a NetInfo subscription knows better. */
  offline?: boolean;
  variant?: EmptyStateVariant;
  frame?: boolean;
  footer?: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export type RetryButtonProps = {
  label: string;
  onPress: () => void;
  busy?: boolean;
  size?: 'md' | 'lg';
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/** One glyph per failure shape. Ambiguity here costs a support email. */
const GLYPH: Record<AppErrorKind, IconName> = {
  permission: 'lock-closed-outline',
  offline: 'cloud-offline-outline',
  network: 'wifi-outline',
  timeout: 'hourglass-outline',
  auth: 'key-outline',
  notFound: 'help-circle-outline',
  conflict: 'git-compare-outline',
  validation: 'alert-circle-outline',
  rateLimit: 'time-outline',
  storage: 'document-attach-outline',
  cancelled: 'close-circle-outline',
  unsupported: 'phone-portrait-outline',
  unknown: 'sad-outline',
};

const TONE: Record<UserMessage['tone'], EmptyStateTone> = {
  info: 'info',
  warning: 'warning',
  danger: 'danger',
};

/** One full turn of the retry glyph. Slow enough to read as effort, not panic. */
const SPIN_DIVISOR = 4;

/* --------------------------------------------------------------- illustration */

/**
 * A cloud that has quietly let go of its signal. Deliberately calm — an angry
 * red cross for "your train went into a tunnel" is a lie about severity.
 */
export function OfflineCloud({ size }: { size: number }) {
  const t = useTheme();
  const body = t.color.infoSoft;
  const line = t.color.info;

  return (
    <View style={{ width: size, height: size }} pointerEvents="none">
      <Svg width={size} height={size} viewBox="0 0 120 120">
        <Path
          d="M36 78c-11 0-20-8.5-20-19s9-19 20-19c1.4 0 2.8.1 4.1.4C44.6 29.6 55.4 22 68 22c16.6 0 30 12.9 30 28.8 0 .6 0 1.2-.1 1.8C106 55 112 62.4 112 71c0 10.5-8.9 19-19.8 19H36z"
          fill={body}
        />
        <G opacity={0.9}>
          {/* Three fading drops: the signal, going. */}
          <Circle cx={46} cy={102} r={5} fill={line} fillOpacity={0.55} />
          <Circle cx={64} cy={104} r={4} fill={line} fillOpacity={0.35} />
          <Circle cx={80} cy={101} r={3} fill={line} fillOpacity={0.2} />
        </G>
        <Path
          d="M28 24 L96 92"
          stroke={line}
          strokeWidth={5}
          strokeLinecap="round"
          strokeOpacity={0.5}
          fill="none"
        />
      </Svg>
    </View>
  );
}

/* -------------------------------------------------------------- retry button */

/**
 * The retry control. It keeps its label while it works — a button that
 * collapses to a spinner makes you wonder whether you pressed the right thing.
 */
export function RetryButton({ label, onPress, busy = false, size = 'lg', testID }: RetryButtonProps) {
  const t = useTheme();
  const phase = useSharedValue(0);
  const reduceMotion = t.reduceMotion;

  useEffect(() => {
    if (!busy) {
      cancelAnimation(phase);
      // Settle upright rather than freezing mid-turn.
      phase.value = withTiming(0, t.motion.timing(t.motion.duration.fast, 'smooth'));
      return;
    }
    phase.value = 0;
    phase.value = withRepeat(
      withTiming(1, {
        duration: t.motion.duration.ambient / SPIN_DIVISOR,
        easing: t.motion.easing.linear,
        // This loop *is* the busy signal; ReduceMotion.System would zero the
        // duration and spin the thread. The style below drops the rotation.
        reduceMotion: ReduceMotion.Never,
      }),
      -1,
      false,
    );
    return () => cancelAnimation(phase);
  }, [busy, phase, t.motion]);

  const glyphStyle = useAnimatedStyle(() => {
    if (reduceMotion) {
      const wave = 0.5 + 0.5 * Math.cos(2 * Math.PI * phase.value);
      return { opacity: busy ? 0.4 + 0.6 * wave : 1, transform: [{ rotate: '0deg' }] };
    }
    return { opacity: 1, transform: [{ rotate: `${phase.value * 360}deg` }] };
  }, [reduceMotion, busy]);

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy }}
      haptic="commit"
      onPress={busy ? undefined : onPress}
      pressScale="medium"
      style={[
        t.elevation(1),
        t.glow(t.color.primary),
        styles.retry,
        {
          backgroundColor: t.color.primary,
          borderRadius: t.radius.xl,
          gap: t.spacing.sm,
          paddingVertical: size === 'lg' ? t.spacing.base : t.spacing.md,
          paddingHorizontal: t.spacing.xl,
        },
      ]}
      testID={testID}
    >
      <Animated.View style={glyphStyle}>
        <Icon name="refresh" size="md" color={t.color.onPrimary} />
      </Animated.View>
      <Text variant="button" color={t.color.onPrimary} numberOfLines={1}>
        {busy ? 'Trying…' : label}
      </Text>
    </Touchable>
  );
}

/* ---------------------------------------------------------------- component */

export function ErrorState({
  error,
  title,
  body,
  onRetry,
  retrying,
  retryLabel,
  secondaryAction,
  offline,
  variant = 'full',
  frame = false,
  footer,
  style,
  testID,
}: ErrorStateProps) {
  const t = useTheme();
  const [pending, setPending] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const kind = classifyError(error).kind;
  const isOffline = offline ?? kind === 'offline';
  const message = toUserMessage(error);
  const busy = retrying ?? pending;

  const handleRetry = useCallback(() => {
    if (!onRetry) return;
    const result = onRetry();
    if (!isPromise(result)) return;
    setPending(true);
    void result.finally(() => {
      if (alive.current) setPending(false);
    });
  }, [onRetry]);

  const tone: EmptyStateTone = isOffline ? 'info' : TONE[message.tone];
  const bloom = variant === 'compact' ? t.spacing.giant + t.spacing.md : t.spacing.colossal + t.spacing.huge;

  return (
    <EmptyState
      testID={testID}
      variant={variant}
      frame={frame}
      style={style}
      tone={tone}
      illustration={
        isOffline ? (
          <OfflineCloud size={bloom} />
        ) : (
          <Bloom size={bloom} icon={GLYPH[kind]} tone={tone} />
        )
      }
      headline={title ?? (isOffline ? 'You’re offline' : message.title)}
      body={body ?? (isOffline ? OFFLINE_BODY : message.body)}
      actions={
        onRetry || secondaryAction ? (
          <View style={[styles.actions, { gap: t.spacing.sm }]}>
            {onRetry ? (
              <RetryButton
                label={retryLabel ?? message.actionLabel ?? 'Try again'}
                onPress={handleRetry}
                busy={busy}
                size={variant === 'compact' ? 'md' : 'lg'}
              />
            ) : null}
            {secondaryAction ? (
              <Touchable
                accessibilityRole="button"
                accessibilityLabel={secondaryAction.label}
                accessibilityHint={secondaryAction.accessibilityHint}
                disabled={secondaryAction.disabled}
                disabledReason={secondaryAction.disabledReason}
                haptic="tap"
                onPress={secondaryAction.onPress}
                pressScale="medium"
                style={[styles.retry, { gap: t.spacing.xs, paddingVertical: t.spacing.md, paddingHorizontal: t.spacing.base }]}
              >
                {secondaryAction.icon ? (
                  <Icon name={secondaryAction.icon} size="sm" color="primaryText" />
                ) : null}
                <Text variant="buttonSmall" color="primaryText">
                  {secondaryAction.label}
                </Text>
              </Touchable>
            ) : null}
          </View>
        ) : undefined
      }
      footer={footer ?? (__DEV__ && !isOffline ? <DebugLine detail={debugFor(error)} /> : undefined)}
    />
  );
}

/* ------------------------------------------------------------------ helpers */

const OFFLINE_BODY =
  'Furry Tracker can’t reach the network right now. Nothing you logged is lost — it’ll be here when you reconnect.';

function isPromise(value: unknown): value is Promise<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as Promise<unknown>).then === 'function';
}

function debugFor(error: unknown): string | null {
  if (error === undefined || error === null) return null;
  return classifyError(error).debug;
}

/** Development-only breadcrumb, so the original throwable is one glance away. */
function DebugLine({ detail }: { detail: string | null }) {
  const t = useTheme();
  if (!detail) return null;
  return (
    <View style={{ maxWidth: t.spacing.colossal * 4, paddingTop: t.spacing.xs }}>
      <Text variant="caption" color="textFaint" align="center" numberOfLines={3}>
        {detail}
      </Text>
    </View>
  );
}

/* ----------------------------------------------------------------- styles */

const styles = StyleSheet.create({
  retry: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  actions: { alignItems: 'center' },
});

export default ErrorState;
