/**
 * Petal — FormField, and the shared chrome every field in the app is cut from.
 *
 * Forms are where apps look scaffolded, and the reason is almost always that
 * each control invents its own geometry. So the *frame* lives here once —
 * padding, radius, the floating-label maths, the focus ring, the cross-fading
 * message row — and `Input`, `TextArea`, `Select`, `DateField` and `TimeField`
 * all wear it. A text field and a date field are then indistinguishable until
 * you tap them, which is the whole point.
 *
 * Three details that are easy to get wrong and are solved here:
 *
 *   · **The message row never resizes the form.** Helper and error are stacked
 *     and cross-faded inside a box whose height tweens between the two measured
 *     heights, so an error appearing doesn't shove the next field down a line.
 *   · **The floating label scales, it doesn't re-typeset.** Animating
 *     `fontSize` re-lays-out text every frame; we animate `scale` and correct
 *     the origin from the measured width, which is free on the UI thread.
 *   · **The focus ring lives outside the border.** A ring drawn *on* the border
 *     changes the field's optical width when it appears. Ours is an inset
 *     sibling, so focus adds light, not layout.
 *
 * `FormField` itself is the composition for *non-text* controls — a switch, a
 * chip row, a stepper — so those rows carry the same label/helper/error rhythm
 * as the text fields beside them.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Modal,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  interpolate,
  interpolateColor,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
  type WithSpringConfig,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { runOnJS } from 'react-native-worklets';

import haptics from '@/lib/haptics';
import { spring, useTheme, type Theme } from '@/theme';
import { Icon, ICON_SIZE, type IconName, type IconSize } from './Icon';
import { IconButton } from './IconButton';
import { Row } from './Stack';
import { Text } from './Text';
import { Touchable } from './Touchable';

/* -------------------------------------------------------------------- types */

export type FieldSize = 'md' | 'lg';
export type FieldVariant = 'filled' | 'outlined';

export type FieldMetrics = {
  /** Horizontal padding inside the frame. */
  padX: number;
  /** Vertical padding inside the frame. */
  padY: number;
  radius: number;
  /** Height of one line of input text at the current font scale. */
  textBlock: number;
  /** Room reserved above the input for the floated label (0 when unlabelled). */
  floatBlock: number;
  /** Shrink factor applied to the label as it floats. */
  labelScale: number;
  /** Resting height of a single-line frame. */
  height: number;
  /** Gap between the frame's content and its adornments. */
  gap: number;
  iconSize: IconSize;
};

