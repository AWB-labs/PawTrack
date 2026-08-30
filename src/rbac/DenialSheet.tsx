/**
 * Petal — the denial explainer.
 *
 * The brief's rule: never render a raw denial string, and never use `Alert`.
 * A caregiver who taps a locked control deserves three things in one breath —
 * *why* it's locked, *what they can do instead*, and *how to ask for more*.
 * An OS alert can deliver none of them; it can't show dates, it can't show a
 * capability list, and it looks like an error even when nothing went wrong.
 *
 * So this is a self-contained bottom sheet: an animated RN `Modal` driven by
 * Reanimated, with a drag-to-dismiss grabber. It deliberately does *not* depend
 * on the shared `ui/Sheet` primitive — a permission explainer that can't render
 * because a UI component is mid-refactor is worse than no explainer at all.
 *
 * Usage is imperative on purpose. Denials happen in callbacks (a press handler,
 * a mutation's `onError`), not in render, so the API is a function call:
 *
 *   showDenial('not-granted', { capability: 'feeding.log', petId, petName });
 *
 * `<DenialSheetHost />` is mounted once, at the app root. A denial raised
 * before it mounts is queued and flushed rather than swallowed.
 */

import { Ionicons } from '@expo/vector-icons';
import { differenceInCalendarDays, format, formatDistanceToNowStrict, isSameYear } from 'date-fns';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text as RNText,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type TextProps as RNTextProps,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
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
import { runOnJS } from 'react-native-worklets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import haptics from '@/lib/haptics';
import {
  CAPABILITY_LABELS,
  DENIAL_COPY,
  effectiveCapabilities,
  type Capability,
  type DenialReason,
  type Membership,
} from '@/rbac/permissions';
import { useSession } from '@/stores/session';
import { makeStyles, useTheme, type SpringName, type Theme, type TypeVariant } from '@/theme';

/* ------------------------------------------------------------------- types */

export type DenialContext = {
  capability?: Capability | null;
  petId?: string | null;
  /** Makes the copy specific: "…to log Buddy's meals". */
  petName?: string | null;
  /** Turns "Ask the owner" into "Ask Priya". */
  ownerName?: string | null;
  /**
   * The membership the verdict came from. Optional — the host resolves it from
   * the session store when the caller doesn't have it to hand.
   */
  membership?: Membership | null;
};

export type AskOwnerInput = {
  petName?: string | null;
  ownerName?: string | null;
  capability?: Capability | null;
  reason?: DenialReason | null;
};

type DenialRequest = { id: number; reason: DenialReason; context: DenialContext };

type IconName = ComponentProps<typeof Ionicons>['name'];

type Tone = 'neutral' | 'info' | 'warning' | 'danger';

/* ------------------------------------------------------------ imperative */

const listeners = new Set<(request: DenialRequest) => void>();
let sequence = 0;
/** Held for a host that hasn't mounted yet — a denial must never vanish. */
let queued: DenialRequest | null = null;

/**
 * Open the explainer. Safe to call from anywhere, including a data-layer error
 * handler that caught a `PermissionError`.
 */
export function showDenial(reason: DenialReason, context: DenialContext = {}): void {
  const request: DenialRequest = { id: ++sequence, reason, context };
  if (listeners.size === 0) {
    queued = request;
    return;
  }
  for (const listener of listeners) listener(request);
}

/**
 * Compose the "can I have more access?" message and hand it to the OS share
 * sheet. The user picks the app and the recipient — we only write the words,
 * because a sitter staring at a blank message box usually just gives up.
 */
export async function askOwnerForAccess(input: AskOwnerInput): Promise<void> {
  const pet = input.petName?.trim() || 'your pet';
  const owner = input.ownerName?.trim();
  const greeting = owner ? `Hi ${owner}!` : 'Hi!';
  const wanted = input.capability ? CAPABILITY_LABELS[input.capability].toLowerCase() : null;

  let body: string;
  switch (input.reason) {
    case 'no-membership':
    case 'invite-pending':
      body = `Could you send me a Petal invite for ${pet}? Then I can see the schedule and keep everything logged while I'm helping out.`;
      break;
    case 'window-expired':
      body = `My sitting dates for ${pet} have finished in Petal. Could you extend them if you'd like me to carry on?`;
      break;
    default:
      body = wanted
        ? `I'm looking after ${pet} in Petal but I can't ${wanted} yet. Could you add that to my access? It's under Caregivers → my name → Permissions.`
        : `I'm looking after ${pet} in Petal and could use a bit more access. Could you take a look under Caregivers → my name → Permissions?`;
  }

  try {
    await Share.share({ message: `${greeting} ${body}` });
  } catch {
    /* the user backed out of the share sheet — nothing to recover from */
  }
}

