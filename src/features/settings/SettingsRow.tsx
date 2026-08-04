/**
 * Petal — SettingsRow.
 *
 * The one row every settings screen is built from: a tinted icon tile, a title
 * with an optional second line, and one trailing control — a switch, a value, a
 * chevron, or something bespoke.
 *
 * Four decisions worth knowing:
 *
 *   · **The row doesn't scale under a thumb, it lights up.** A card in a
 *     grouped list that shrinks on press pulls away from its neighbours and
 *     shows the ground through the seam. So the press feedback is an ink
 *     overlay at `opacity.divider` — the same highlight both platforms use for
 *     grouped lists — and the corner radii follow the row's position so a
 *     pressed first row is round at the top and square at the bottom.
 *   · **A switch row is the whole row.** The control is rendered inert and the
 *     row carries `accessibilityRole="switch"`, which turns a 32pt toggle into
 *     a 56pt target and one screen-reader node instead of two.
 *   · **Values move when they change.** A settings hub that shows "Dark" where
 *     it said "Light" a second ago should say so; the value dips and lifts
 *     rather than swapping silently.
 *   · **`disabledReason` beats `disabled`.** Same contract as the rest of the
 *     library — a row that can't act yet stays pressable so it can explain
 *     itself.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
  type WithSpringConfig,
} from 'react-native-reanimated';

import haptics from '@/lib/haptics';
import { spring, useTheme, type Theme } from '@/theme';
import { Icon, Switch, Text, Touchable, type IconName } from '@/ui';

/* -------------------------------------------------------------------- types */

export type SettingsRowTone =
  | 'primary'
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'neutral';

/** Where this row sits in its group. Supplied by `<SettingsGroup>`. */
export type SettingsRowPosition = { first: boolean; last: boolean };