export type FieldFrameProps = {
  children?: ReactNode;
  label?: string;
  /** Drives the label to its small top position. */
  floated?: boolean;
  focused?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  required?: boolean;
  variant?: FieldVariant;
  size?: FieldSize;
  /** Leading adornment — an icon, a currency symbol, a species emoji. */
  leading?: ReactNode;
  /** Trailing adornment — clear button, reveal toggle, chevron. */
  trailing?: ReactNode;
  /** Let the frame grow with its content instead of pinning a single line. */
  grow?: boolean;
  /** Hide the focus ring when the field is inside an already-focused surface. */
  ring?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export type FieldMessageProps = {
  helper?: string;
  error?: string;
  /**
   * Hold the row open at its tallest measured message. Use on forms that
   * validate on submit, so the whole page doesn't reflow at once.
   */
  reserve?: boolean;
  style?: StyleProp<ViewStyle>;
};

export type FieldCounterProps = {
  length: number;
  max: number;
  /** Dimmed until the field matters — a counter shouting at an empty box is noise. */
  active?: boolean;
};

export type FieldIconProps = {
  name: IconName;
  size?: IconSize;
  /** Lifts the icon to the brand colour. */
  active?: boolean;
  invalid?: boolean;
  disabled?: boolean;
};

export type FormFieldProps = {
  children: ReactNode;
  label?: string;
  required?: boolean;
  helper?: string;
  error?: string;
  /** Right-aligned node beside the label — a "Why?" link, a count, a reset. */
  action?: ReactNode;
  disabled?: boolean;
  reserveMessageSpace?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export type FieldOverlayProps = {
  visible: boolean;
  onRequestClose: () => void;
  title?: string;
  subtitle?: string;
  /** Header-right node — usually a confirm button. */
  action?: ReactNode;
  children: ReactNode;
  /** Sheets only. Turn off when the sheet's whole body is a scroll view. */
  dismissOnDrag?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/** See `Touchable` — the theme's `springWith` helper doesn't type-check yet. */
const LABEL_SPRING: WithSpringConfig = { ...spring.gentle, reduceMotion: ReduceMotion.System };
const SNAPPY: WithSpringConfig = { ...spring.snappy, reduceMotion: ReduceMotion.System };
const SHEET_SPRING: WithSpringConfig = { ...spring.heavy, reduceMotion: ReduceMotion.System };

/** Flick speed (pt/s) past which a sheet dismisses regardless of distance. */
const FLING_VELOCITY = 850;

/** Tallest a sheet may grow before its own content has to scroll. */
const SHEET_MAX_HEIGHT_RATIO = 0.86;

/**
 * Text that has to animate its colour. Reanimated can't tween `color` on a
 * plain RN text node, and our `Text` forwards its ref to one, so this keeps the
 * type ramp and the dynamic-type caps while gaining an animatable colour.
 */
export const AnimatedText = Animated.createAnimatedComponent(Text);

/* ------------------------------------------------------------------ metrics */

/**
 * Every dimension a field needs, derived from tokens and the live font scale —
 * so a field at 200% text is taller rather than clipped, without a single
 * hard-coded height anywhere.
 */
export function useFieldMetrics(size: FieldSize = 'md', hasLabel = false): FieldMetrics {
  const t = useTheme();

  return useMemo<FieldMetrics>(() => {
    const padY = size === 'lg' ? t.spacing.md : t.spacing.sm;
    const padX = size === 'lg' ? t.spacing.lg : t.spacing.base;
    const radius = size === 'lg' ? t.radius.xl : t.radius.lg;

    const cap = t.type.body.maxFontSizeMultiplier;
    const scale = Math.min(t.fontScale, cap);
    const line = (t.type.body.lineHeight ?? t.spacing.xl) * scale;

    // The label shrinks to the caption step; deriving the factor from the ramp
    // means a type retune moves the label with it.
    const labelScale = (t.type.caption.fontSize ?? t.spacing.md) / (t.type.body.fontSize ?? t.spacing.base);

    const textBlock = Math.round(line);
    const floatBlock = hasLabel ? Math.round(line * labelScale) : 0;

    return {
      padX,
      padY,
      radius,
      textBlock,
      floatBlock,
      labelScale,
      height: Math.max(t.minTarget, padY * 2 + floatBlock + textBlock),
      gap: t.spacing.sm,
      iconSize: size === 'lg' ? 'lg' : 'md',
    };
  }, [hasLabel, size, t]);
}

/* -------------------------------------------------------------------- shake */

/**
 * The "you can't submit that" nudge. Deliberately short and asymmetric — a
 * symmetric wobble reads as decoration, a decaying one reads as rejection.
 * Under reduced motion the haptic and the error colour carry it alone.
 */
export function useFieldShake() {
  const t = useTheme();
  const x = useSharedValue(0);

  const far = t.spacing.sm;
  const near = t.spacing.xxs;
  const reduce = t.reduceMotion;
  const motion = t.motion;

  const shake = useCallback(() => {
    haptics.error();
    if (reduce) return;
    x.value = withSequence(
      withTiming(-far, motion.timing(motion.duration.instant, 'accelerate')),
      withTiming(far, motion.timing(motion.duration.instant, 'smooth')),
      withTiming(-near, motion.timing(motion.duration.instant, 'smooth')),
      withTiming(0, motion.timing(motion.duration.fast, 'decelerate')),
    );
  }, [far, motion, near, reduce, x]);

  const shakeStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));

  return { shakeStyle, shake };
}

/* --------------------------------------------------------------- field icon */

/**
 * An adornment icon that lifts to the brand colour on focus. Two stacked
 * glyphs cross-faded, because an icon is a text node and its colour can't be
 * tweened directly — the same trick `Chip` uses for its label.
 */
export function FieldIcon({ name, size = 'md', active = false, invalid = false, disabled = false }: FieldIconProps) {
  const t = useTheme();
  const box = ICON_SIZE[size];

  const on = useSharedValue(active ? 1 : 0);
  useEffect(() => {
    on.value = withTiming(active ? 1 : 0, t.motion.timing(t.motion.duration.fast, 'smooth'));
  }, [active, on, t.motion]);

  const restStyle = useAnimatedStyle(() => ({ opacity: 1 - on.value }));
  const activeStyle = useAnimatedStyle(() => ({ opacity: on.value }));

  const rest = disabled ? t.color.textFaint : invalid ? t.color.onDangerSoft : t.color.textTertiary;
  const lit = invalid ? t.color.onDangerSoft : t.color.primaryText;

  return (
    <View style={{ width: box, height: box }}>
      <Animated.View style={[StyleSheet.absoluteFill, restStyle]}>
        <Icon name={name} size={size} color={rest} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, activeStyle]} importantForAccessibility="no-hide-descendants">
        <Icon name={name} size={size} color={lit} />
      </Animated.View>
    </View>
  );
}