/* -------------------------------------------------------------- metadata */

const TONE_BY_REASON: Record<DenialReason, Tone> = {
  'no-membership': 'neutral',
  'owner-only': 'neutral',
  'not-granted': 'info',
  'window-not-started': 'info',
  'window-expired': 'warning',
  'invite-pending': 'info',
  revoked: 'danger',
};

const ICON_BY_REASON: Record<DenialReason, IconName> = {
  'no-membership': 'person-add-outline',
  'owner-only': 'shield-checkmark-outline',
  'not-granted': 'lock-closed-outline',
  'window-not-started': 'hourglass-outline',
  'window-expired': 'time-outline',
  'invite-pending': 'mail-unread-outline',
  revoked: 'close-circle-outline',
};

/** Whether the sheet offers to compose a message, and what the button says. */
const ACTION_BY_REASON: Record<DenialReason, { ask: boolean; label: (owner: string) => string }> = {
  'no-membership': { ask: true, label: () => 'Ask for an invite' },
  'owner-only': { ask: false, label: () => 'Got it' },
  'not-granted': { ask: true, label: (owner) => `Ask ${owner}` },
  'window-not-started': { ask: false, label: () => 'Got it' },
  'window-expired': { ask: true, label: (owner) => `Ask ${owner} to extend` },
  'invite-pending': { ask: false, label: () => 'Got it' },
  revoked: { ask: false, label: () => 'Got it' },
};

/** Doing beats looking, so grants that change something are listed first. */
const ACTION_SUFFIXES = ['.log', '.edit', '.create', '.upload', '.post'];
const isActionCapability = (capability: Capability) =>
  ACTION_SUFFIXES.some((suffix) => capability.endsWith(suffix));

const MAX_ALTERNATIVES = 5;
const DRAG_CLOSE_DISTANCE = 88;
const DRAG_CLOSE_VELOCITY = 900;
/** Used until the sheet reports its real height on first layout. */
const FALLBACK_TRAVEL = 620;

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

function toneColors(t: Theme, tone: Tone): { fill: string; ink: string } {
  switch (tone) {
    case 'warning':
      return { fill: t.color.warningSoft, ink: t.color.onWarningSoft };
    case 'danger':
      return { fill: t.color.dangerSoft, ink: t.color.onDangerSoft };
    case 'info':
      return { fill: t.color.infoSoft, ink: t.color.onInfoSoft };
    default:
      return { fill: t.color.primarySoft, ink: t.color.onPrimarySoft };
  }
}

function formatDay(value: string, now: Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return format(date, isSameYear(date, now) ? 'EEE d MMM' : 'd MMM yyyy');
}

/* --------------------------------------------------------------- local UI */

/** Stand-in for `@/ui/Text` while the primitives land — same type ramp, same caps. */
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

type ActionButtonProps = {
  label: string;
  onPress: () => void;
  variant: 'primary' | 'quiet';
  icon?: IconName;
};

function ActionButton({ label, onPress, variant, icon }: ActionButtonProps) {
  const t = useTheme();
  const styles = useStyles();
  const pressed = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - pressed.value * (1 - t.motion.pressScale.medium) }],
  }));

  const isPrimary = variant === 'primary';

  return (
    <Pressable
      onPressIn={() => {
        pressed.value = withSpring(1, springOf(t, 'press'));
      }}
      onPressOut={() => {
        pressed.value = withSpring(0, springOf(t, 'press'));
      }}
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={styles.buttonHit}
    >
      <Animated.View
        style={[isPrimary ? styles.buttonPrimary : styles.buttonQuiet, animatedStyle]}
      >
        {icon ? (
          <Ionicons
            name={icon}
            size={t.spacing.lg}
            color={isPrimary ? t.color.onPrimary : t.color.textSecondary}
          />
        ) : null}
        <Label
          variant="button"
          color={isPrimary ? t.color.onPrimary : t.color.textSecondary}
          numberOfLines={1}
        >
          {label}
        </Label>
      </Animated.View>
    </Pressable>
  );
}

/* ------------------------------------------------------------------- host */

export type DenialSheetHostProps = {
  /** Overrides the default "the owner" wording when the app knows better. */
  fallbackOwnerName?: string;
};

/**
 * Mount once, above the navigator, inside `<ThemeProvider>`. Everything else
 * talks to it through `showDenial()`.
 */
