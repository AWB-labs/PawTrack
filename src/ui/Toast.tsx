/**
 * Petal — Toast.
 *
 * Transient feedback that never blocks the thing you were doing. Four tones,
 * one imperative API, and a host that lives at the app root:
 *
 *   toast.success('Buddy’s dinner is logged 🐾');
 *   toast.undo('Dose marked as given', () => undoDose(logId));
 *   toast.error(toToastMessage(error), { action: { label: 'Retry', onPress } });
 *
 * The store is module-level on purpose. Toasts are raised from mutation
 * callbacks, deep-link handlers and the query layer — places that have no React
 * context to reach into — so `toast.*` works from anywhere, including before the
 * host has mounted (those toasts are held, not lost).
 *
 * Behaviour worth knowing:
 *   · **Three at a time.** Anything beyond that queues and promotes as room
 *     appears. A screen that fires six toasts is a bug, not a reason to stack six.
 *   · **Duplicates refresh rather than stack.** Double-tapping "log meal"
 *     restarts one toast's timer instead of building a wall.
 *   · **The hairline is the clock**, and it doubles as the undo window — you can
 *     see how long you have to change your mind.
 *   · **Swipe up to dismiss**, and dragging pauses the timer, because someone
 *     touching a toast is someone still reading it.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { AccessibilityInfo, Platform, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  LinearTransition,
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
import { duration as durationScale, spring, useTheme, type Theme } from '@/theme';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';
import { Touchable } from './Touchable';

/* -------------------------------------------------------------------- types */

export type ToastTone = 'success' | 'error' | 'info' | 'warning';

export type ToastAction = {
  label: string;
  onPress: () => void;
  /** Keep the toast open after the action fires — for "Retry" on a live request. */
  keepOpen?: boolean;
};

export type ToastOptions = {
  /** Reuse an id to replace an existing toast instead of adding one. */
  id?: string;
  /** Second line: the detail, the pet's name, the quantity. */
  description?: string;
  /** Milliseconds on screen. `0` pins it until dismissed. */
  duration?: number;
  icon?: IconName;
  action?: ToastAction;
  /** Adds an Undo affordance and stretches the window to think about it. */
  undo?: () => void | Promise<void>;
  undoLabel?: string;
  /** Suppress the tone's haptic — for toasts fired in a burst. */
  haptic?: boolean;
  onDismiss?: () => void;
};

export type ToastInput = ToastOptions & { tone: ToastTone; message: string };

export type ToastApi = {
  show: (input: ToastInput) => string;
  success: (message: string, options?: ToastOptions) => string;
  error: (message: string, options?: ToastOptions) => string;
  info: (message: string, options?: ToastOptions) => string;
  warning: (message: string, options?: ToastOptions) => string;
  /** Optimistic-mutation helper: success tone, Undo affordance, longer window. */
  undo: (message: string, onUndo: () => void | Promise<void>, options?: ToastOptions) => string;
  dismiss: (id: string) => void;
  dismissAll: () => void;
};

export type ToastHostProps = {
  /** Extra clearance below the safe area — e.g. under a floating header. */
  topOffset?: number;
};

type ToastRecord = {
  id: string;
  tone: ToastTone;
  message: string;
  description: string | null;
  icon: IconName | null;
  duration: number;
  action: ToastAction | null;
  undo: (() => void | Promise<void>) | null;
  undoLabel: string;
  haptic: boolean;
  onDismiss: (() => void) | null;
  /** Set by `dismiss()`; the item plays its exit, then unmounts itself. */
  closing: boolean;
  /** Bumped when a duplicate arrives, which restarts the timer. */
  nonce: number;
};

/* ---------------------------------------------------------------- constants */

const MAX_VISIBLE = 3;

/**
 * Lifetimes, derived from the ambient loop so a retune of the motion scale
 * carries here too. Errors linger longest — they're the ones you re-read.
 */
const LIFETIME: Record<ToastTone, number> = {
  success: durationScale.ambient * 0.8,
  info: durationScale.ambient * 0.8,
  warning: durationScale.ambient,
  error: durationScale.ambient * 1.25,
};

/** An undo window has to survive "wait, what did I just do?". */
const UNDO_LIFETIME = durationScale.ambient * 1.5;

/** See Touchable: the theme's `springWith` helper doesn't type-check yet. */
const ENTER: WithSpringConfig = { ...spring.snappy, reduceMotion: ReduceMotion.System };
const SETTLE: WithSpringConfig = { ...spring.gentle, reduceMotion: ReduceMotion.System };

/** Flick speed, in points per second, that counts as "get rid of it". */
const FLICK_VELOCITY = 600;