/* -------------------------------------------------------------- field frame */

export function FieldFrame({
  children,
  label,
  floated = false,
  focused = false,
  invalid = false,
  disabled = false,
  required = false,
  variant = 'outlined',
  size = 'md',
  leading,
  trailing,
  grow = false,
  ring = true,
  style,
  testID,
}: FieldFrameProps) {
  const t = useTheme();
  const m = useFieldMetrics(size, !!label);
  const [labelWidth, setLabelWidth] = useState(0);

  const float = useSharedValue(floated ? 1 : 0);
  const focus = useSharedValue(focused ? 1 : 0);
  const bad = useSharedValue(invalid ? 1 : 0);

  useEffect(() => {
    float.value = withSpring(floated ? 1 : 0, LABEL_SPRING);
  }, [float, floated]);

  useEffect(() => {
    focus.value = withTiming(focused ? 1 : 0, t.motion.timing(t.motion.duration.fast, 'smooth'));
  }, [focus, focused, t.motion]);

  useEffect(() => {
    bad.value = withTiming(invalid ? 1 : 0, t.motion.timing(t.motion.duration.fast, 'smooth'));
  }, [bad, invalid, t.motion]);

  const fill = variant === 'filled' ? t.color.surfaceAlt : 'transparent';
  const restBorder = variant === 'filled' ? t.color.surfaceAlt : t.color.border;
  const focusBorder = t.color.focus;
  const badBorder = t.color.danger;

  const frameStyle = useAnimatedStyle(() => {
    const base = interpolateColor(focus.value, [0, 1], [restBorder, focusBorder]);
    return { borderColor: interpolateColor(bad.value, [0, 1], [base, badBorder]) };
  });

  const ringStyle = useAnimatedStyle(() => ({
    opacity: focus.value,
    // The ring expands into place rather than blinking on — the same physical
    // language as a press, run in reverse.
    transform: [{ scale: interpolate(focus.value, [0, 1], [1.02, 1]) }],
    borderColor: interpolateColor(bad.value, [0, 1], [focusBorder, badBorder]),
  }));

  const restTop = m.floatBlock / 2;
  const floatTop = -(m.textBlock * (1 - m.labelScale)) / 2;
  const labelInk = disabled ? t.color.textFaint : t.color.textTertiary;
  const labelLit = invalid ? t.color.onDangerSoft : t.color.primaryText;

  const labelBoxStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: interpolate(float.value, [0, 1], [0, -(labelWidth * (1 - m.labelScale)) / 2]) },
      { translateY: interpolate(float.value, [0, 1], [restTop, floatTop]) },
      { scale: interpolate(float.value, [0, 1], [1, m.labelScale]) },
    ],
  }));

  const labelInkStyle = useAnimatedStyle(() => ({
    color: interpolateColor(float.value, [0, 1], [labelInk, disabled ? labelInk : labelLit]),
  }));

  const measureLabel = useCallback((event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    setLabelWidth((prev) => (Math.abs(prev - width) < 1 ? prev : width));
  }, []);

  const adornment: ViewStyle = grow
    ? { height: m.floatBlock + m.textBlock, justifyContent: 'center' }
    : { justifyContent: 'center' };

  return (
    <View style={style} testID={testID}>
      {ring ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.ring,
            {
              top: -t.borderWidth.thick,
              left: -t.borderWidth.thick,
              right: -t.borderWidth.thick,
              bottom: -t.borderWidth.thick,
              borderRadius: m.radius + t.borderWidth.thick,
              borderWidth: t.borderWidth.focus,
            },
            ringStyle,
          ]}
        />
      ) : null}

      <Animated.View
        style={[
          styles.frame,
          {
            backgroundColor: fill,
            borderRadius: m.radius,
            borderWidth: t.borderWidth.thin,
            paddingHorizontal: m.padX,
            paddingVertical: m.padY,
            gap: m.gap,
            alignItems: grow ? 'flex-start' : 'center',
            opacity: disabled ? t.opacity.muted : 1,
          },
          grow ? { minHeight: m.height } : { height: m.height },
          frameStyle,
        ]}
      >
        {leading ? <View style={adornment}>{leading}</View> : null}

        <View
          style={[
            styles.column,
            { paddingTop: m.floatBlock, justifyContent: grow ? 'flex-start' : 'center' },
          ]}
        >
          {label ? (
            <Animated.View
              style={[styles.label, labelBoxStyle]}
              pointerEvents="none"
              // The control itself announces the label; reading it twice is worse
              // than not reading it at all.
              importantForAccessibility="no-hide-descendants"
            >
              <AnimatedText variant="body" numberOfLines={1} onLayout={measureLabel} style={[styles.labelText, labelInkStyle]}>
                {label}
                {required ? (
                  <Text variant="body" color="onDangerSoft">
                    {' *'}
                  </Text>
                ) : null}
              </AnimatedText>
            </Animated.View>
          ) : null}

          {children}
        </View>

        {trailing ? <View style={[adornment, styles.trailing]}>{trailing}</View> : null}
      </Animated.View>
    </View>
  );
}

