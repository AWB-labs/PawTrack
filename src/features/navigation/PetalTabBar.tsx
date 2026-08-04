/**
 * Petal's tab bar.
 *
 * Design notes, because most of this is deliberate:
 *  - It **floats**: inset from the edges, rounded, elevated, with a blurred
 *    translucent fill so content scrolling underneath stays visible. A bar
 *    welded to the bottom edge makes a phone screen feel shorter.
 *  - The active indicator is a **soft pill that springs** between tabs rather
 *    than a colour swap, so switching tabs has a physical direction.
 *  - The icon does a small **overshoot scale + lift** on becoming active, and
 *    the label cross-fades from `textTertiary` to `primaryText`.
 *  - **Today carries a live badge** of outstanding care tasks. That number is
 *    the single most important thing in the app, so it is visible from every
 *    screen rather than only on the Today tab itself.
 *  - Everything degrades cleanly under reduced motion: the pill still moves
 *    (it's a position cue, not decoration) but with a short timing instead of a
 *    spring, and the icon scale is dropped.
 */

import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { BlurView } from 'expo-blur';
import React, { useCallback, useEffect } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import Animated, {
  interpolate,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useOutstandingTaskCount } from '@/data/queries/useCareTasks';
import haptics from '@/lib/haptics';
import { useTheme, type Theme } from '@/theme';
import Icon, { type IconName } from '@/ui/Icon';
import Text from '@/ui/Text';
import Touchable from '@/ui/Touchable';

const TAB_META: Record<string, { icon: IconName; activeIcon: IconName; label: string }> = {
  index: { icon: 'sunny-outline', activeIcon: 'sunny', label: 'Today' },
  pets: { icon: 'paw-outline', activeIcon: 'paw', label: 'Pets' },
  community: { icon: 'chatbubbles-outline', activeIcon: 'chatbubbles', label: 'Community' },
  you: { icon: 'person-outline', activeIcon: 'person', label: 'You' },
};

const BAR_HEIGHT = 60;
const H_INSET = 14;

export function PetalTabBar({ state, navigation }: BottomTabBarProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const outstanding = useOutstandingTaskCount();

  const routeCount = state.routes.length;
  const [barWidth, setBarWidth] = React.useState(0);
  const indicator = useSharedValue(state.index);

  useEffect(() => {
    indicator.value = t.reduceMotion
      ? withTiming(state.index, t.motion.timing(t.motion.duration.fast))
      : withSpring(state.index, t.motion.springWith('snappy'));
  }, [state.index, indicator, t]);

  const segment = barWidth > 0 ? barWidth / routeCount : 0;

  const pillStyle = useAnimatedStyle(() => ({
    width: Math.max(segment - 12, 0),
    transform: [{ translateX: indicator.value * segment + 6 }],
  }));

  const onPress = useCallback(
    (index: number, routeKey: string, routeName: string, focused: boolean) => {
      const event = navigation.emit({ type: 'tabPress', target: routeKey, canPreventDefault: true });
      if (focused || event.defaultPrevented) {
        // Re-tapping the active tab is a "scroll to top" gesture elsewhere in
        // the app; still give the tick so the tap doesn't feel dead.
        haptics.select();
        return;
      }
      haptics.tap();
      navigation.navigate(routeName);
    },
    [navigation],
  );

  const bottomPad = Math.max(insets.bottom, t.spacing.md);

  return (
    <View
      style={[styles.wrap, { paddingBottom: bottomPad, paddingHorizontal: H_INSET }]}
      pointerEvents="box-none"
    >
      <View
        onLayout={(e) => setBarWidth(e.nativeEvent.layout.width)}
        style={[
          styles.bar,
          t.elevation(4),
          {
            height: BAR_HEIGHT,
            borderRadius: t.radius.xxl,
            borderWidth: t.borderWidth.hairline,
            borderColor: t.color.chromeBorder,
            backgroundColor:
              Platform.OS === 'android' ? t.color.surface : t.color.surfaceGlass,
          },
        ]}
      >
        {Platform.OS !== 'android' && (
          <BlurView
            intensity={t.scheme === 'dark' ? 40 : 28}
            tint={t.scheme === 'dark' ? 'dark' : 'light'}
            style={[StyleSheet.absoluteFill, { borderRadius: t.radius.xxl }]}
          />
        )}

        {segment > 0 && (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.pill,
              pillStyle,
              {
                backgroundColor: t.color.primarySoft,
                borderRadius: t.radius.xl,
                borderWidth: t.borderWidth.hairline,
                borderColor: t.color.primarySoftBorder,
              },
            ]}
          />
        )}

        {state.routes.map((route, index) => {
          const meta = TAB_META[route.name];
          if (!meta) return null;
          const focused = state.index === index;
          const badge = route.name === 'index' ? outstanding : 0;

          return (
            <TabItem
              key={route.key}
              theme={t}
              meta={meta}
              focused={focused}
              badge={badge}
              onPress={() => onPress(index, route.key, route.name, focused)}
            />
          );
        })}
      </View>
    </View>
  );
}