/** Downward drag resistance — a toast can be nudged, not dragged onto the page. */
const DOWN_RESIST = 0.22;

/** Enter scale, and the per-depth falloff that makes the stack read as a stack. */
const ENTER_SCALE = 0.94;
const DEPTH_STEP = 0.02;

/** Used until a toast reports its real height on first layout. */
const FALLBACK_TRAVEL = 96;

const TONE_ICON: Record<ToastTone, IconName> = {
  success: 'checkmark-circle',
  error: 'alert-circle',
  warning: 'warning',
  info: 'information-circle',
};

const TONE_HAPTIC: Record<ToastTone, () => void> = {
  success: haptics.success,
  error: haptics.error,
  warning: haptics.warn,
  info: haptics.tap,
};

/* -------------------------------------------------------------------- store */

let visible: ToastRecord[] = [];
let queued: ToastRecord[] = [];
let snapshot: readonly ToastRecord[] = visible;
let sequence = 0;

const listeners = new Set<() => void>();

function emit(): void {
  snapshot = visible.slice();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): readonly ToastRecord[] {
  return snapshot;
}

function push(record: ToastRecord): string {
  // Same words, same tone, still on screen → restart it rather than stack it.
  const twin = visible.find((r) => !r.closing && r.tone === record.tone && r.message === record.message);
  if (twin) {
    visible = visible.map((r) =>
      r.id === twin.id ? { ...record, id: twin.id, nonce: twin.nonce + 1 } : r,
    );
    emit();
    return twin.id;
  }

  const existing = visible.find((r) => r.id === record.id);
  if (existing) {
    visible = visible.map((r) => (r.id === record.id ? { ...record, nonce: existing.nonce + 1 } : r));
    emit();
    return record.id;
  }

  if (visible.length >= MAX_VISIBLE) {
    queued = [...queued, record];
  } else {
    // Newest on top: the thing that just happened is the thing you look at.
    visible = [record, ...visible];
  }
  emit();
  return record.id;
}

function close(id: string): void {
  const target = visible.find((r) => r.id === id);
  if (!target || target.closing) {
    queued = queued.filter((r) => r.id !== id);
    return;
  }
  visible = visible.map((r) => (r.id === id ? { ...r, closing: true } : r));
  emit();
}

function remove(id: string): void {
  const target = visible.find((r) => r.id === id);
  visible = visible.filter((r) => r.id !== id);
  if (queued.length > 0 && visible.length < MAX_VISIBLE) {
    const [next, ...rest] = queued;
    queued = rest;
    if (next) visible = [next, ...visible];
  }
  emit();
  target?.onDismiss?.();
}

function dismissAll(): void {
  queued = [];
  visible = visible.map((r) => ({ ...r, closing: true }));
  emit();
}

function build(input: ToastInput): ToastRecord {
  const hasUndo = typeof input.undo === 'function';
  return {
    id: input.id ?? `toast-${++sequence}`,
    tone: input.tone,
    message: input.message,
    description: input.description ?? null,
    icon: input.icon ?? null,
    duration: input.duration ?? (hasUndo ? UNDO_LIFETIME : LIFETIME[input.tone]),
    action: input.action ?? null,
    undo: input.undo ?? null,
    undoLabel: input.undoLabel ?? 'Undo',
    haptic: input.haptic ?? true,
    onDismiss: input.onDismiss ?? null,
    closing: false,
    nonce: 0,
  };
}

/* ---------------------------------------------------------------------- api */

export const toast: ToastApi = {
  show: (input) => push(build(input)),
  success: (message, options) => push(build({ ...options, tone: 'success', message })),
  error: (message, options) => push(build({ ...options, tone: 'error', message })),
  info: (message, options) => push(build({ ...options, tone: 'info', message })),
  warning: (message, options) => push(build({ ...options, tone: 'warning', message })),
  undo: (message, onUndo, options) =>
    push(build({ ...options, tone: 'success', message, undo: onUndo })),
  dismiss: close,
  dismissAll,
};

/** Hook form, for call sites that prefer it. Returns the same singleton. */
export function useToast(): ToastApi {
  return toast;
}

/* ------------------------------------------------------------------ helpers */

type ToastSkin = { wash: string; ink: string; fill: string; onFill: string; bar: string };