/* ------------------------------------------------------------ message + count */

export function FieldMessage({ helper, error, reserve = false, style }: FieldMessageProps) {
  const t = useTheme();
  const [helperHeight, setHelperHeight] = useState(0);
  const [errorHeight, setErrorHeight] = useState(0);

  const target = error ? errorHeight : helper ? helperHeight : reserve ? Math.max(helperHeight, errorHeight) : 0;

  const height = useSharedValue(0);
  const bad = useSharedValue(error ? 1 : 0);
  const settled = useRef(false);

  useEffect(() => {
    // The first real measurement lands after mount; snapping to it avoids a
    // collapse-then-expand on every form that ships with helper text.
    if (!settled.current) {
      height.value = target;
      settled.current = target > 0;
      return;
    }
    height.value = withTiming(target, t.motion.timing(t.motion.duration.fast, 'smooth'));
  }, [height, t.motion, target]);

  useEffect(() => {
    bad.value = withTiming(error ? 1 : 0, t.motion.timing(t.motion.duration.fast, 'smooth'));
  }, [bad, error, t.motion]);

  const boxStyle = useAnimatedStyle(() => ({ height: height.value }));
  const lift = t.spacing.xxs;
  const helperStyle = useAnimatedStyle(() => ({
    opacity: 1 - bad.value,
    transform: [{ translateY: bad.value * lift }],
  }));
  const errorStyle = useAnimatedStyle(() => ({
    opacity: bad.value,
    transform: [{ translateY: (1 - bad.value) * -lift }],
  }));

  const measure = (set: (value: number) => void) => (event: LayoutChangeEvent) => {
    const { height: h } = event.nativeEvent.layout;
    set(Math.round(h));
  };

  // Both live in the tree at all times so their heights are known before either
  // is asked to show — that's what makes the swap jump-free.
  return (
    <Animated.View style={[styles.messageBox, boxStyle, style]} pointerEvents="box-none">
      <Animated.View style={[styles.messageLayer, helperStyle]} onLayout={measure(setHelperHeight)}>
        {helper ? (
          <Text variant="footnote" color="textTertiary" style={{ paddingTop: t.spacing.xs }}>
            {helper}
          </Text>
        ) : null}
      </Animated.View>

      <Animated.View style={[styles.messageLayer, errorStyle]} onLayout={measure(setErrorHeight)}>
        {error ? (
          <Row gap="xxs" align="start" style={{ paddingTop: t.spacing.xs }}>
            <View style={{ paddingTop: t.spacing.hair }}>
              <Icon name="alert-circle" size="xs" color="onDangerSoft" />
            </View>
            <Text
              variant="footnote"
              // `danger` itself lands at ~4.2:1 on the light ground — the `on*Soft`
              // ink is the palette's accessible red for text.
              color="onDangerSoft"
              style={styles.messageText}
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
            >
              {error}
            </Text>
          </Row>
        ) : null}
      </Animated.View>
    </Animated.View>
  );
}

