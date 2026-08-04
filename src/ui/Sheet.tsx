/**
 * Petal — Sheet.
 *
 * A thin, themed layer over `@gorhom/bottom-sheet` v5 so no screen has to
 * remember six props to get a sheet that matches the rest of the app. What this
 * wrapper owns:
 *
 *   · **The chrome** — surface, radius, handle, and a backdrop that fades with
 *     the sheet's own position rather than snapping on at index 0.
 *   · **Snap points as intent.** `size="half"` beats `snapPoints={['58%']}`
 *     scattered across twelve files; `percentSnapPoints()` is there for the rest.
 *   · **Keyboard behaviour**, wired the way forms actually need it: the sheet
 *     rides the keyboard, and restores when it goes.
 *   · **An imperative handle.** Sheets open from press handlers, so `useSheet()`
 *     returns `open`/`close` rather than asking screens to juggle a ref.
 *
 * `ConfirmSheet` exists because destructive confirmation is the one dialogue we
 * must never hand to `Alert`: it can't carry the pet's name, it can't be themed,
 * and it looks identical whether you're deleting a photo or a medical history.
 */

import {
  BottomSheetFooter,
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetView,
  type BottomSheetBackdropProps,
  type BottomSheetFooterProps,
} from '@gorhom/bottom-sheet';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  ReduceMotion,
  useAnimatedStyle,
  type WithSpringConfig,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import haptics from '@/lib/haptics';
import { spring, useTheme } from '@/theme';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import { IconButton } from './IconButton';
import { Text } from './Text';
import { Touchable } from './Touchable';

/* -------------------------------------------------------------------- types */

export type SheetSize = 'compact' | 'half' | 'tall' | 'full';

export type SheetController = {
  ref: React.RefObject<BottomSheetModal | null>;
  open: () => void;
  close: () => void;
  expand: () => void;
  collapse: () => void;
  snapTo: (index: number) => void;
};

export type SheetProps = {
  controller: SheetController;
  children?: ReactNode;
  /** Shorthand for a common height. Ignored when `snapPoints` is given. */
  size?: SheetSize;
  /** Explicit stops. Omit both this and `size` to size to the content. */
  snapPoints?: readonly (string | number)[];
  index?: number;
  /** Renders a `<SheetHeader>` for you. */
  title?: string;
  subtitle?: string;
  /** Pan down and backdrop press close the sheet. Off for must-answer sheets. */
  dismissible?: boolean;
  showHandle?: boolean;
  /** Wrap the content in a `BottomSheetScrollView` — required for long forms. */
  scrollable?: boolean;
  /** Pinned below the content, outside the scroll area. */
  footer?: ReactNode;
  padded?: boolean;
  onDismiss?: () => void;
  onChange?: (index: number) => void;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
};

export type SheetHeaderProps = {
  title: string;
  subtitle?: string;
  onClose?: () => void;
  /** Leading slot — an icon well, a pet avatar. */
  leading?: ReactNode;
  /** Trailing slot. Replaces the close button when given. */
  trailing?: ReactNode;
  align?: 'left' | 'center';
  divider?: boolean;
};

export type ConfirmSheetProps = {
  controller: SheetController;
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  icon?: IconName;
  /** Consequences, a preview of what's lost, anything worth seeing first. */
  children?: ReactNode;
  onConfirm: () => void | Promise<unknown>;
  onCancel?: () => void;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/**
 * Heights as intent. Percentages of the available height (minus `topInset`),
 * chosen so each stop lands clear of the one below it — sheets that differ by
 * 5% read as a mistake rather than a choice.
 */
export const SHEET_SNAP: Record<SheetSize, readonly string[]> = {
  compact: ['34%'],
  half: ['58%'],
  tall: ['88%'],
  full: ['96%'],
};

/** See Touchable: the theme's `springWith` helper doesn't type-check yet. */
const SHEET_SPRING: WithSpringConfig = { ...spring.heavy, reduceMotion: ReduceMotion.System };

/* ------------------------------------------------------------------ helpers */

/** Build snap points from fractions: `percentSnapPoints(0.5, 0.9)`. */
export function percentSnapPoints(...fractions: number[]): string[] {
  return fractions.map((fraction) => `${Math.round(Math.min(1, Math.max(0.05, fraction)) * 100)}%`);
}

/**
 * The imperative handle. Sheets are opened from press handlers and mutation
 * callbacks, never from render, so a ref beats a `visible` prop here.
 */
export function useSheet(): SheetController {
  const ref = useRef<BottomSheetModal | null>(null);
  return useMemo<SheetController>(
    () => ({
      ref,
      open: () => ref.current?.present(),
      close: () => ref.current?.dismiss(),
      expand: () => ref.current?.expand(),
      collapse: () => ref.current?.collapse(),
      snapTo: (index: number) => ref.current?.snapToIndex(index),
    }),
    [],
  );
}

/* ------------------------------------------------------------------- chrome */

/** Module-scope so its identity is stable and the sheet never remounts it. */
function SheetHandle() {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', paddingTop: t.spacing.md, paddingBottom: t.spacing.sm }}>
      <View
        style={{
          width: t.spacing.xxxl,
          height: t.spacing.xxs,
          borderRadius: t.radius.pill,
          backgroundColor: t.color.borderStrong,
        }}
      />
    </View>
  );
}