export type SettingsRowProps = {
  title: string;
  /** One quiet line of context. Say what the setting *does*, not what it is. */
  subtitle?: string;
  icon: IconName;
  tone?: SettingsRowTone;
  /** Right-aligned current value — "Dark", "kg", "10pm – 7am". */
  value?: string;
  /** Present makes this a switch row; the whole row becomes the target. */
  checked?: boolean;
  onCheckedChange?: (next: boolean) => void;
  /** Bespoke trailing content. Suppresses the chevron. */
  trailing?: ReactNode;
  onPress?: () => void;
  /** Defaults to on for a tappable row without a switch or bespoke trailing. */
  chevron?: boolean;
  /** Paints the title and tile in the destructive colour. */
  destructive?: boolean;
  disabled?: boolean;
  /** Looks disabled, still answers — wire it to an explanation. */
  disabledReason?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/** See `Touchable` — the theme's `springWith` helper doesn't type-check yet. */
const PRESS_SPRING: WithSpringConfig = { ...spring.press, reduceMotion: ReduceMotion.System };

/** How far the value dips out of the way as it changes. */
const VALUE_FADE = 0.65;

const SOLO: SettingsRowPosition = { first: true, last: true };

/** The inert switch needs a handler it will never call. */
const NOOP = () => undefined;

const PositionContext = createContext<SettingsRowPosition>(SOLO);

/** Wraps one child so it knows whether it draws the group's top or bottom corners. */
export function SettingsRowPositionProvider({
  position,
  children,
}: {
  position: SettingsRowPosition;
  children: ReactNode;
}) {
  return <PositionContext.Provider value={position}>{children}</PositionContext.Provider>;
}

/* ------------------------------------------------------------------ helpers */

function toneSkin(t: Theme, tone: SettingsRowTone): { fill: string; ink: string } {
  switch (tone) {
    case 'accent':
      return { fill: t.color.accentSoft, ink: t.color.onAccentSoft };
    case 'success':
      return { fill: t.color.successSoft, ink: t.color.onSuccessSoft };
    case 'warning':
      return { fill: t.color.warningSoft, ink: t.color.onWarningSoft };
    case 'danger':
      return { fill: t.color.dangerSoft, ink: t.color.onDangerSoft };
    case 'info':
      return { fill: t.color.infoSoft, ink: t.color.onInfoSoft };
    case 'neutral':
      return { fill: t.color.surfaceAlt, ink: t.color.textSecondary };
    case 'primary':
    default:
      return { fill: t.color.primarySoft, ink: t.color.onPrimarySoft };
  }
}

/* ---------------------------------------------------------------- component */

export function SettingsRow({
  title,
  subtitle,
  icon,
  tone = 'primary',
  value,
  checked,
  onCheckedChange,
  trailing,
  onPress,
  chevron,
  destructive = false,
  disabled = false,
  disabledReason,
  accessibilityHint,
  style,
  testID,
}: SettingsRowProps) {
  const t = useTheme();
  const position = useContext(PositionContext);

  const isSwitch = checked !== undefined;
  const skin = toneSkin(t, destructive ? 'danger' : tone);
  const tile = t.spacing.xxxl;
  const gap = t.spacing.md;
  const padX = t.spacing.base;
  const inert = disabled || disabledReason !== undefined;

  /* ---- press highlight ------------------------------------------------- */

  const held = useSharedValue(0);
  const highlight = t.opacity.divider;

  const highlightStyle = useAnimatedStyle(() => ({ opacity: held.value * highlight }));

  const onPressIn = useCallback(() => {
    held.value = withSpring(1, PRESS_SPRING);
  }, [held]);

  const onPressOut = useCallback(() => {
    held.value = withSpring(0, PRESS_SPRING);
  }, [held]);

  /* ---- the value's little move ----------------------------------------- */

  const bump = useSharedValue(0);
  const seen = useRef(value);
  const reduceMotion = t.reduceMotion;
  const lift = t.spacing.xs;

  useEffect(() => {
    if (seen.current === value) return;
    seen.current = value;
    if (reduceMotion || value === undefined) return;
    bump.value = withSequence(
      withTiming(1, t.motion.timing(t.motion.duration.instant, 'accelerate')),
      withTiming(0, t.motion.timing(t.motion.duration.base, 'decelerate')),
    );
  }, [bump, reduceMotion, t.motion, value]);

  const valueStyle = useAnimatedStyle(() => ({
    opacity: 1 - bump.value * VALUE_FADE,
    transform: [{ translateY: -bump.value * lift }],
  }));

  /* ---- behaviour -------------------------------------------------------- */

  const handlePress = useCallback(() => {
    if (checked !== undefined) {
      // The commit lands with the state change, not with the touch — a toggle
      // that buzzes before it moves feels like it fired twice.
      haptics.commit();
      onCheckedChange?.(!checked);
      return;
    }
    onPress?.();
  }, [checked, onCheckedChange, onPress]);

  const tappable = isSwitch || onPress !== undefined || disabledReason !== undefined;
  const showChevron = chevron ?? (tappable && !isSwitch && trailing === undefined);

  const corners: ViewStyle = {
    borderTopLeftRadius: position.first ? t.radius.xl : 0,
    borderTopRightRadius: position.first ? t.radius.xl : 0,
    borderBottomLeftRadius: position.last ? t.radius.xl : 0,
    borderBottomRightRadius: position.last ? t.radius.xl : 0,
  };

  const description = [title, subtitle, value].filter(Boolean).join(', ');

  const body = (
    <View style={corners}>
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, corners, { backgroundColor: t.color.text }, highlightStyle]}
      />

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap,
          paddingHorizontal: padX,
          paddingVertical: t.spacing.md,
          minHeight: t.minTarget + t.spacing.md,
          opacity: inert ? t.opacity.disabled : 1,
        }}
      >
        <View
          style={{
            width: tile,
            height: tile,
            borderRadius: t.radius.md,
            backgroundColor: skin.fill,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name={icon} size="md" color={skin.ink} />
        </View>

        <View style={{ flex: 1, gap: t.spacing.hair }}>
          <Text variant="body" color={destructive ? 'danger' : 'text'} numberOfLines={2}>
            {title}
          </Text>
          {subtitle ? (
            <Text variant="footnote" color="textTertiary" numberOfLines={3}>
              {subtitle}
            </Text>
          ) : null}
        </View>

        {value !== undefined ? (
          <Animated.View style={[{ maxWidth: '42%' }, valueStyle]}>
            <Text variant="subhead" color="textSecondary" numberOfLines={1} align="right" tabular>
              {value}
            </Text>
          </Animated.View>
        ) : null}

        {checked !== undefined ? (
          // Inert on purpose: the row is the target, and one switch node in the
          // accessibility tree beats two that disagree.
          <View pointerEvents="none" importantForAccessibility="no-hide-descendants">
            <Switch
              value={checked}
              onValueChange={NOOP}
              tone={destructive ? 'accent' : 'primary'}
              accessibilityLabel={title}
            />
          </View>
        ) : (
          trailing
        )}

        {showChevron ? <Icon name="chevron-forward" size="sm" color="textTertiary" /> : null}
      </View>

      {position.last ? null : (
        <View
          style={{
            marginLeft: padX + tile + gap,
            height: t.borderWidth.hairline,
            backgroundColor: t.color.divider,
          }}
        />
      )}
    </View>
  );

  if (!tappable) {
    return (
      <View accessible accessibilityRole="text" accessibilityLabel={description} style={style} testID={testID}>
        {body}
      </View>
    );
  }

  return (
    <Touchable
      accessibilityRole={isSwitch ? 'switch' : 'button'}
      accessibilityLabel={description}
      accessibilityHint={accessibilityHint}
      accessibilityState={isSwitch ? { checked, disabled } : { disabled }}
      disabled={disabled}
      disabledReason={disabledReason}
      haptic={isSwitch ? 'none' : 'tap'}
      onPress={handlePress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      // The highlight is the feedback; scaling a row inside a grouped card
      // would open a seam to the ground behind it.
      pressScale={1}
      style={style}
      testID={testID}
    >
      {body}
    </Touchable>
  );
}

export default SettingsRow;