export function DenialSheetHost({ fallbackOwnerName }: DenialSheetHostProps = {}) {
  const t = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();

  const [request, setRequest] = useState<DenialRequest | null>(null);
  const progress = useSharedValue(0);
  const dragY = useSharedValue(0);
  const sheetHeight = useSharedValue(FALLBACK_TRAVEL);
  const closingRef = useRef(false);

  const memberships = useSession((s) => s.memberships);
  const userId = useSession((s) => s.user?.id);

  useEffect(() => {
    const listener = (next: DenialRequest) => setRequest(next);
    listeners.add(listener);
    if (queued) {
      const flush = queued;
      queued = null;
      listener(flush);
    }
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const clear = useCallback(() => {
    closingRef.current = false;
    setRequest(null);
  }, []);

  const dismiss = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    progress.value = withTiming(
      0,
      t.motion.timing(t.motion.duration.fast, 'accelerate'),
      (finished) => {
        'worklet';
        if (finished) runOnJS(clear)();
      },
    );
  }, [clear, progress, t.motion]);

  useEffect(() => {
    if (!request) return;
    closingRef.current = false;
    dragY.value = 0;
    progress.value = withSpring(1, springOf(t, 'heavy'));
    haptics.warn();
  }, [request, dragY, progress, t.motion]);

  // Resolved on the JS thread: `springOf` is a plain function and cannot run
  // inside the gesture worklet, but the config object it returns serialises.
  const settleSpring = useMemo(() => springOf(t, 'snappy'), [t.motion]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .onUpdate((event) => {
          dragY.value = Math.max(0, event.translationY);
        })
        .onEnd((event) => {
          if (dragY.value > DRAG_CLOSE_DISTANCE || event.velocityY > DRAG_CLOSE_VELOCITY) {
            runOnJS(dismiss)();
          } else {
            dragY.value = withSpring(0, settleSpring);
          }
        }),
    [dragY, dismiss, settleSpring],
  );

  const reduceMotion = t.reduceMotion;

  const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value }));

  const sheetStyle = useAnimatedStyle(() => {
    const travel = reduceMotion ? 0 : sheetHeight.value;
    return {
      opacity: progress.value,
      transform: [{ translateY: (1 - progress.value) * travel + dragY.value }],
    };
  }, [reduceMotion]);

  const onSheetLayout = useCallback(
    (event: LayoutChangeEvent) => {
      sheetHeight.value = event.nativeEvent.layout.height;
    },
    [sheetHeight],
  );

  /* ------------------------------------------------------------- content */

  const now = useMemo(() => new Date(), [request?.id]);

  const membership = useMemo(() => {
    if (request?.context.membership !== undefined) return request.context.membership;
    const petId = request?.context.petId;
    if (!petId || !Array.isArray(memberships)) return null;
    return (
      memberships.find((m) => m.petId === petId && (!userId || m.userId === userId)) ??
      memberships.find((m) => m.petId === petId) ??
      null
    );
  }, [request, memberships, userId]);

  const alternatives = useMemo(() => {
    if (!membership) return [];
    const granted = effectiveCapabilities(membership, now);
    return [...granted]
      .sort((a, b) => Number(isActionCapability(b)) - Number(isActionCapability(a)))
      .slice(0, MAX_ALTERNATIVES);
  }, [membership, now]);

  const ownerName = request?.context.ownerName?.trim() || fallbackOwnerName?.trim() || 'the owner';
  const petName = request?.context.petName?.trim() || null;

  const onAsk = useCallback(() => {
    if (!request) return;
    void askOwnerForAccess({
      petName,
      ownerName: request.context.ownerName ?? fallbackOwnerName ?? null,
      capability: request.context.capability ?? null,
      reason: request.reason,
    });
    dismiss();
  }, [request, petName, fallbackOwnerName, dismiss]);

  if (!request) return null;

  const { reason, context } = request;
  const copy = DENIAL_COPY[reason];
  const tone = toneColors(t, TONE_BY_REASON[reason]);
  const action = ACTION_BY_REASON[reason];
  const showsWindow =
    (reason === 'window-not-started' || reason === 'window-expired') &&
    Boolean(membership?.startsAt || membership?.endsAt);

  const enter = (index: number) =>
    reduceMotion
      ? FadeIn.duration(t.motion.duration.fast)
      : FadeInDown.duration(t.motion.duration.base)
          .delay(index * t.motion.stagger.tight)
          .easing(t.motion.easing.decelerate);

  const windowStart = membership?.startsAt ? formatDay(membership.startsAt, now) : null;
  const windowEnd = membership?.endsAt ? formatDay(membership.endsAt, now) : null;
  const windowRelative = (() => {
    if (reason === 'window-not-started' && membership?.startsAt) {
      const days = differenceInCalendarDays(new Date(membership.startsAt), now);
      if (days <= 0) return 'Starts later today';
      if (days === 1) return 'Starts tomorrow';
      return `Starts ${formatDistanceToNowStrict(new Date(membership.startsAt), { addSuffix: true })}`;
    }
    if (reason === 'window-expired' && membership?.endsAt) {
      return `Ended ${formatDistanceToNowStrict(new Date(membership.endsAt), { addSuffix: true })}`;
    }
    return null;
  })();

  return (
    <Modal
      visible
      transparent
      statusBarTranslucent
      animationType="none"
      onRequestClose={dismiss}
    >
      <GestureHandlerRootView style={styles.root}>
        <View style={styles.root} accessibilityViewIsModal>
          <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, backdropStyle]}>
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={dismiss}
              accessibilityRole="button"
              accessibilityLabel="Dismiss"
              accessibilityHint="Closes this explanation."
            />
          </Animated.View>

          <Animated.View
            onLayout={onSheetLayout}
            style={[
              styles.sheet,
              { maxHeight: windowHeight * 0.86, paddingBottom: insets.bottom + t.spacing.lg },
              sheetStyle,
            ]}
          >
            <GestureDetector gesture={pan}>
              <View style={styles.grabArea}>
                <View style={styles.grabber} />
              </View>
            </GestureDetector>

            <ScrollView
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
              bounces={false}
            >
              <Animated.View
                entering={enter(0)}
                style={[styles.iconRing, { backgroundColor: tone.fill }]}
              >
                <Ionicons name={ICON_BY_REASON[reason]} size={t.spacing.xl} color={tone.ink} />
              </Animated.View>

              <Animated.View entering={enter(1)}>
                <Label variant="title2" color={t.color.text} style={styles.title}>
                  {copy.title}
                </Label>
              </Animated.View>

              <Animated.View entering={enter(2)}>
                <Label variant="callout" color={t.color.textSecondary} style={styles.body}>
                  {copy.body}
                </Label>
              </Animated.View>

              {context.capability ? (
                <Animated.View entering={enter(3)} style={styles.capabilityChip}>
                  <Ionicons name="lock-closed" size={t.spacing.md} color={t.color.textTertiary} />
                  <Label variant="subheadStrong" color={t.color.textSecondary} numberOfLines={1}>
                    {CAPABILITY_LABELS[context.capability]}
                  </Label>
                </Animated.View>
              ) : null}

              {showsWindow ? (
                <Animated.View entering={enter(4)} style={styles.windowCard}>
                  <View style={styles.windowHeader}>
                    <Ionicons
                      name="calendar-outline"
                      size={t.spacing.base}
                      color={t.color.textTertiary}
                    />
                    <Label variant="overline" color={t.color.textTertiary}>
                      {petName ? `Sitting ${petName}` : 'Your dates'}
                    </Label>
                  </View>
                  <View style={styles.windowDates}>
                    <Label variant="bodyStrong" color={t.color.text}>
                      {windowStart ?? 'Any time'}
                    </Label>
                    <Ionicons
                      name="arrow-forward"
                      size={t.spacing.base}
                      color={t.color.textTertiary}
                    />
                    <Label variant="bodyStrong" color={t.color.text}>
                      {windowEnd ?? 'Open-ended'}
                    </Label>
                  </View>
                  {windowRelative ? (
                    <Label variant="footnote" color={t.color.textTertiary}>
                      {windowRelative}
                    </Label>
                  ) : null}
                </Animated.View>
              ) : null}

              {alternatives.length > 0 ? (
                <Animated.View entering={enter(5)} style={styles.alternatives}>
                  <Label variant="overline" color={t.color.textTertiary} style={styles.altHeading}>
                    {petName ? `What you can still do for ${petName}` : 'What you can still do'}
                  </Label>
                  {alternatives.map((capability) => (
                    <View key={capability} style={styles.altRow}>
                      <View style={styles.altTick}>
                        <Ionicons
                          name="checkmark"
                          size={t.spacing.md}
                          color={t.color.onPrimarySoft}
                        />
                      </View>
                      <Label variant="callout" color={t.color.text} numberOfLines={1}>
                        {CAPABILITY_LABELS[capability]}
                      </Label>
                    </View>
                  ))}
                </Animated.View>
              ) : (
                <Animated.View entering={enter(5)} style={styles.emptyNote}>
                  <Ionicons name="paw-outline" size={t.spacing.base} color={t.color.textTertiary} />
                  <Label variant="footnote" color={t.color.textTertiary} style={styles.emptyNoteText}>
                    {petName
                      ? `Once you're invited, ${petName}'s schedule shows up right here.`
                      : "Once you're invited, the schedule shows up right here."}
                  </Label>
                </Animated.View>
              )}
            </ScrollView>

            <View style={styles.actions}>
              {action.ask ? (
                <>
                  <ActionButton
                    label={action.label(ownerName)}
                    onPress={onAsk}
                    variant="primary"
                    icon="paper-plane-outline"
                  />
                  <ActionButton label="Not now" onPress={dismiss} variant="quiet" />
                </>
              ) : (
                <ActionButton label={action.label(ownerName)} onPress={dismiss} variant="primary" />
              )}
            </View>
          </Animated.View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

