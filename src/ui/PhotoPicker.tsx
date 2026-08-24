/**
 * Petal — PhotoPicker.
 *
 * The avatar control for pets and profiles. It does four things that a bare
 * `expo-image-picker` call doesn't:
 *
 *   · **The empty state is inviting, not empty.** A warm gradient disc that
 *     breathes, with a camera badge clipped to its edge — it looks like
 *     somewhere a photo belongs rather than a hole in the layout. (The breathing
 *     stops under reduced motion; it's decoration, not feedback.)
 *   · **Upload has a ring, not a spinner.** Determinate when the caller knows
 *     the progress, a sweeping arc when it doesn't, drawn in SVG around the
 *     photo's own edge so the eye never leaves the subject.
 *   · **A denied permission is a conversation, not a dead end.** Instead of the
 *     picker silently doing nothing, the sheet swaps to warm copy and a Settings
 *     shortcut — because on the second refusal the OS won't even ask again.
 *   · **Removal is offered where it's expected**, in the same sheet as the two
 *     ways to add one, in the destructive colour, last.
 *
 * The caller owns the upload; this owns the affordance. Pass `progress` while
 * you're uploading and `value` once you have a URL.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  FadeIn,
  ReduceMotion,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
  type WithSpringConfig,
} from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import * as Linking from 'expo-linking';

import haptics from '@/lib/haptics';
import { spring, useTheme } from '@/theme';
import { Button } from './Button';
import { FieldMessage, FieldSheet } from './FormField';
import { Icon, type IconName } from './Icon';
import { Column } from './Stack';
import { Text } from './Text';
import { Touchable } from './Touchable';

/* -------------------------------------------------------------------- types */

export type PhotoPickerShape = 'circle' | 'rounded';

