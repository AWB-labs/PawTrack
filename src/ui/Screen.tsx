/**
 * Petal — Screen.
 *
 * The page wrapper every route starts with. It owns four things no screen
 * should have to re-solve:
 *
 *   · **Safe areas.** Opt in per edge; when a `header` is present the top inset
 *     belongs to the header and Screen stays out of the way.
 *   · **Scroll position, as a shared value.** `scrollY` is published on context
 *     so `ScreenHeader` (or a parallax hero, or a sticky segmented control) can
 *     react on the UI thread with no re-renders. Lists that aren't the Screen's
 *     own ScrollView can borrow `onScroll` and drive the same value.
 *   · **Header clearance.** The header floats so content can scroll *under* its
 *     blur; Screen pads the content by the height the header reports.
 *   · **Keyboard + pull-to-refresh**, wired once, correctly.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, { useAnimatedScrollHandler, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/theme';
import { resolveColor, type ColorProp } from './Text';

/* -------------------------------------------------------------------- types */

export type ScreenEdge = 'top' | 'bottom' | 'left' | 'right';

export type ScreenScrollHandler = ReturnType<typeof useAnimatedScrollHandler>;

export type ScreenScrollContextValue = {
  /** Live content offset, on the UI thread. */
  scrollY: SharedValue<number>;
  /** Attach to any Animated list that replaces the Screen's own ScrollView. */
  onScroll: ScreenScrollHandler;
  /** Expanded header height — content is padded by exactly this. */
  headerHeight: number;
  setHeaderHeight: (height: number) => void;
  /** Safe-area top inset, so headers don't need a second provider read. */
  topInset: number;
};

export type ScreenProps = {
  children?: ReactNode;
  /** Floating header — pass `<ScreenHeader/>`. Content scrolls beneath it. */
  header?: ReactNode;
  /** Sticky bottom bar for the primary action. Absorbs the bottom safe inset. */
  footer?: ReactNode;
  scroll?: boolean;
  scrollEnabled?: boolean;
  /** Centre the content in the remaining space — empty, error and 404 states. */
  center?: boolean;
  /** Horizontal gutter. Turn off for edge-to-edge lists and carousels. */
  padded?: boolean;
  background?: ColorProp;
  refreshing?: boolean;
  onRefresh?: () => void;
  keyboardAvoiding?: boolean;
  /** Extra bottom clearance — e.g. for a floating tab bar. */
  bottomInset?: number;
  edges?: ScreenEdge[];
  contentContainerStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ------------------------------------------------------------------ context */

const ScreenScrollContext = createContext<ScreenScrollContextValue | null>(null);

const NOOP = () => undefined;

/**
 * Read the host Screen's scroll state. Safe to call outside a Screen — you get
 * an inert value of 0 rather than a crash, so a header can be previewed or
 * dropped into a sheet without ceremony.
 */
export function useScreenScroll(): ScreenScrollContextValue {
  const context = useContext(ScreenScrollContext);
  const insets = useSafeAreaInsets();
  const detachedY = useSharedValue(0);
  const detachedHandler = useAnimatedScrollHandler(() => {
    // Nothing is listening when there's no Screen above us.
  });

  const detached = useMemo<ScreenScrollContextValue>(
    () => ({
      scrollY: detachedY,
      onScroll: detachedHandler,
      headerHeight: 0,
      setHeaderHeight: NOOP,
      topInset: insets.top,
    }),
    [detachedHandler, detachedY, insets.top],
  );

  return context ?? detached;
}

/* ---------------------------------------------------------------- component */

export function Screen({
  children,
  header,
  footer,
  scroll = false,
  scrollEnabled = true,
  center = false,
  padded = true,
  background = 'bg',
  refreshing = false,
  onRefresh,
  keyboardAvoiding = true,
  bottomInset = 0,
  edges = ['top', 'bottom'],
  contentContainerStyle,
  style,
  testID,
}: ScreenProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [headerHeight, setHeaderHeight] = useState(0);

  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });

  const reportHeaderHeight = useCallback((height: number) => {
    // Layout fires on every rotation and font-scale change; ignore sub-pixel noise.
    setHeaderHeight((prev) => (Math.abs(prev - height) < 1 ? prev : height));
  }, []);

  const context = useMemo<ScreenScrollContextValue>(
    () => ({ scrollY, onScroll, headerHeight, setHeaderHeight: reportHeaderHeight, topInset: insets.top }),
    [headerHeight, insets.top, onScroll, reportHeaderHeight, scrollY],
  );

  const ground = resolveColor(t.color, background, t.color.bg);
  const gutter = padded ? t.gutter : 0;

  const top = header ? headerHeight : edges.includes('top') ? insets.top : 0;
  const bottom = (edges.includes('bottom') && !footer ? insets.bottom : 0) + bottomInset;

  const inset: ViewStyle = {
    paddingTop: top,
    paddingBottom: bottom,
    paddingLeft: gutter + (edges.includes('left') ? insets.left : 0),
    paddingRight: gutter + (edges.includes('right') ? insets.right : 0),
  };

  const body = scroll ? (
    <Animated.ScrollView
      style={styles.flex}
      contentContainerStyle={[styles.grow, inset, center ? styles.center : null, contentContainerStyle]}
      onScroll={onScroll}
      scrollEventThrottle={16}
      scrollEnabled={scrollEnabled}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      // Keeps the iOS scrollbar out from under the floating header.
      scrollIndicatorInsets={{ top }}
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={t.color.textTertiary}
            colors={[t.color.primary]}
            progressBackgroundColor={t.color.surface}
            progressViewOffset={top}
          />
        ) : undefined
      }
    >
      {children}
    </Animated.ScrollView>
  ) : (
    <View style={[styles.flex, inset, center ? styles.center : null]}>{children}</View>
  );

  const content = keyboardAvoiding ? (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {body}
    </KeyboardAvoidingView>
  ) : (
    body
  );

  return (
    <ScreenScrollContext.Provider value={context}>
      <View style={[styles.flex, { backgroundColor: ground }, style]} testID={testID}>
        {content}

        {/* Rendered after the content so it wins the paint order on Android too. */}
        {header ? (
          <View style={[styles.header, { zIndex: t.zIndex.header }]} pointerEvents="box-none">
            {header}
          </View>
        ) : null}

        {footer ? (
          <View
            style={{
              backgroundColor: ground,
              borderTopWidth: t.borderWidth.hairline,
              borderTopColor: t.color.chromeBorder,
              paddingTop: t.spacing.md,
              paddingBottom: (edges.includes('bottom') ? insets.bottom : 0) + t.spacing.md,
              // A CTA bar always keeps its gutter, even on an edge-to-edge screen.
              paddingHorizontal: t.gutter,
            }}
          >
            {footer}
          </View>
        ) : null}
      </View>
    </ScreenScrollContext.Provider>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  grow: { flexGrow: 1 },
  center: { justifyContent: 'center', alignItems: 'center' },
  header: { position: 'absolute', top: 0, left: 0, right: 0 },
});

export default Screen;
