/**
 * Petal — the pet profile header.
 *
 * Two pieces that are really one object at two sizes:
 *
 *   · **`PetHero`** rides *inside* the scroll content. The photograph is
 *     over-scroll elastic (it grows to fill the pull rather than exposing the
 *     page ground) and parallaxes away under an identity plate that carries the
 *     name, the facts and the quick actions.
 *   · **`PetHeroBar`** is its collapsed form, handed to `<Screen header={…}>`.
 *     It deliberately never reports a height, which is what lets the hero start
 *     at y=0 and scroll *under* the blurred chrome instead of below it.
 *
 * Why the name sits on a plate rather than on the photograph: over-photo text
 * needs a permanently light ink, and `textInverse` flips to near-black in dark
 * mode. A plate keeps every colour a token and every contrast pairing audited —
 * and it survives a photo that happens to be a white cat on a white sofa.
 *
 * Everything moves on the UI thread from one shared value. The parallax is
 * decorative, so `reduceMotion` keeps the fade and drops the travel.
 */

import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import React, { type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';

import { SPECIES_META, type Pet } from '@/data/types';
import { possessive } from '@/lib/format';
import type { Membership } from '@/rbac/permissions';
import { RoleBadge } from '@/rbac/RoleBadge';
import { useTheme, type Theme } from '@/theme';
import {
  Column,
  Divider,
  Icon,
  IconButton,
  Row,
  Surface,
  Text,
  Touchable,
  useScreenScroll,
  type IconName,
} from '@/ui';

import { PetStatusPill, describePet, type PetStatusChip } from './PetCard';

/* -------------------------------------------------------------------- types */

export type PetHeroActionTone = 'primary' | 'accent' | 'success' | 'warning' | 'info' | 'neutral';

export type PetHeroAction = {
  id: string;
  label: string;
  icon: IconName;
  onPress: () => void;
  tone?: PetHeroActionTone;
  /** Renders the action dimmed but tappable — wire `onPress` to `explain()`. */
  disabledReason?: string;
};

export type PetHeroProps = {
  pet: Pet;
  /** Defaults to the host `Screen`'s scroll position. */
  scrollY?: SharedValue<number>;
  /** Photo height below the status bar. The inset is covered on top of this. */
  height?: number;
  /** Up to four. Beyond that they stop being quick. */
  actions?: readonly PetHeroAction[];
  /** The viewer's membership — a sitter gets their window on the plate. */
  membership?: Membership | null;
  /** Health flags worth seeing before anything else: allergies, conditions. */
  flags?: readonly PetStatusChip[];
  /** Tapping the photograph. Usually opens the editor. */
  onPhotoPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export type PetHeroBarProps = {
  pet: Pet;
  /** Scroll distance over which the bar takes over. Defaults to the hero height. */
  revealAt?: number;
  /** Right-hand controls — edit, share, overflow. */
  actions?: ReactNode;
  onBack?: () => void;
  /** Defaults to the host `Screen`'s scroll position. */
  scrollY?: SharedValue<number>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/** How far the photo lags the content on the way up. 1 would be no parallax. */
const PARALLAX = 0.42;

/** The photo is spent by this fraction of its own height. */
const FADE_SPAN = 0.55;

/** Floor the photo fades to — never fully gone while any of it is on screen. */
const FADE_FLOOR = 0.08;

/* ------------------------------------------------------------------ helpers */

/**
 * Re-alpha a palette colour so a gradient can fade a *token* out. Fading to the
 * literal `transparent` keyword goes through black on Android, which puts a
 * bruise across the middle of the scrim.
 */
function withAlpha(color: string, alpha: number): string {
  const parsed = /^rgba?\(([^)]+)\)$/i.exec(color);
  if (!parsed?.[1]) return color;
  const [r, g, b] = parsed[1].split(',');
  if (!r || !g || !b) return color;
  return `rgba(${r.trim()},${g.trim()},${b.trim()},${alpha})`;
}

function actionSkin(t: Theme, tone: PetHeroActionTone): { fill: string; ink: string } {
  switch (tone) {
    case 'accent':
      return { fill: t.color.accentSoft, ink: t.color.onAccentSoft };
    case 'success':
      return { fill: t.color.successSoft, ink: t.color.onSuccessSoft };
    case 'warning':
      return { fill: t.color.warningSoft, ink: t.color.onWarningSoft };
    case 'info':
      return { fill: t.color.infoSoft, ink: t.color.onInfoSoft };
    case 'neutral':
      return { fill: t.color.surfaceAlt, ink: t.color.textSecondary };
    case 'primary':
    default:
      return { fill: t.color.primarySoft, ink: t.color.onPrimarySoft };
  }
}

/** "Female · Neutered · Microchipped" — only the parts actually on file. */
function factLine(pet: Pet): string | null {
  const facts: string[] = [];
  if (pet.sex !== 'unknown') facts.push(pet.sex === 'male' ? 'Male' : 'Female');
  if (pet.neutered === true) facts.push('Neutered');
  if (pet.microchipId) facts.push('Microchipped');
  return facts.length > 0 ? facts.join(' · ') : null;
}

/* --------------------------------------------------------------- component */

export function PetHero({
  pet,
  scrollY,
  height,
  actions = [],
  membership,
  flags = [],
  onPhotoPress,
  style,
  testID,
}: PetHeroProps) {
  const t = useTheme();
  const { scrollY: hostScrollY, topInset } = useScreenScroll();
  const y = scrollY ?? hostScrollY;

  const identity = t.speciesColor(pet.species);
  const meta = SPECIES_META[pet.species];

  const photoHeight = height ?? t.spacing.colossal * 3 + t.spacing.xxl;
  const total = photoHeight + topInset;
  /** How far the plate rises into the photograph. */
  const overlap = t.spacing.xxxl;
  /** Hidden material above the photo, so an over-pull never exposes the ground. */
  const headroom = photoHeight;
  const reduce = t.reduceMotion;

  const fadeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      y.value,
      [0, total * FADE_SPAN],
      [1, FADE_FLOOR],
      Extrapolation.CLAMP,
    ),
  }));

  const photoStyle = useAnimatedStyle(() => {
    // Both halves are decorative, so reduced motion pins them rather than
    // branching the returned style — one shape keeps the worklet cheap.
    const pull = reduce ? 0 : Math.max(0, -y.value);
    const lag = reduce ? 0 : Math.max(0, y.value) * PARALLAX;
    return {
      transform: [
        { translateY: lag },
        // Grows about its centre, so twice the pull fills exactly the gap above.
        { scale: 1 + (pull * 2) / total },
      ],
    };
  });

  const topScrim: readonly [string, string] = [
    withAlpha(t.color.scrim, t.opacity.scrimLight),
    withAlpha(t.color.scrim, 0),
  ];
  const bottomScrim: readonly [string, string, string] = [
    withAlpha(t.color.scrim, 0),
    withAlpha(t.color.scrim, t.opacity.scrimLight),
    withAlpha(t.color.scrim, t.opacity.scrim),
  ];
  const wash: readonly [string, string] = [identity.tint, t.color.bg];

  const facts = factLine(pet);

  return (
    <View style={style} testID={testID}>
      {/* Clip box: reaches a full photo-height above itself so the elastic
          stretch has somewhere to come from. */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.clip,
          {
            top: -headroom,
            height: total + headroom,
            borderBottomLeftRadius: t.radius.xxxl,
            borderBottomRightRadius: t.radius.xxxl,
            backgroundColor: t.color.bgSunken,
          },
          fadeStyle,
        ]}
      >
        <Animated.View style={[styles.plate, { height: total }, photoStyle]}>
          <LinearGradient
            colors={wash}
            start={GRADIENT_TOP}
            end={GRADIENT_BOTTOM}
            style={StyleSheet.absoluteFill}
          />

          {pet.photoUrl ? (
            <Image
              source={{ uri: pet.photoUrl }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              contentPosition="center"
              cachePolicy="memory-disk"
              transition={t.motion.duration.slow}
              recyclingKey={pet.photoUrl}
              accessible={false}
            />
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.center, { paddingTop: topInset }]}>
              <View
                style={[
                  styles.center,
                  {
                    width: t.spacing.colossal,
                    height: t.spacing.colossal,
                    borderRadius: t.radius.pill,
                    backgroundColor: t.color.surface,
                  },
                ]}
              >
                <Text variant="hero" maxFontSizeMultiplier={1}>
                  {meta.emoji}
                </Text>
              </View>
            </View>
          )}
        </Animated.View>

        <LinearGradient
          colors={topScrim}
          start={GRADIENT_TOP}
          end={GRADIENT_BOTTOM}
          style={[
            styles.scrim,
            { top: headroom, height: topInset + t.minTarget + t.spacing.base },
          ]}
        />
        <LinearGradient
          colors={bottomScrim}
          locations={SCRIM_STOPS}
          start={GRADIENT_TOP}
          end={GRADIENT_BOTTOM}
          style={[styles.scrim, { bottom: 0, height: photoHeight * FADE_SPAN }]}
        />
      </Animated.View>

      {/* Reserves the photograph's space in the scroll flow. */}
      <View style={{ height: total - overlap }} pointerEvents="none" />

      {onPhotoPress ? (
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={`${possessive(pet.name)} photo`}
          accessibilityHint="Opens the photo editor"
          haptic="tap"
          onPress={onPhotoPress}
          // The parallax owns this area's transform; a press scale would fight it.
          pressScale={1}
          style={[
            styles.photoTarget,
            { top: topInset + t.minTarget, height: photoHeight - overlap - t.minTarget },
          ]}
        />
      ) : null}

      <Surface
        variant="surface"
        elevation={2}
        radius="xxl"
        padding="lg"
        style={{ marginHorizontal: t.gutter, gap: t.spacing.md }}
      >
        <Row gap="md" align="start">
          <Column flex gap="xxs">
            <Text variant="display" numberOfLines={2}>
              {pet.name}
            </Text>
            <Text variant="callout" color="textSecondary" numberOfLines={2}>
              {describePet(pet)}
            </Text>
            {facts ? (
              <Text variant="caption" color="textTertiary" numberOfLines={1}>
                {facts}
              </Text>
            ) : null}
          </Column>

          <View
            style={[
              styles.center,
              {
                width: t.spacing.huge,
                height: t.spacing.huge,
                borderRadius: t.radius.pill,
                backgroundColor: identity.tint,
                borderWidth: t.borderWidth.thin,
                borderColor: identity.base,
              },
            ]}
          >
            <Text variant="title2" maxFontSizeMultiplier={1.1}>
              {meta.emoji}
            </Text>
          </View>
        </Row>

        {membership && membership.role === 'caregiver' ? (
          <RoleBadge role="caregiver" size="sm" membership={membership} />
        ) : null}

        {flags.length > 0 ? (
          <Row gap="xs" wrap>
            {flags.map((flag) => (
              <PetStatusPill key={flag.id} chip={flag} />
            ))}
          </Row>
        ) : null}

        {actions.length > 0 ? (
          <>
            <Divider />
            <Row justify="around" align="start" gap="xs">
              {actions.map((action) => (
                <QuickAction key={action.id} action={action} />
              ))}
            </Row>
          </>
        ) : null}
      </Surface>
    </View>
  );
}