export function FieldCounter({ length, max, active = false }: FieldCounterProps) {
  const t = useTheme();
  const over = length >= max;

  return (
    <Text
      variant="caption"
      tabular
      color={over ? 'onDangerSoft' : active ? 'textTertiary' : 'textFaint'}
      style={{ paddingTop: t.spacing.xs }}
      // Screen readers get the remaining count as words; the glyphs are for eyes.
      accessibilityLabel={`${max - length} characters remaining`}
    >
      {length}/{max}
    </Text>
  );
}

/* ----------------------------------------------------------------- overlays */

function useOverlay(visible: boolean) {
  const t = useTheme();
  const [mounted, setMounted] = useState(visible);
  const progress = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      return;
    }
    progress.value = withTiming(0, t.motion.timing(t.motion.duration.fast, 'accelerate'), (finished) => {
      'worklet';
      if (finished) runOnJS(setMounted)(false);
    });
  }, [progress, t.motion, visible]);

  useEffect(() => {
    if (mounted && visible) progress.value = withSpring(1, SHEET_SPRING);
  }, [mounted, progress, visible]);

  return { mounted, progress };
}

function OverlayBackdrop({ progress, onPress }: { progress: SharedValue<number>; onPress: () => void }) {
  const t = useTheme();
  const style = useAnimatedStyle(() => ({ opacity: progress.value }));

  return (
    <>
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: t.color.scrim }, style]}
      />
      <Touchable
        accessibilityRole="button"
        accessibilityLabel="Close"
        haptic="none"
        onPress={onPress}
        pressScale={1}
        style={StyleSheet.absoluteFill}
      />
    </>
  );
}