function toneSkin(t: Theme, tone: ToastTone): ToastSkin {
  switch (tone) {
    case 'success':
      return {
        wash: t.color.successSoft,
        ink: t.color.onSuccessSoft,
        fill: t.color.success,
        onFill: t.color.onSuccess,
        bar: t.color.success,
      };
    case 'error':
      return {
        wash: t.color.dangerSoft,
        ink: t.color.onDangerSoft,
        fill: t.color.danger,
        onFill: t.color.onDanger,
        bar: t.color.danger,
      };
    case 'warning':
      return {
        wash: t.color.warningSoft,
        ink: t.color.onWarningSoft,
        fill: t.color.warning,
        onFill: t.color.onWarning,
        bar: t.color.warning,
      };
    case 'info':
    default:
      return {
        wash: t.color.infoSoft,
        ink: t.color.onInfoSoft,
        fill: t.color.info,
        onFill: t.color.onInfo,
        bar: t.color.info,
      };
  }
}

/* --------------------------------------------------------------------- host */

/**
 * Mount once, above the navigator, inside `<ThemeProvider>`. Everything else
 * talks to it through `toast.*`.
 */
export function ToastHost({ topOffset = 0 }: ToastHostProps = {}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const items = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (items.length === 0) return null;

  return (
    <View
      pointerEvents="box-none"
      style={[
        StyleSheet.absoluteFill,
        {
          zIndex: t.zIndex.toast,
          paddingTop: insets.top + t.spacing.sm + topOffset,
          paddingHorizontal: t.gutter,
        },
      ]}
    >
      <View pointerEvents="box-none" style={{ gap: t.spacing.sm }}>
        {items.map((record, index) => (
          <ToastItem key={record.id} record={record} depth={index} />
        ))}
      </View>
    </View>
  );
}

/**
 * Convenience wrapper for trees that don't use `AppProviders` — a storybook, a
 * test harness. The app itself mounts `<ToastHost/>` directly.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <ToastHost />
    </>
  );
}

/* --------------------------------------------------------------------- item */

