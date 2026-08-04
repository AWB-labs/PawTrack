/**
 * Petal — declarative permission gating.
 *
 * Three denial treatments, and choosing between them is a product decision, not
 * a styling one:
 *
 *  · **hide** — for things a caregiver can *never* hold (delete the pet,
 *    transfer ownership, revoke another sitter). Showing a locked "Delete
 *    Buddy" button teaches nothing and reads as a threat.
 *  · **disable** — for things they *could* have been granted but weren't. This
 *    is the important one: the control stays visible and legible, dimmed, with
 *    a lock badge, and tapping it explains what to ask the owner for. That
 *    loop — see it, tap it, learn it, ask — is how a sitter's access grows
 *    without anyone opening a settings screen.
 *  · **explain** — for whole sections. Replaces the content with a designed
 *    locked panel instead of leaving a hole in the layout.
 *
 * `useGateStyle()` exists because some components (a swipe row, a chart, a
 * custom keypad) need to apply the disabled treatment inside their own layout
 * rather than under a wrapper. Same tokens, same a11y, no wrapper.
 */

import { Ionicons } from '@expo/vector-icons';
import { useCallback, useMemo, type ComponentProps, type ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  Text as RNText,
  View,
  type StyleProp,
  type TextProps as RNTextProps,
  type ViewStyle,
} from 'react-native';
import Animated, {
  FadeIn,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  type WithSpringConfig,
} from 'react-native-reanimated';

import {
  CAPABILITY_LABELS,
  DENIAL_COPY,
  type Capability,
  type DenialReason,
} from '@/rbac/permissions';
import { usePermission } from '@/rbac/usePermission';
import { makeStyles, useTheme, type SpringName, type Theme, type TypeVariant } from '@/theme';

/* ------------------------------------------------------------------- types */

export type PermissionGateMode = 'hide' | 'disable' | 'explain';

export type PermissionGateProps = {
  capability: Capability;
  petId: string | null | undefined;
  /** Defaults to `disable` — visible, dimmed and explainable. */
  mode?: PermissionGateMode;
  /**
   * Rendered instead of the built-in denied treatment in `hide` and `explain`
   * modes. Ignored in `disable`, where the children *are* the subject.
   */
  fallback?: ReactNode;
  /** Sharpens the denial copy — "Sitting Buddy", "Ask Priya". */
  petName?: string;
  ownerName?: string;
  /** Draw the small lock badge over disabled content. */
  lockAffordance?: boolean;
  lockPlacement?: 'corner' | 'center';
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
};

type IconName = ComponentProps<typeof Ionicons>['name'];

export type GateStyle = {
  locked: boolean;
  /**
   * Dim treatment for gated content. Uses `opacity.muted`, not
   * `opacity.disabled`: the caregiver still has to be able to *read* what
   * they're missing, otherwise "ask the owner for X" is unanswerable.
   */
  contentStyle: ViewStyle;
  /** For the wrapper directly around the gated content. */
  pointerEvents: 'auto' | 'none';
  /** Spread onto the control that opens the explanation. */
  a11y: { accessibilityState: { disabled: boolean } };
  /** Spread onto gated content so the explainer is the only screen-reader node. */
  hiddenFromScreenReaders: {
    accessibilityElementsHidden: boolean;
    importantForAccessibility: 'auto' | 'no-hide-descendants';
  };
  /** Tokens for drawing your own lock chip. */
  lock: {
    name: IconName;
    size: number;
    color: string;
    backgroundColor: string;
    borderColor: string;
  };
};

/* --------------------------------------------------------------- constants */

/** Amplitude of the lock badge's "yes, still locked" pulse. */
const LOCK_PULSE = 0.22;

/** Reasons that deserve a warmer-than-neutral panel colour. */
const ALERT_REASONS: readonly DenialReason[] = ['window-expired', 'revoked'];

const PANEL_ICON: Record<DenialReason, IconName> = {
  'no-membership': 'person-add-outline',
  'owner-only': 'shield-checkmark-outline',
  'not-granted': 'lock-closed-outline',
  'window-not-started': 'hourglass-outline',
  'window-expired': 'time-outline',
  'invite-pending': 'mail-unread-outline',
  revoked: 'close-circle-outline',
};

/**
 * `theme.motion.springWith()` currently infers a union that Reanimated's
 * `withSpring` rejects — its optional `overrides` spread widens the return type
 * (`src/theme/motion.ts`). Reading the named preset directly produces the
 * identical runtime config with a type `withSpring` accepts. Delete once the
 * theme pins `springWith`'s return type to `WithSpringConfig`.
 */