type TabItemProps = {
  theme: Theme;
  meta: { icon: IconName; activeIcon: IconName; label: string };
  focused: boolean;
  badge: number;
  onPress: () => void;
};

function TabItem({ theme: t, meta, focused, badge, onPress }: TabItemProps) {
  const progress = useSharedValue(focused ? 1 : 0);

  useEffect(() => {
    progress.value = t.reduceMotion
      ? withTiming(focused ? 1 : 0, t.motion.timing(t.motion.duration.fast))
      : withSpring(focused ? 1 : 0, t.motion.springWith('bouncy'));
  }, [focused, progress, t]);

  const iconStyle = useAnimatedStyle(() => {
    if (t.reduceMotion) return {};
    return {
      transform: [
        { scale: interpolate(progress.value, [0, 1], [1, 1.1]) },
        { translateY: interpolate(progress.value, [0, 1], [0, -1.5]) },
      ],
    };
  });

  const labelStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 1], [0.82, 1]),
  }));

  // A dot rather than a number once it stops being countable at a glance.
  const badgeLabel = badge > 9 ? '9+' : String(badge);

  return (
    <Touchable
      onPress={onPress}
      haptic="none"
      pressScale="small"
      style={styles.item}
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={
        badge > 0
          ? `${meta.label}, ${badge} ${badge === 1 ? 'task' : 'tasks'} still to do`
          : meta.label
      }
    >
      <View style={styles.iconWrap}>
        <Animated.View style={iconStyle}>
          <Icon
            name={focused ? meta.activeIcon : meta.icon}
            size="lg"
            color={focused ? 'primaryText' : 'textTertiary'}
          />
        </Animated.View>

        {badge > 0 && (
          <View
            style={[
              styles.badge,
              {
                backgroundColor: t.color.accent,
                borderRadius: t.radius.pill,
                borderColor: t.color.surface,
                borderWidth: 2,
              },
            ]}
          >
            <Text variant="captionStrong" color="onAccent" style={styles.badgeText}>
              {badgeLabel}
            </Text>
          </View>
        )}
      </View>

      <Animated.View style={labelStyle}>
        <Text
          variant="caption"
          color={focused ? 'primaryText' : 'textTertiary'}
          numberOfLines={1}
          style={styles.label}
        >
          {meta.label}
        </Text>
      </Animated.View>
    </Touchable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'transparent',
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    overflow: 'hidden',
  },
  pill: {
    position: 'absolute',
    left: 0,
    top: 6,
    bottom: 6,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    height: '100%',
  },
  iconWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: -6,
    left: 10,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontSize: 10,
    lineHeight: 13,
  },
  label: {
    letterSpacing: 0.1,
  },
});

export default PetalTabBar;