/**
 * Fades with the sheet's real position rather than switching at a snap index,
 * so an interrupted drag never leaves the scrim at full strength.
 */
function SheetBackdrop({
  animatedIndex,
  style,
  onPress,
}: BottomSheetBackdropProps & { onPress?: () => void }) {
  const t = useTheme();
  const fade = useAnimatedStyle(() => ({
    opacity: interpolate(animatedIndex.value, [-1, 0], [0, 1], Extrapolation.CLAMP),
  }));

  return (
    <Animated.View style={[style, { backgroundColor: t.color.scrim }, fade]}>
      {onPress ? (
        <Touchable
          accessibilityRole="button"
          accessibilityLabel="Close"
          accessibilityHint="Closes this sheet."
          haptic="none"
          onPress={onPress}
          // A full-screen target must not scale — only the sheet moves.
          pressScale={1}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
    </Animated.View>
  );
}

/* ---------------------------------------------------------------- component */

export function Sheet({
  controller,
  children,
  size,
  snapPoints,
  index = 0,
  title,
  subtitle,
  dismissible = true,
  showHandle = true,
  scrollable = false,
  footer,
  padded = true,
  onDismiss,
  onChange,
  contentStyle,
  testID,
}: SheetProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();

  const points = useMemo(() => {
    const source = snapPoints ?? (size ? SHEET_SNAP[size] : undefined);
    // The library mutates its snap-point array internally; hand it a copy.
    return source ? [...source] : undefined;
  }, [size, snapPoints]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <SheetBackdrop {...props} onPress={dismissible ? controller.close : undefined} />
    ),
    [controller.close, dismissible],
  );

  const pad = padded ? t.gutter : 0;

  const header = title ? (
    <SheetHeader
      title={title}
      subtitle={subtitle}
      onClose={dismissible ? controller.close : undefined}
    />
  ) : null;

  const bodyPadding: ViewStyle = {
    paddingHorizontal: pad,
    paddingBottom: footer && scrollable ? t.spacing.giant : insets.bottom + t.spacing.lg,
  };

  /**
   * A pinned footer only makes sense over a scroll area — on a content-sized
   * sheet the buttons are already the last thing you see, and pinning them
   * would float them over their own content.
   */
  const renderFooter = useCallback(
    (props: BottomSheetFooterProps) => (
      <BottomSheetFooter {...props}>
        <View
          style={{
            paddingHorizontal: pad,
            paddingTop: t.spacing.md,
            paddingBottom: insets.bottom + t.spacing.md,
            backgroundColor: t.color.surfaceRaised,
            borderTopWidth: t.borderWidth.hairline,
            borderTopColor: t.color.divider,
          }}
        >
          {footer}
        </View>
      </BottomSheetFooter>
    ),
    [footer, insets.bottom, pad, t.borderWidth.hairline, t.color.divider, t.color.surfaceRaised, t.spacing.md],
  );

  return (
    <BottomSheetModal
      ref={controller.ref}
      index={index}
      snapPoints={points}
      // Content-sized by default: most sheets in this app are short.
      enableDynamicSizing={points === undefined}
      enablePanDownToClose={dismissible}
      enableDismissOnClose
      onDismiss={onDismiss}
      onChange={onChange}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      topInset={insets.top + t.spacing.xl}
      handleComponent={showHandle ? SheetHandle : null}
      backdropComponent={renderBackdrop}
      footerComponent={footer && scrollable ? renderFooter : undefined}
      backgroundStyle={{
        backgroundColor: t.color.surfaceRaised,
        borderTopLeftRadius: t.radius.xxxl,
        borderTopRightRadius: t.radius.xxxl,
      }}
      style={t.elevation(5)}
      animationConfigs={SHEET_SPRING}
      overrideReduceMotion={ReduceMotion.System}
      accessibilityLabel={title}
    >
      {scrollable ? (
        <BottomSheetScrollView
          style={styles.flex}
          contentContainerStyle={[bodyPadding, contentStyle]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          testID={testID}
        >
          {header}
          {children}
        </BottomSheetScrollView>
      ) : (
        <BottomSheetView style={[bodyPadding, contentStyle]} testID={testID}>
          {header}
          {children}
          {footer ? <View style={{ paddingTop: t.spacing.base }}>{footer}</View> : null}
        </BottomSheetView>
      )}
    </BottomSheetModal>
  );
}

/* ------------------------------------------------------------------- header */

export function SheetHeader({
  title,
  subtitle,
  onClose,
  leading,
  trailing,
  align = 'left',
  divider = false,
}: SheetHeaderProps) {
  const t = useTheme();

  return (
    <View
      style={[
        styles.header,
        {
          gap: t.spacing.md,
          paddingBottom: t.spacing.base,
          marginBottom: divider ? t.spacing.base : 0,
          borderBottomWidth: divider ? t.borderWidth.hairline : 0,
          borderBottomColor: t.color.divider,
        },
      ]}
    >
      {leading}
      <View style={[styles.flex, align === 'center' ? styles.center : null]}>
        <Text variant="title2" align={align === 'center' ? 'center' : 'left'} accessibilityRole="header">
          {title}
        </Text>
        {subtitle ? (
          <Text
            variant="footnote"
            color="textSecondary"
            align={align === 'center' ? 'center' : 'left'}
            style={{ marginTop: t.spacing.xxs }}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing ??
        (onClose ? (
          <IconButton
            icon="close"
            accessibilityLabel="Close"
            accessibilityHint="Closes this sheet."
            variant="tonal"
            tone="neutral"
            size="sm"
            onPress={onClose}
          />
        ) : null)}
    </View>
  );
}

/* ------------------------------------------------------------ confirm sheet */

/**
 * Destructive confirmation. Deliberately asymmetric: the destructive button is
 * the visually loud one but sits *below* Cancel, so muscle memory doesn't
 * delete a pet's vaccination history.
 */
export function ConfirmSheet({
  controller,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  icon,
  children,
  onConfirm,
  onCancel,
  testID,
}: ConfirmSheetProps) {
  const t = useTheme();
  const [pending, setPending] = useState(false);
  const alive = useRef(true);
  const wasOpen = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // A destructive question deserves a physical beat before you read it.
  const handleChange = useCallback(
    (index: number) => {
      const open = index >= 0;
      if (open && !wasOpen.current) {
        if (tone === 'danger') haptics.warn();
        else haptics.tap();
      }
      wasOpen.current = open;
    },
    [tone],
  );

  const handleCancel = useCallback(() => {
    onCancel?.();
    controller.close();
  }, [controller, onCancel]);

  const handleConfirm = useCallback(() => {
    haptics.heavy();
    const result = onConfirm();
    if (!isPromise(result)) {
      controller.close();
      return;
    }
    setPending(true);
    void result
      .then(() => {
        controller.close();
      })
      .finally(() => {
        if (alive.current) setPending(false);
      });
  }, [controller, onConfirm]);

  const danger = tone === 'danger';
  const soft = danger ? t.color.dangerSoft : t.color.primarySoft;
  const ink = danger ? t.color.onDangerSoft : t.color.onPrimarySoft;
  const glyph: IconName = icon ?? (danger ? 'trash-outline' : 'help-circle-outline');
  const well = t.spacing.huge;

  return (
    <Sheet
      controller={controller}
      onChange={handleChange}
      dismissible={!pending}
      testID={testID}
      contentStyle={{ gap: t.spacing.base, paddingTop: t.spacing.sm }}
    >
      <View
        style={[
          styles.center,
          { width: well, height: well, borderRadius: t.radius.lg, backgroundColor: soft },
        ]}
      >
        <Icon name={glyph} size="lg" color={ink} />
      </View>

      <View style={{ gap: t.spacing.xs }}>
        <Text variant="title2" accessibilityRole="header">
          {title}
        </Text>
        {body ? (
          <Text variant="callout" color="textSecondary">
            {body}
          </Text>
        ) : null}
      </View>

      {children}

      <View style={{ gap: t.spacing.sm, paddingTop: t.spacing.xs }}>
        <Button
          label={cancelLabel}
          onPress={handleCancel}
          variant="secondary"
          size="lg"
          fullWidth
          disabled={pending}
        />
        <Button
          label={confirmLabel}
          onPress={handleConfirm}
          variant={danger ? 'danger' : 'primary'}
          size="lg"
          fullWidth
          loading={pending}
          haptic="none"
          accessibilityHint="This can’t be undone."
        />
      </View>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ helpers */

function isPromise(value: unknown): value is Promise<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as Promise<unknown>).then === 'function';
}

/* ----------------------------------------------------------------- styles */

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'flex-start' },
});

export default Sheet;