function springOf(t: Theme, name: SpringName): WithSpringConfig {
  return { ...t.motion.spring[name], reduceMotion: ReduceMotion.System };
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

/* ------------------------------------------------------------------ hooks */

/**
 * The disabled treatment as data, for components that own their own layout.
 *
 *   const { allowed, explain } = usePermission('feeding.log', petId);
 *   const gate = useGateStyle(allowed);
 *   <Pressable onPress={allowed ? logIt : explain} {...gate.a11y}>
 *     <View style={gate.contentStyle} pointerEvents={gate.pointerEvents}>…</View>
 *   </Pressable>
 */
export function useGateStyle(allowed: boolean): GateStyle {
  const t = useTheme();
  const locked = !allowed;

  return {
    locked,
    contentStyle: locked ? { opacity: t.opacity.muted } : {},
    pointerEvents: locked ? 'none' : 'auto',
    a11y: { accessibilityState: { disabled: locked } },
    hiddenFromScreenReaders: {
      accessibilityElementsHidden: locked,
      importantForAccessibility: locked ? 'no-hide-descendants' : 'auto',
    },
    lock: {
      name: 'lock-closed',
      size: t.spacing.md,
      color: t.color.textSecondary,
      backgroundColor: t.color.surfaceAlt,
      borderColor: t.color.border,
    },
  };
}

/* -------------------------------------------------------------- component */

export function PermissionGate({
  capability,
  petId,
  mode = 'disable',
  fallback,
  petName,
  ownerName,
  lockAffordance = true,
  lockPlacement = 'corner',
  style,
  children,
}: PermissionGateProps) {
  const t = useTheme();
  const styles = useStyles();
  const { allowed, reason, explain } = usePermission(capability, petId);
  const gate = useGateStyle(allowed);

  const pulse = useSharedValue(0);
  const pressSpring = useMemo(() => springOf(t, 'press'), [t]);

  const onLocked = useCallback(() => {
    pulse.value = withSequence(withSpring(1, pressSpring), withSpring(0, pressSpring));
    explain({ petName: petName ?? null, ownerName: ownerName ?? null });
  }, [pulse, pressSpring, explain, petName, ownerName]);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + pulse.value * LOCK_PULSE }],
  }));

  if (allowed) return <>{children}</>;

  if (mode === 'hide') return <>{fallback ?? null}</>;

  const denialReason: DenialReason = reason ?? 'not-granted';

  if (mode === 'explain') {
    if (fallback) return <>{fallback}</>;
    return (
      <LockedPanel
        reason={denialReason}
        onPress={onLocked}
        pulseStyle={pulseStyle}
        style={style}
      />
    );
  }

  const label = CAPABILITY_LABELS[capability];

  return (
    <Pressable
      onPress={onLocked}
      accessibilityRole="button"
      accessibilityLabel={`${label} — locked`}
      accessibilityHint="Explains why this is locked and what you can do instead."
      {...gate.a11y}
      style={style}
    >
      <View style={styles.disabledWrap}>
        <View
          pointerEvents={gate.pointerEvents}
          style={gate.contentStyle}
          {...gate.hiddenFromScreenReaders}
        >
          {children}
        </View>

        {lockAffordance ? (
          <Animated.View
            pointerEvents="none"
            entering={FadeIn.duration(t.motion.duration.fast)}
            style={[
              styles.lockChip,
              lockPlacement === 'corner' ? styles.lockCorner : styles.lockCenter,
              pulseStyle,
            ]}
          >
            <Ionicons name={gate.lock.name} size={gate.lock.size} color={gate.lock.color} />
          </Animated.View>
        ) : null}
      </View>
    </Pressable>
  );
}

export default PermissionGate;

/* ---------------------------------------------------------- locked panel */

type LockedPanelProps = {
  reason: DenialReason;
  onPress: () => void;
  /** Shared with the gate so tapping the panel pulses its own icon. */
  pulseStyle: StyleProp<ViewStyle>;
  style?: StyleProp<ViewStyle>;
};

function LockedPanel({ reason, onPress, pulseStyle, style }: LockedPanelProps) {
  const t = useTheme();
  const styles = useStyles();
  const copy = DENIAL_COPY[reason];
  const alert = ALERT_REASONS.includes(reason);
  const fill = alert ? t.color.warningSoft : t.color.surfaceAlt;
  const ink = alert ? t.color.onWarningSoft : t.color.textSecondary;

  const pressed = useSharedValue(0);
  const pressStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - pressed.value * (1 - t.motion.pressScale.large) }],
  }));

  return (
    <Pressable
      onPressIn={() => {
        pressed.value = withSpring(1, springOf(t, 'press'));
      }}
      onPressOut={() => {
        pressed.value = withSpring(0, springOf(t, 'press'));
      }}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${copy.title}. ${copy.body}`}
      accessibilityHint="Opens the full explanation."
      style={style}
    >
      <Animated.View
        entering={FadeIn.duration(t.motion.duration.base)}
        style={[styles.panel, pressStyle]}
      >
        <Animated.View style={[styles.panelIcon, { backgroundColor: fill }, pulseStyle]}>
          <Ionicons name={PANEL_ICON[reason]} size={t.spacing.lg} color={ink} />
        </Animated.View>

        <View style={styles.panelText}>
          <Label variant="subheadStrong" color={t.color.text}>
            {copy.title}
          </Label>
          <Label variant="footnote" color={t.color.textTertiary}>
            {copy.body}
          </Label>
        </View>

        <Ionicons name="chevron-forward" size={t.spacing.base} color={t.color.textTertiary} />
      </Animated.View>
    </Pressable>
  );
}

/* ----------------------------------------------------------------- styles */

const useStyles = makeStyles((t: Theme) =>
  StyleSheet.create({
    disabledWrap: {
      position: 'relative',
    },
    lockChip: {
      position: 'absolute',
      width: t.spacing.xl,
      height: t.spacing.xl,
      borderRadius: t.radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.color.surfaceAlt,
      borderWidth: t.borderWidth.hairline,
      borderColor: t.color.border,
      ...t.elevation(1),
    },
    lockCorner: {
      top: t.spacing.xs,
      right: t.spacing.xs,
    },
    lockCenter: {
      top: '50%',
      left: '50%',
      marginTop: -t.spacing.md,
      marginLeft: -t.spacing.md,
    },
    panel: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.md,
      padding: t.spacing.base,
      minHeight: t.minTarget,
      borderRadius: t.radius.lg,
      backgroundColor: t.color.surface,
      borderWidth: t.borderWidth.hairline,
      borderColor: t.color.border,
    },
    panelIcon: {
      width: t.spacing.xxl,
      height: t.spacing.xxl,
      borderRadius: t.radius.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    panelText: {
      flex: 1,
      gap: t.spacing.hair,
    },
  }),
);