function OverlayHeader({
  title,
  subtitle,
  action,
  onClose,
}: {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  onClose: () => void;
}) {
  const t = useTheme();
  if (!title && !subtitle && !action) return null;

  return (
    <Row gap="md" align="center" style={{ paddingBottom: t.spacing.md }}>
      <View style={styles.flex}>
        {title ? (
          <Text variant="title3" numberOfLines={1} accessibilityRole="header">
            {title}
          </Text>
        ) : null}
        {subtitle ? (
          <Text variant="footnote" color="textTertiary" numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {action ?? <IconButton icon="close" accessibilityLabel="Close" size="sm" tone="neutral" onPress={onClose} />}
    </Row>
  );
}

/**
 * Bottom sheet, self-contained. Deliberately *not* built on `@gorhom/bottom-sheet`
 * so a field can open one from inside another modal — nested portals are exactly
 * where that library gives up.
 */
export function FieldSheet({
  visible,
  onRequestClose,
  title,
  subtitle,
  action,
  children,
  dismissOnDrag = true,
  contentStyle,
  testID,
}: FieldOverlayProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { mounted, progress } = useOverlay(visible);

  const drag = useSharedValue(0);
  const sheetHeight = useSharedValue(windowHeight);

  useEffect(() => {
    if (visible) drag.value = 0;
  }, [drag, visible]);

  const threshold = t.spacing.giant;
  const slop = t.spacing.sm;
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(dismissOnDrag)
        // Without a dead zone the header's close button loses every tap to the drag.
        .activeOffsetY([-slop, slop])
        .onUpdate((event) => {
          drag.value = Math.max(0, event.translationY);
        })
        .onEnd((event) => {
          if (drag.value > threshold || event.velocityY > FLING_VELOCITY) {
            runOnJS(onRequestClose)();
          } else {
            drag.value = withSpring(0, SNAPPY);
          }
        }),
    [dismissOnDrag, drag, onRequestClose, slop, threshold],
  );

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (1 - progress.value) * sheetHeight.value + drag.value }],
  }));

  const onSheetLayout = useCallback(
    (event: LayoutChangeEvent) => {
      sheetHeight.value = event.nativeEvent.layout.height;
    },
    [sheetHeight],
  );

  return (
    <Modal
      visible={mounted}
      transparent
      statusBarTranslucent
      animationType="none"
      onRequestClose={onRequestClose}
      testID={testID}
    >
      {/* An RN Modal is its own native window, and gesture-handler doesn't
          reach into one — the sheet's drag and any gestures a caller renders
          inside it need a root of their own. */}
      <GestureHandlerRootView style={styles.flex}>
        <OverlayBackdrop progress={progress} onPress={onRequestClose} />

        <Animated.View
          onLayout={onSheetLayout}
          style={[
            styles.sheet,
            t.elevation(4),
            {
              backgroundColor: t.color.surfaceRaised,
              borderTopLeftRadius: t.radius.xxl,
              borderTopRightRadius: t.radius.xxl,
              maxHeight: windowHeight * SHEET_MAX_HEIGHT_RATIO,
            },
            sheetStyle,
          ]}
        >
          <GestureDetector gesture={pan}>
            <View style={{ paddingHorizontal: t.gutter, paddingTop: t.spacing.md }}>
              <View
                style={[
                  styles.grabber,
                  {
                    width: t.spacing.xxxl,
                    height: t.spacing.xxs,
                    borderRadius: t.radius.pill,
                    backgroundColor: t.color.borderStrong,
                    marginBottom: t.spacing.md,
                  },
                ]}
              />
              <OverlayHeader title={title} subtitle={subtitle} action={action} onClose={onRequestClose} />
            </View>
          </GestureDetector>

          <View
            style={[
              { paddingHorizontal: t.gutter, paddingBottom: insets.bottom + t.spacing.lg },
              styles.shrink,
              contentStyle,
            ]}
          >
            {children}
          </View>
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}

/**
 * Centred dialog for pickers that are *choosers*, not lists — a calendar or a
 * clock reads better anchored in the middle of the screen than crawling up from
 * the bottom edge.
 */