function ToastItem({ record, depth }: { record: ToastRecord; depth: number }) {
  const t = useTheme();
  const skin = toneSkin(t, record.tone);
  const reduceMotion = t.reduceMotion;

  const enter = useSharedValue(0);
  const drag = useSharedValue(0);
  const life = useSharedValue(0);
  const travel = useSharedValue(FALLBACK_TRAVEL);
  const trackWidth = useSharedValue(0);
  const closing = record.closing;
  const lifetime = record.duration;

  const requestClose = useCallback(() => close(record.id), [record.id]);

  const startLife = useCallback(
    (from: number) => {
      if (lifetime <= 0) return;
      life.value = from;
      life.value = withTiming(
        1,
        {
          duration: lifetime * (1 - from),
          easing: t.motion.easing.linear,
          // The hairline is information, not decoration — it must run even
          // when the system asks for reduced motion.
          reduceMotion: ReduceMotion.Never,
        },
        (finished) => {
          'worklet';
          if (finished) runOnJS(requestClose)();
        },
      );
    },
    [life, lifetime, requestClose, t.motion],
  );

  // Arrival: spring in, speak, buzz. `nonce` re-runs it when a duplicate lands.
  const announced = useRef(false);
  useEffect(() => {
    enter.value = withSpring(1, ENTER);
    startLife(0);
    if (record.haptic) TONE_HAPTIC[record.tone]();
    // Android reads the live region; iOS needs to be told once, explicitly.
    if (Platform.OS === 'ios' && !announced.current) {
      announced.current = true;
      AccessibilityInfo.announceForAccessibility(
        record.description ? `${record.message}. ${record.description}` : record.message,
      );
    }
  }, [enter, record.haptic, record.tone, record.message, record.description, record.nonce, startLife]);

  useEffect(() => {
    if (!closing) return;
    cancelAnimation(life);
    enter.value = withTiming(
      0,
      t.motion.timing(t.motion.duration.fast, 'accelerate'),
      (finished) => {
        'worklet';
        if (finished) runOnJS(remove)(record.id);
      },
    );
  }, [closing, enter, life, record.id, t.motion]);

  const resume = useCallback(() => startLife(life.value), [life, startLife]);

  const swipeDistance = t.spacing.xxl;
  const grab = t.spacing.sm;

  const pan = useMemo(
    () =>
      Gesture.Pan()
        // Let taps through to the buttons underneath.
        .activeOffsetY([-grab, grab])
        .onBegin(() => {
          cancelAnimation(life);
        })
        .onUpdate((event) => {
          drag.value =
            event.translationY < 0 ? event.translationY : event.translationY * DOWN_RESIST;
        })
        .onEnd((event) => {
          if (drag.value < -swipeDistance || event.velocityY < -FLICK_VELOCITY) {
            runOnJS(requestClose)();
          } else {
            drag.value = withSpring(0, SETTLE);
            runOnJS(resume)();
          }
        }),
    [drag, grab, life, requestClose, resume, swipeDistance],
  );

  const cardStyle = useAnimatedStyle(() => {
    const p = enter.value;
    if (reduceMotion) {
      return { opacity: p, transform: [{ translateY: drag.value }, { scale: 1 }] };
    }
    const lifted = Math.min(0, drag.value) / travel.value;
    return {
      opacity: p * Math.max(0, 1 + lifted),
      transform: [
        { translateY: (1 - p) * -travel.value + drag.value },
        { scale: (ENTER_SCALE + p * (1 - ENTER_SCALE)) * (1 - depth * DEPTH_STEP) },
      ],
    };
  }, [reduceMotion, depth]);

  const barStyle = useAnimatedStyle(() => ({ width: trackWidth.value * (1 - life.value) }));

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { height, width } = event.nativeEvent.layout;
      travel.value = height + t.spacing.lg;
      trackWidth.value = width;
    },
    [t.spacing.lg, trackWidth, travel],
  );

  const onAction = useCallback(() => {
    record.action?.onPress();
    if (!record.action?.keepOpen) requestClose();
  }, [record.action, requestClose]);

  const onUndo = useCallback(() => {
    haptics.commit();
    void record.undo?.();
    requestClose();
  }, [record.undo, requestClose]);

  const chip = t.spacing.xxl;

  return (
    <Animated.View
      layout={LinearTransition.duration(t.motion.duration.base).reduceMotion(ReduceMotion.System)}
      style={cardStyle}
      accessibilityLiveRegion="polite"
      accessibilityRole={record.tone === 'error' ? 'alert' : 'text'}
      pointerEvents="box-none"
    >
      <GestureDetector gesture={pan}>
        <View
          onLayout={onLayout}
          style={[
            t.elevation(3),
            {
              borderRadius: t.radius.lg,
              backgroundColor: t.color.surfaceRaised,
              borderWidth: t.borderWidth.hairline,
              borderColor: t.color.border,
              overflow: 'hidden',
            },
          ]}
        >
          {/* The tone wash sits over an opaque surface so the soft tokens keep
              their verified contrast even where the page behind is busy. */}
          <View style={[StyleSheet.absoluteFill, { backgroundColor: skin.wash }]} pointerEvents="none" />

          <View style={[styles.row, { gap: t.spacing.md, padding: t.spacing.md }]}>
            <View
              style={[
                styles.center,
                { width: chip, height: chip, borderRadius: chip / 2, backgroundColor: skin.fill },
              ]}
            >
              <Icon name={record.icon ?? TONE_ICON[record.tone]} size="md" color={skin.onFill} />
            </View>

            <Touchable
              accessibilityRole="button"
              accessibilityLabel={record.message}
              accessibilityHint="Dismisses this message."
              haptic="none"
              onPress={requestClose}
              pressScale="subtle"
              style={styles.grow}
            >
              <Text variant="subheadStrong" color={skin.ink} numberOfLines={2}>
                {record.message}
              </Text>
              {record.description ? (
                <Text
                  variant="footnote"
                  color={skin.ink}
                  numberOfLines={2}
                  style={{ opacity: t.opacity.muted, marginTop: t.spacing.hair }}
                >
                  {record.description}
                </Text>
              ) : null}
            </Touchable>

            {record.undo ? (
              <ToastButton label={record.undoLabel} icon="arrow-undo" skin={skin} onPress={onUndo} />
            ) : record.action ? (
              <ToastButton label={record.action.label} skin={skin} onPress={onAction} />
            ) : null}
          </View>

          {lifetime > 0 ? (
            <View style={[styles.track, { height: t.borderWidth.thick, backgroundColor: t.color.divider }]}>
              <Animated.View style={[styles.fill, { backgroundColor: skin.bar }, barStyle]} />
            </View>
          ) : null}
        </View>
      </GestureDetector>
    </Animated.View>
  );
}

function ToastButton({
  label,
  icon,
  skin,
  onPress,
}: {
  label: string;
  icon?: IconName;
  skin: ToastSkin;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      haptic="tap"
      onPress={onPress}
      pressScale="small"
      style={[
        styles.row,
        styles.center,
        {
          gap: t.spacing.xxs,
          paddingVertical: t.spacing.xs,
          paddingHorizontal: t.spacing.md,
          borderRadius: t.radius.pill,
          backgroundColor: skin.fill,
        },
      ]}
    >
      {icon ? <Icon name={icon} size="xs" color={skin.onFill} /> : null}
      <Text variant="buttonSmall" color={skin.onFill} numberOfLines={1}>
        {label}
      </Text>
    </Touchable>
  );
}

/* ----------------------------------------------------------------- styles */

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  grow: { flex: 1 },
  track: { width: '100%' },
  fill: { height: '100%' },
});

export default ToastHost;