export default DenialSheetHost;

/* ----------------------------------------------------------------- styles */

const useStyles = makeStyles((t) =>
  StyleSheet.create({
    root: {
      flex: 1,
      justifyContent: 'flex-end',
    },
    backdrop: {
      backgroundColor: t.color.scrim,
    },
    sheet: {
      backgroundColor: t.color.surfaceRaised,
      borderTopLeftRadius: t.radius.xxxl,
      borderTopRightRadius: t.radius.xxxl,
      paddingHorizontal: t.spacing.xl,
      ...t.elevation(5),
    },
    grabArea: {
      alignItems: 'center',
      paddingTop: t.spacing.md,
      paddingBottom: t.spacing.sm,
      // A generous grab strip: the handle is 4pt tall but the target is 44.
      marginHorizontal: -t.spacing.xl,
      paddingHorizontal: t.spacing.xl,
    },
    grabber: {
      width: t.spacing.xxxl,
      height: t.spacing.xxs,
      borderRadius: t.radius.pill,
      backgroundColor: t.color.borderStrong,
    },
    scrollContent: {
      paddingTop: t.spacing.sm,
      paddingBottom: t.spacing.lg,
    },
    iconRing: {
      width: t.spacing.huge,
      height: t.spacing.huge,
      borderRadius: t.radius.lg,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: t.spacing.base,
    },
    title: {
      marginBottom: t.spacing.xs,
    },
    body: {
      marginBottom: t.spacing.base,
    },
    capabilityChip: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: t.spacing.xs,
      paddingVertical: t.spacing.xs,
      paddingHorizontal: t.spacing.md,
      borderRadius: t.radius.pill,
      backgroundColor: t.color.surfaceAlt,
      borderWidth: t.borderWidth.hairline,
      borderColor: t.color.border,
      marginBottom: t.spacing.base,
    },
    windowCard: {
      borderRadius: t.radius.lg,
      backgroundColor: t.color.surfaceAlt,
      borderWidth: t.borderWidth.hairline,
      borderColor: t.color.border,
      padding: t.spacing.base,
      gap: t.spacing.xs,
      marginBottom: t.spacing.base,
    },
    windowHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.xs,
    },
    windowDates: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: t.spacing.sm,
    },
    alternatives: {
      borderRadius: t.radius.lg,
      backgroundColor: t.color.primarySoft,
      borderWidth: t.borderWidth.hairline,
      borderColor: t.color.primarySoftBorder,
      padding: t.spacing.base,
      gap: t.spacing.sm,
    },
    altHeading: {
      marginBottom: t.spacing.hair,
    },
    altRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
    },
    altTick: {
      width: t.spacing.lg,
      height: t.spacing.lg,
      borderRadius: t.radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.color.primarySoftBorder,
    },
    emptyNote: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: t.spacing.sm,
      padding: t.spacing.base,
      borderRadius: t.radius.lg,
      backgroundColor: t.color.surfaceAlt,
    },
    emptyNoteText: {
      flex: 1,
    },
    actions: {
      gap: t.spacing.sm,
      paddingTop: t.spacing.md,
    },
    buttonHit: {
      minHeight: t.minTarget,
      justifyContent: 'center',
    },
    buttonPrimary: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: t.spacing.sm,
      minHeight: t.minTarget + t.spacing.sm,
      paddingHorizontal: t.spacing.lg,
      borderRadius: t.radius.lg,
      backgroundColor: t.color.primary,
    },
    buttonQuiet: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: t.spacing.sm,
      minHeight: t.minTarget,
      paddingHorizontal: t.spacing.lg,
      borderRadius: t.radius.lg,
      backgroundColor: 'transparent',
    },
  }),
);
