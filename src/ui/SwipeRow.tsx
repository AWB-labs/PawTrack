/**
 * Petal — SwipeRow.
 *
 * Swipe to log a meal, swipe the other way to skip it. This is the fastest path
 * through the app's most repeated action, so it is built rather than borrowed:
 *
 *   · **Progressive reveal.** Each action's icon and label scale and fade in
 *     proportion to how much of *its own* slot has been uncovered, so a
 *     two-action group tells you which one you're about to reach.
 *   · **Full swipe commits.** Past ~62% of the row the primary action arms
 *     itself with a `threshold()` tick, its panel takes over the whole row, and
 *     releasing runs it. Under the threshold it springs back — a committed
 *     gesture and an abandoned one feel completely different under the thumb.
 *   · **Rubber band past the stop.** Dragging beyond the panel width resists
 *     rather than stopping dead, which is what makes the row feel like an object.
 *   · **VoiceOver gets the same actions.** A swipe is invisible to a screen
 *     reader, so every action is also published as an `accessibilityAction`.
 *     Without that this component would be a hidden feature.
 */

import React, { useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
  type WithSpringConfig,
} from 'react-native-reanimated';
import { runOnJS } from 'react-native-worklets';

import haptics from '@/lib/haptics';
import { spring, useTheme, type Theme } from '@/theme';
import { Icon, type IconName } from './Icon';
import type { RadiusToken } from './Stack';
import { Text } from './Text';
import { Touchable } from './Touchable';

/* -------------------------------------------------------------------- types */

export type SwipeActionTone = 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'neutral';

export type SwipeAction = {
  key: string;
  label: string;
  icon: IconName;
  tone?: SwipeActionTone;
  onPress: () => void;
  /**
   * Only honoured on the action nearest the edge. A full swipe past the
   * threshold runs it without needing a second tap.
   */
  fullSwipe?: boolean;
  /** Looks off and explains itself instead of firing. */
  disabledReason?: string;
};

export type SwipeSide = 'left' | 'right';

export type SwipeRowHandle = {
  close: () => void;
  open: (side: SwipeSide) => void;
};