export function FieldDialog({
  visible,
  onRequestClose,
  title,
  subtitle,
  action,
  children,
  contentStyle,
  testID,
}: Omit<FieldOverlayProps, 'dismissOnDrag'>) {
  const t = useTheme();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const { mounted, progress } = useOverlay(visible);

  const cardStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [
      { scale: interpolate(progress.value, [0, 1], [0.92, 1]) },
      { translateY: interpolate(progress.value, [0, 1], [t.spacing.lg, 0]) },
    ],
  }));

  // Phones get the full gutter-to-gutter width; the cap only ever bites on tablets.
  const maxWidth = Math.min(windowWidth - t.gutter * 2, t.spacing.colossal * 5);

  return (
    <Modal
      visible={mounted}
      transparent
      statusBarTranslucent
      animationType="none"
      onRequestClose={onRequestClose}
      testID={testID}
    >
      {/* Same reason as `FieldSheet`: a `Calendar` rendered in here swipes
          months, and that gesture needs a root inside the modal window. */}
      <GestureHandlerRootView style={[styles.flex, styles.dialogRoot, { padding: t.gutter }]}>
        <OverlayBackdrop progress={progress} onPress={onRequestClose} />

        <Animated.View
          style={[
            t.elevation(5),
            {
              width: maxWidth,
              maxHeight: windowHeight * SHEET_MAX_HEIGHT_RATIO,
              backgroundColor: t.color.surfaceRaised,
              borderRadius: t.radius.xxl,
              padding: t.spacing.lg,
            },
            cardStyle,
          ]}
        >
          <OverlayHeader title={title} subtitle={subtitle} action={action} onClose={onRequestClose} />
          <View style={[styles.shrink, contentStyle]}>{children}</View>
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}

/* ---------------------------------------------------------------- component */

/**
 * The row wrapper for controls that aren't text fields. The label sits *above*
 * the control here (rather than floating inside it) because a switch or a chip
 * row has no text baseline to float against — but the type, colour and message
 * behaviour are identical, so the two kinds of row still read as one form.
 *
 * The control keeps its own `accessibilityLabel`: wrapping it in an accessible
 * container would swallow its role and state.
 */
export function FormField({
  children,
  label,
  required = false,
  helper,
  error,
  action,
  disabled = false,
  reserveMessageSpace = false,
  style,
  testID,
}: FormFieldProps) {
  const t = useTheme();

  return (
    <View style={style} testID={testID}>
      {label || action ? (
        <Row gap="md" align="center" style={{ marginBottom: t.spacing.sm }}>
          {label ? (
            <Text
              variant="subheadStrong"
              color={disabled ? 'textFaint' : error ? 'onDangerSoft' : 'textSecondary'}
              style={styles.flex}
            >
              {label}
              {required ? (
                <Text variant="subheadStrong" color="onDangerSoft">
                  {' *'}
                </Text>
              ) : null}
            </Text>
          ) : (
            <View style={styles.flex} />
          )}
          {action}
        </Row>
      ) : null}

      {children}

      <FieldMessage helper={helper} error={error} reserve={reserveMessageSpace} />
    </View>
  );
}

/* ------------------------------------------------------------------ helpers */

/** Shared ink resolution so every field's value text matches every other's. */
export function fieldInk(t: Theme, disabled: boolean, filled: boolean): string {
  if (disabled) return t.color.textFaint;
  return filled ? t.color.text : t.color.textTertiary;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  shrink: { flexShrink: 1 },
  ring: { position: 'absolute' },
  frame: { flexDirection: 'row', overflow: 'visible' },
  column: { flex: 1, alignSelf: 'stretch' },
  // `right: 0` clips a long label to the field; `flexShrink` on the text is what
  // keeps `onLayout` reporting the glyph width rather than the full column.
  label: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row' },
  labelText: { flexShrink: 1 },
  trailing: { flexDirection: 'row', alignItems: 'center' },
  messageBox: { overflow: 'hidden' },
  messageLayer: { position: 'absolute', top: 0, left: 0, right: 0 },
  messageText: { flex: 1 },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  grabber: { alignSelf: 'center' },
  dialogRoot: { alignItems: 'center', justifyContent: 'center' },
});

export default FormField;