export type PhotoPickerProps = {
  /** Current photo URI, or null for the empty state. */
  value: string | null;
  /** Fires with the picked local URI, or null when the photo is removed. */
  onChange: (uri: string | null) => void;
  /** 0–1 while the caller uploads. Omit for an indeterminate sweep. */
  progress?: number | null;
  uploading?: boolean;
  /** Diameter. Defaults to a comfortable profile-header size. */
  size?: number;
  shape?: PhotoPickerShape;
  /** What this photo is *of* — "Buddy's photo". Used in every announcement. */
  label?: string;
  /** Line under the control, e.g. "A clear head-on shot works best." */
  helper?: string;
  error?: string;
  /** Empty-state caption. */
  placeholderText?: string;
  /** JPEG quality, 0–1. */
  quality?: number;
  disabled?: boolean;
  disabledReason?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

type SheetView = 'actions' | 'camera-denied' | 'library-denied';

/* ---------------------------------------------------------------- constants */

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** See `Touchable` — the theme's `springWith` helper doesn't type-check yet. */
const RING_SPRING: WithSpringConfig = { ...spring.gentle, reduceMotion: ReduceMotion.System };

/** Fraction of the ring the indeterminate sweep occupies. */
const SWEEP = 0.28;

/** How far the resting placeholder breathes. Barely there, on purpose. */
const BREATH = 0.04;

const DENIAL_COPY: Record<'camera' | 'library', { title: string; body: string }> = {
  camera: {
    title: 'Furry Tracker can’t reach the camera yet',
    body: 'Your phone is holding the camera back. Turn it on in Settings and we’ll be ready when you are — or pick a photo you’ve already taken.',
  },
  library: {
    title: 'Furry Tracker can’t see your photos yet',
    body: 'Your phone is holding your library back. Turn on photo access in Settings, or take a fresh picture instead.',
  },
};

/* ------------------------------------------------------------------ progress */

function ProgressRing({
  diameter,
  stroke,
  color,
  track,
  progress,
  indeterminate,
}: {
  diameter: number;
  stroke: number;
  color: string;
  track: string;
  progress: number | null;
  indeterminate: boolean;
}) {
  const t = useTheme();
  const radius = (diameter - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  const value = useSharedValue(progress ?? 0);
  const spin = useSharedValue(0);

  useEffect(() => {
    value.value = withSpring(progress ?? 0, RING_SPRING);
  }, [progress, value]);

  useEffect(() => {
    if (!indeterminate) {
      cancelAnimation(spin);
      spin.value = 0;
      return;
    }
    spin.value = withRepeat(
      withTiming(1, t.motion.timing(t.motion.duration.shimmer, 'linear')),
      -1,
      false,
    );
    return () => cancelAnimation(spin);
  }, [indeterminate, spin, t.motion]);

  const arcProps = useAnimatedProps(() => ({
    strokeDashoffset: indeterminate ? circumference * (1 - SWEEP) : circumference * (1 - value.value),
  }));

  const spinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spin.value * 360}deg` }],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.center, indeterminate ? spinStyle : null]}
    >
      <Svg width={diameter} height={diameter}>
        <Circle
          cx={diameter / 2}
          cy={diameter / 2}
          r={radius}
          stroke={track}
          strokeWidth={stroke}
          fill="none"
        />
        <AnimatedCircle
          cx={diameter / 2}
          cy={diameter / 2}
          r={radius}
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={circumference}
          // Start the arc at twelve o'clock rather than three.
          rotation={-90}
          originX={diameter / 2}
          originY={diameter / 2}
          animatedProps={arcProps}
        />
      </Svg>
    </Animated.View>
  );
}

/* --------------------------------------------------------------- empty state */

function Placeholder({ diameter, radius, text }: { diameter: number; radius: number; text: string }) {
  const t = useTheme();
  const breath = useSharedValue(0);

  useEffect(() => {
    if (t.reduceMotion) {
      breath.value = 0;
      return;
    }
    breath.value = withRepeat(
      withTiming(1, {
        duration: t.motion.duration.ambient,
        easing: t.motion.easing.smooth,
        reduceMotion: ReduceMotion.System,
      }),
      -1,
      true,
    );
    return () => cancelAnimation(breath);
  }, [breath, t.motion, t.reduceMotion]);

  const breatheStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + breath.value * BREATH }],
  }));

  const wash: readonly [string, string] = [t.color.primarySoft, t.color.accentSoft];

  return (
    <View style={[StyleSheet.absoluteFill, styles.center]}>
      <LinearGradient
        colors={wash}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[StyleSheet.absoluteFill, { borderRadius: radius }]}
      />
      <Animated.View style={[styles.center, breatheStyle]}>
        <Icon name="camera-outline" size={diameter > t.spacing.colossal ? 'xxl' : 'lg'} color="primaryText" />
        {diameter > t.spacing.colossal ? (
          <Text variant="caption" color="onPrimarySoft" align="center" style={{ paddingTop: t.spacing.xs }}>
            {text}
          </Text>
        ) : null}
      </Animated.View>
    </View>
  );
}

/* ---------------------------------------------------------------- component */

export function PhotoPicker({
  value,
  onChange,
  progress = null,
  uploading = false,
  size,
  shape = 'circle',
  label = 'Photo',
  helper,
  error,
  placeholderText = 'Add a photo',
  quality = 0.8,
  disabled = false,
  disabledReason,
  style,
  testID,
}: PhotoPickerProps) {
  const t = useTheme();
  const [sheet, setSheet] = useState(false);
  const [view, setView] = useState<SheetView>('actions');
  const [busy, setBusy] = useState(false);

  const diameter = size ?? t.spacing.colossal + t.spacing.xxl;
  const radius = shape === 'circle' ? t.radius.pill : t.radius.xxl;
  const badge = t.spacing.xxl;
  const inert = disabled || disabledReason !== undefined;

  const open = useCallback(() => {
    haptics.tap();
    setView('actions');
    setSheet(true);
  }, []);

  const close = useCallback(() => setSheet(false), []);

  const pick = useCallback(
    async (source: 'camera' | 'library') => {
      setBusy(true);
      try {
        const permission =
          source === 'camera'
            ? await ImagePicker.requestCameraPermissionsAsync()
            : await ImagePicker.requestMediaLibraryPermissionsAsync();

        if (!permission.granted) {
          haptics.warn();
          setView(source === 'camera' ? 'camera-denied' : 'library-denied');
          return;
        }

        const options: ImagePicker.ImagePickerOptions = {
          mediaTypes: ['images'],
          // Square crop: every avatar in the app is a disc, so cropping here
          // beats letting the layout decide which half of a face to show.
          allowsEditing: true,
          aspect: [1, 1],
          quality,
        };

        const result =
          source === 'camera'
            ? await ImagePicker.launchCameraAsync(options)
            : await ImagePicker.launchImageLibraryAsync(options);

        if (result.canceled) return;
        const asset = result.assets[0];
        if (!asset) return;

        haptics.success();
        onChange(asset.uri);
        setSheet(false);
      } finally {
        setBusy(false);
      }
    },
    [onChange, quality],
  );

  const remove = useCallback(() => {
    haptics.commit();
    onChange(null);
    setSheet(false);
  }, [onChange]);

  const openSettings = useCallback(() => {
    void Linking.openSettings();
    setSheet(false);
  }, []);

  const indeterminate = uploading && (progress === null || progress === undefined);
  const showRing = uploading || (progress !== null && progress !== undefined && progress < 1);

  const denial = view === 'camera-denied' ? DENIAL_COPY.camera : DENIAL_COPY.library;

  return (
    <View style={style} testID={testID}>
      <View style={styles.center}>
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={value ? `Change ${label.toLowerCase()}` : `Add ${label.toLowerCase()}`}
          accessibilityHint={helper}
          accessibilityState={{ disabled, busy: uploading }}
          disabled={disabled}
          disabledReason={disabledReason}
          haptic="none"
          onPress={open}
          pressScale="large"
          style={{ opacity: inert ? t.opacity.disabled : 1 }}
        >
          <View style={{ width: diameter, height: diameter }}>
            <View
              style={[
                styles.clip,
                t.elevation(2),
                {
                  width: diameter,
                  height: diameter,
                  borderRadius: radius,
                  backgroundColor: t.color.surfaceAlt,
                  borderWidth: t.borderWidth.thin,
                  borderColor: t.color.border,
                },
              ]}
            >
              {value ? (
                <Animated.View entering={FadeIn.duration(t.motion.duration.base)} style={StyleSheet.absoluteFill}>
                  <Image
                    source={{ uri: value }}
                    style={StyleSheet.absoluteFill}
                    contentFit="cover"
                    transition={t.motion.duration.base}
                    accessibilityIgnoresInvertColors
                  />
                </Animated.View>
              ) : (
                <Placeholder diameter={diameter} radius={radius} text={placeholderText} />
              )}
            </View>

            {showRing ? (
              <ProgressRing
                diameter={diameter}
                stroke={t.borderWidth.focus + t.borderWidth.hairline}
                color={t.color.primary}
                track={t.color.border}
                progress={progress ?? null}
                indeterminate={indeterminate}
              />
            ) : null}

            {!inert ? (
              <View
                pointerEvents="none"
                style={[
                  styles.badge,
                  styles.center,
                  t.elevation(2),
                  {
                    width: badge,
                    height: badge,
                    borderRadius: t.radius.pill,
                    backgroundColor: t.color.primary,
                    borderWidth: t.borderWidth.thick,
                    borderColor: t.color.bg,
                  },
                ]}
              >
                <Icon name={value ? 'pencil' : 'camera'} size="xs" color={t.color.onPrimary} />
              </View>
            ) : null}
          </View>
        </Touchable>
      </View>

      {/* Full width, not centred: the message row measures its children, and a
          centring parent would collapse it to nothing. */}
      <FieldMessage helper={helper} error={error} />

      <FieldSheet
        visible={sheet}
        onRequestClose={close}
        title={view === 'actions' ? label : denial.title}
        subtitle={view === 'actions' ? undefined : denial.body}
      >
        {view === 'actions' ? (
          <Column gap="sm">
            <SheetAction
              icon="camera-outline"
              label="Take a photo"
              hint="Uses the camera and crops it square"
              busy={busy}
              onPress={() => void pick('camera')}
            />
            <SheetAction
              icon="images-outline"
              label="Choose from library"
              hint="Pick one you’ve already taken"
              busy={busy}
              onPress={() => void pick('library')}
            />
            {value ? (
              <SheetAction
                icon="trash-outline"
                label={`Remove ${label.toLowerCase()}`}
                destructive
                busy={busy}
                onPress={remove}
              />
            ) : null}
          </Column>
        ) : (
          <Column gap="md">
            <Button label="Open Settings" variant="primary" fullWidth onPress={openSettings} />
            <Button
              label={view === 'camera-denied' ? 'Choose from library instead' : 'Take a photo instead'}
              variant="secondary"
              fullWidth
              onPress={() => void pick(view === 'camera-denied' ? 'library' : 'camera')}
            />
          </Column>
        )}
      </FieldSheet>
    </View>
  );
}

/* ----------------------------------------------------------------- sheet row */

function SheetAction({
  icon,
  label,
  hint,
  destructive = false,
  busy,
  onPress,
}: {
  icon: IconName;
  label: string;
  hint?: string;
  destructive?: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const disc = t.spacing.xxxl;

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={hint ? `${label}. ${hint}` : label}
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      haptic="tap"
      onPress={onPress}
      pressScale="large"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.spacing.md,
        paddingVertical: t.spacing.md,
        paddingHorizontal: t.spacing.md,
        borderRadius: t.radius.lg,
        backgroundColor: t.color.surfaceAlt,
      }}
    >
      <View
        style={[
          styles.center,
          {
            width: disc,
            height: disc,
            borderRadius: t.radius.pill,
            backgroundColor: destructive ? t.color.dangerSoft : t.color.primarySoft,
          },
        ]}
      >
        <Icon name={icon} size="md" color={destructive ? 'onDangerSoft' : 'onPrimarySoft'} />
      </View>
      <Column flex gap="hair">
        <Text variant="bodyStrong" color={destructive ? 'onDangerSoft' : 'text'}>
          {label}
        </Text>
        {hint ? (
          <Text variant="footnote" color="textTertiary">
            {hint}
          </Text>
        ) : null}
      </Column>
      <Icon name="chevron-forward" size="sm" color="textFaint" />
    </Touchable>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  clip: { overflow: 'hidden' },
  badge: { position: 'absolute', right: 0, bottom: 0 },
});

export default PhotoPicker;