export type SwipeRowProps = {
  children: React.ReactNode;
  /** Revealed by dragging right. The first entry is the full-swipe candidate. */
  left?: SwipeAction[];
  /** Revealed by dragging left. */
  right?: SwipeAction[];
  /** Width of one action panel. */
  actionWidth?: number;
  /** Fraction of the row that arms the full swipe. */
  fullSwipeThreshold?: number;
  enabled?: boolean;
  onOpen?: (side: SwipeSide) => void;
  onClose?: () => void;
  radius?: RadiusToken | number;
  /** The row's own ground — the panels sit behind it, so it can't be transparent. */
  background?: string;
  ref?: React.Ref<SwipeRowHandle>;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/** See Touchable: the theme's `springWith` helper doesn't type-check yet. */
const SETTLE: WithSpringConfig = { ...spring.snappy, reduceMotion: ReduceMotion.System };
/** Resistance past the panel edge. 0.25 ≈ four points of pull per point of travel. */
const RUBBER = 0.25;
const DEFAULT_THRESHOLD = 0.62;
/** Velocity that opens a panel even from a short drag. */
const FLICK_VELOCITY = 550;

/* ------------------------------------------------------------------ helpers */

function toneSkin(t: Theme, tone: SwipeActionTone) {
  switch (tone) {
    case 'accent':
      return { fill: t.color.accent, ink: t.color.onAccent };
    case 'success':
      return { fill: t.color.success, ink: t.color.onSuccess };
    case 'warning':
      return { fill: t.color.warning, ink: t.color.onWarning };
    case 'danger':
      return { fill: t.color.danger, ink: t.color.onDanger };
    case 'neutral':
      return { fill: t.color.surfaceAlt, ink: t.color.text };
    case 'primary':
    default:
      return { fill: t.color.primary, ink: t.color.onPrimary };
  }
}

/* ---------------------------------------------------------------- component */

export function SwipeRow({
  children,
  left = [],
  right = [],
  actionWidth,
  fullSwipeThreshold = DEFAULT_THRESHOLD,
  enabled = true,
  onOpen,
  onClose,
  radius = 'lg',
  background,
  ref,
  style,
  testID,
}: SwipeRowProps) {
  const t = useTheme();
  const panelWidth = actionWidth ?? t.spacing.colossal;
  const ground = background ?? t.color.surface;
  const br = typeof radius === 'number' ? radius : t.radius[radius];

  const leftWidth = left.length * panelWidth;
  const rightWidth = right.length * panelWidth;

  const translate = useSharedValue(0);
  const start = useSharedValue(0);
  const armed = useSharedValue(0);
  const rowWidth = useSharedValue(0);
  const [width, setWidth] = useState(0);

  const primaryLeft = left[0]?.fullSwipe === true ? left[0] : null;
  const primaryRight = right[0]?.fullSwipe === true ? right[0] : null;

  /* ---- callbacks ------------------------------------------------------- */

  // Refs, so the gesture's `useMemo` doesn't rebuild on every parent render —
  // rebuilding a live Pan mid-drag drops the touch.
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const primaryRef = useRef<Record<SwipeSide, SwipeAction | null>>({ left: null, right: null });
  primaryRef.current = { left: primaryLeft, right: primaryRight };

  const notifyOpen = useCallback((side: SwipeSide) => openRef.current?.(side), []);
  const notifyClose = useCallback(() => closeRef.current?.(), []);

  const run = useCallback((action: SwipeAction) => {
    if (action.disabledReason !== undefined) haptics.warn();
    else if (action.tone === 'danger') haptics.heavy();
    else haptics.success();
    action.onPress();
  }, []);

  const returnTiming = useMemo(
    () => t.motion.timing(t.motion.duration.base, 'decelerate'),
    [t.motion],
  );

  const close = useCallback(() => {
    translate.value = withSpring(0, SETTLE);
    armed.value = 0;
  }, [armed, translate]);

  const open = useCallback(
    (side: SwipeSide) => {
      translate.value = withSpring(side === 'left' ? leftWidth : -rightWidth, SETTLE);
      notifyOpen(side);
    },
    [leftWidth, notifyOpen, rightWidth, translate],
  );

  useImperativeHandle(ref, () => ({ close, open }), [close, open]);

  /**
   * Only the *side* crosses the worklet boundary. A `SwipeAction` carries an
   * `onPress` closure, and functions don't survive `runOnJS` serialisation.
   */
  const commit = useCallback(
    (side: SwipeSide) => {
      const action = primaryRef.current[side];
      if (action) run(action);
      translate.value = withTiming(0, returnTiming);
      armed.value = 0;
    },
    [armed, returnTiming, run, translate],
  );

  const handleAction = useCallback(
    (action: SwipeAction) => {
      run(action);
      close();
    },
    [close, run],
  );

  /* ---- gesture --------------------------------------------------------- */

  const enterTiming = useMemo(() => t.motion.timing(t.motion.duration.slow, 'decelerate'), [t.motion]);

  // Booleans, not the action objects: a parent passing inline `left={[…]}`
  // arrays would otherwise rebuild the Pan on every render, and rebuilding a
  // live gesture mid-drag drops the touch.
  const hasPrimaryLeft = primaryLeft !== null;
  const hasPrimaryRight = primaryRight !== null;
  const canSwipe = enabled && (left.length > 0 || right.length > 0);

  const gesture = useMemo(() => {
    return Gesture.Pan()
      .enabled(canSwipe)
      // Horizontal intent only — a vertical drag belongs to the list.
      .activeOffsetX([-12, 12])
      .failOffsetY([-16, 16])
      .onStart(() => {
        start.value = translate.value;
      })
      .onUpdate((event) => {
        const raw = start.value + event.translationX;
        const max = leftWidth;
        const min = -rightWidth;
        // Past the stop the row still moves, just grudgingly.
        const next =
          raw > max ? max + (raw - max) * RUBBER : raw < min ? min + (raw - min) * RUBBER : raw;
        translate.value = next;

        const trigger = rowWidth.value * fullSwipeThreshold;
        const armable = (next > trigger && hasPrimaryLeft) || (next < -trigger && hasPrimaryRight);
        if (armable !== (armed.value === 1)) {
          armed.value = armable ? 1 : 0;
          runOnJS(haptics.threshold)();
        }
      })
      .onEnd((event) => {
        const value = translate.value;
        const velocity = event.velocityX;
        const trigger = rowWidth.value * fullSwipeThreshold;

        if (hasPrimaryLeft && value > trigger) {
          translate.value = withTiming(rowWidth.value, enterTiming, () => {
            'worklet';
            runOnJS(commit)('left');
          });
          return;
        }
        if (hasPrimaryRight && value < -trigger) {
          translate.value = withTiming(-rowWidth.value, enterTiming, () => {
            'worklet';
            runOnJS(commit)('right');
          });
          return;
        }

        armed.value = 0;

        const openLeft = leftWidth > 0 && (value > leftWidth / 2 || velocity > FLICK_VELOCITY);
        const openRight = rightWidth > 0 && (value < -rightWidth / 2 || velocity < -FLICK_VELOCITY);

        if (openLeft) {
          translate.value = withSpring(leftWidth, SETTLE);
          runOnJS(notifyOpen)('left');
        } else if (openRight) {
          translate.value = withSpring(-rightWidth, SETTLE);
          runOnJS(notifyOpen)('right');
        } else {
          translate.value = withSpring(0, SETTLE);
          if (Math.abs(value) > 1) runOnJS(notifyClose)();
        }
      });
  }, [
    armed,
    canSwipe,
    commit,
    enterTiming,
    fullSwipeThreshold,
    hasPrimaryLeft,
    hasPrimaryRight,
    leftWidth,
    notifyClose,
    notifyOpen,
    rightWidth,
    rowWidth,
    start,
    translate,
  ]);

  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translate.value }] }));

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const next = event.nativeEvent.layout.width;
      rowWidth.value = next;
      setWidth((prev) => (Math.abs(prev - next) < 1 ? prev : next));
    },
    [rowWidth],
  );

  /* ---- accessibility --------------------------------------------------- */

  const allActions = useMemo(() => [...left, ...right], [left, right]);
  const a11yActions = useMemo(
    () => allActions.map((action) => ({ name: action.key, label: action.label })),
    [allActions],
  );

  const handleA11yAction = useCallback(
    (event: AccessibilityActionEvent) => {
      const action = allActions.find((candidate) => candidate.key === event.nativeEvent.actionName);
      if (action) handleAction(action);
    },
    [allActions, handleAction],
  );

  /* ---- render ---------------------------------------------------------- */

  return (
    <View
      onLayout={handleLayout}
      style={[{ borderRadius: br, overflow: 'hidden' }, style]}
      accessibilityActions={a11yActions.length > 0 ? a11yActions : undefined}
      onAccessibilityAction={a11yActions.length > 0 ? handleA11yAction : undefined}
      testID={testID}
    >
      {left.length > 0 ? (
        <ActionPanel
          side="left"
          actions={left}
          panelWidth={panelWidth}
          translate={translate}
          armed={armed}
          rowWidth={width}
          onPress={handleAction}
        />
      ) : null}
      {right.length > 0 ? (
        <ActionPanel
          side="right"
          actions={right}
          panelWidth={panelWidth}
          translate={translate}
          armed={armed}
          rowWidth={width}
          onPress={handleAction}
        />
      ) : null}

      <GestureDetector gesture={gesture}>
        <Animated.View style={[{ backgroundColor: ground, borderRadius: br }, rowStyle]}>
          {children}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

/* ------------------------------------------------------------------ panels */

type ActionPanelProps = {
  side: SwipeSide;
  actions: SwipeAction[];
  panelWidth: number;
  translate: SharedValue<number>;
  armed: SharedValue<number>;
  rowWidth: number;
  onPress: (action: SwipeAction) => void;
};

function ActionPanel({ side, actions, panelWidth, translate, armed, rowWidth, onPress }: ActionPanelProps) {
  const t = useTheme();

  return (
    <View style={[StyleSheet.absoluteFill, side === 'left' ? styles.left : styles.right]}>
      {actions.map((action, index) => (
        <ActionCell
          key={action.key}
          action={action}
          side={side}
          index={index}
          panelWidth={panelWidth}
          translate={translate}
          armed={armed}
          rowWidth={rowWidth}
          gap={t.spacing.xxs}
          onPress={onPress}
        />
      ))}
    </View>
  );
}

type ActionCellProps = {
  action: SwipeAction;
  side: SwipeSide;
  index: number;
  panelWidth: number;
  translate: SharedValue<number>;
  armed: SharedValue<number>;
  rowWidth: number;
  gap: number;
  onPress: (action: SwipeAction) => void;
};

function ActionCell({
  action,
  side,
  index,
  panelWidth,
  translate,
  armed,
  rowWidth,
  gap,
  onPress,
}: ActionCellProps) {
  const t = useTheme();
  const skin = toneSkin(t, action.tone ?? 'primary');
  const isPrimary = index === 0 && action.fullSwipe === true;
  /** How far the row must travel before this cell is fully uncovered. */
  const revealAt = (index + 1) * panelWidth;

  const cellStyle = useAnimatedStyle(() => {
    const travel = side === 'left' ? translate.value : -translate.value;
    // Each cell owns the slice of travel that uncovers it.
    const progress = interpolate(travel, [revealAt - panelWidth, revealAt], [0, 1], Extrapolation.CLAMP);
    // The armed primary swallows the whole row.
    const grown = isPrimary && armed.value === 1 ? Math.max(rowWidth, travel) : 0;
    return { width: Math.max(panelWidth, grown), opacity: progress };
  });

  const contentStyle = useAnimatedStyle(() => {
    const travel = side === 'left' ? translate.value : -translate.value;
    const progress = interpolate(travel, [revealAt - panelWidth, revealAt], [0, 1], Extrapolation.CLAMP);
    return {
      transform: [{ scale: 0.68 + progress * 0.32 }],
      opacity: interpolate(progress, [0.25, 1], [0, 1], Extrapolation.CLAMP),
    };
  });

  return (
    <Animated.View style={[{ backgroundColor: skin.fill }, cellStyle]}>
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={action.label}
        disabledReason={action.disabledReason}
        haptic="none"
        onPress={() => onPress(action)}
        pressScale="small"
        style={styles.cell}
      >
        <Animated.View style={[styles.cellContent, { gap }, contentStyle]}>
          <Icon name={action.icon} size="md" color={skin.ink} />
          <Text variant="caption" color={skin.ink} align="center" numberOfLines={1}>
            {action.label}
          </Text>
        </Animated.View>
      </Touchable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  left: { flexDirection: 'row', justifyContent: 'flex-start' },
  right: { flexDirection: 'row-reverse', justifyContent: 'flex-start' },
  cell: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  cellContent: { alignItems: 'center', justifyContent: 'center' },
});

export default SwipeRow;