/* ------------------------------------------------------------ quick action */

function QuickAction({ action }: { action: PetHeroAction }) {
  const t = useTheme();
  const skin = actionSkin(t, action.tone ?? 'primary');
  const disc = t.spacing.huge;

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={action.label}
      accessibilityState={{ disabled: action.disabledReason !== undefined }}
      disabledReason={action.disabledReason}
      haptic="tap"
      onPress={action.onPress}
      pressScale="small"
      style={styles.action}
    >
      <Column align="center" gap="xs">
        <View
          style={[
            styles.center,
            {
              width: disc,
              height: disc,
              borderRadius: t.radius.pill,
              backgroundColor: skin.fill,
            },
          ]}
        >
          <Icon name={action.icon} size="md" color={skin.ink} />
        </View>
        <Text variant="caption" color="textSecondary" numberOfLines={1} align="center">
          {action.label}
        </Text>
      </Column>
    </Touchable>
  );
}

/* ----------------------------------------------------------- collapsed bar */

/**
 * The hero's compact form. Pass to `<Screen header={…}>`.
 *
 * It never calls `setHeaderHeight`, so the Screen leaves its content unpadded
 * and the photograph runs edge to edge behind the status bar.
 */
export function PetHeroBar({
  pet,
  revealAt,
  actions,
  onBack,
  scrollY,
  testID,
}: PetHeroBarProps) {
  const t = useTheme();
  const { scrollY: hostScrollY, topInset } = useScreenScroll();
  const y = scrollY ?? hostScrollY;

  const span = revealAt ?? t.spacing.colossal * 3 + t.spacing.xxl;
  const reduce = t.reduceMotion;

  const chromeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(y.value, [span * 0.4, span * 0.8], [0, 1], Extrapolation.CLAMP),
  }));

  const titleStyle = useAnimatedStyle(() => ({
    opacity: interpolate(y.value, [span * 0.55, span * 0.9], [0, 1], Extrapolation.CLAMP),
    transform: reduce
      ? []
      : [
          {
            translateY: interpolate(
              y.value,
              [span * 0.55, span * 0.9],
              [t.spacing.sm, 0],
              Extrapolation.CLAMP,
            ),
          },
        ],
  }));

  return (
    <View pointerEvents="box-none" style={{ paddingTop: topInset }} testID={testID}>
      <Animated.View
        pointerEvents="none"
        style={[styles.chrome, { height: topInset + t.minTarget }, chromeStyle]}
      >
        <BlurView
          intensity={t.scheme === 'dark' ? 40 : 28}
          tint={t.scheme === 'dark' ? 'dark' : 'light'}
          style={StyleSheet.absoluteFill}
        />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: t.color.chrome }]} />
        <View
          style={[
            styles.hairline,
            { height: t.borderWidth.hairline, backgroundColor: t.color.chromeBorder },
          ]}
        />
      </Animated.View>

      <Row
        justify="between"
        gap="xs"
        style={{ height: t.minTarget, paddingHorizontal: t.spacing.sm }}
      >
        <IconButton
          icon="chevron-back"
          accessibilityLabel="Go back"
          accessibilityHint={`Leaves ${possessive(pet.name)} profile`}
          variant="glass"
          tone="neutral"
          onPress={onBack}
        />
        <Row gap="xs" justify="end">
          {actions}
        </Row>
      </Row>

      <Animated.View
        pointerEvents="none"
        style={[
          styles.compactTitle,
          { top: topInset, height: t.minTarget, paddingHorizontal: t.minTarget + t.spacing.sm },
          titleStyle,
        ]}
        // The plate below carries the real heading; this is a scroll cue.
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Text variant="headline" numberOfLines={1} align="center">
          {pet.name}
        </Text>
      </Animated.View>
    </View>
  );
}

/* ------------------------------------------------------------------ statics */

const GRADIENT_TOP = { x: 0.5, y: 0 } as const;
const GRADIENT_BOTTOM = { x: 0.5, y: 1 } as const;
const SCRIM_STOPS = [0, 0.55, 1] as const;

const styles = StyleSheet.create({
  clip: { position: 'absolute', left: 0, right: 0, overflow: 'hidden' },
  plate: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  scrim: { position: 'absolute', left: 0, right: 0 },
  center: { alignItems: 'center', justifyContent: 'center' },
  action: { flex: 1 },
  photoTarget: { position: 'absolute', left: 0, right: 0 },
  chrome: { position: 'absolute', top: 0, left: 0, right: 0, overflow: 'hidden' },
  hairline: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  compactTitle: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default PetHero;
