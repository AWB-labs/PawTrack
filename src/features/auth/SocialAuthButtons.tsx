/**
 * Petal — social sign-in.
 *
 * Two buttons with one rule each:
 *
 *   · **Apple's button is Apple's button.** It only appears where Sign in with
 *     Apple genuinely exists (`isAvailableAsync`, which is false on Android and
 *     on older iOS), it fills black on a light ground and white on a dark one as
 *     the Human Interface Guidelines require, and its label starts with
 *     "Continue with" rather than a verb of our own invention. We draw it rather
 *     than mounting `AppleAuthenticationButton` for one concrete reason: the
 *     native button cannot show a loading state, and a provider handshake that
 *     leaves the user tapping a dead control is worse than a slightly bespoke
 *     corner radius.
 *   · **Loading is per button.** Whichever provider is mid-handshake shows its
 *     own dots; the other goes inert rather than pretending it's still an
 *     option. Both keep their label mounted so nothing reflows mid-tap.
 */

import React, { useEffect, useState } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import type { OAuthProvider } from '@/data/adapter';
import { useTheme } from '@/theme';
import { Icon, LoadingDots, Row, Text, Touchable, type IconName } from '@/ui';

/* -------------------------------------------------------------------- types */

export type SocialAuthButtonsProps = {
  onSelect: (provider: OAuthProvider) => void;
  /** Which provider is mid-handshake. The other button goes inert. */
  pending?: OAuthProvider | null;
  /** Blocks both — e.g. while the email form is submitting. */
  disabled?: boolean;
  /** Verb the labels open with. Apple's own guidance prefers "Continue with". */
  verb?: string;
  /** Rule-and-label above the buttons. Pass `null` to drop it. */
  separator?: string | null;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

type SocialButtonProps = {
  provider: OAuthProvider;
  label: string;
  icon: IconName;
  background: string;
  ink: string;
  border: string | null;
  loading: boolean;
  inert: boolean;
  onPress: () => void;
};

/* ------------------------------------------------------------------- hooks */

/**
 * True only where the OS can actually complete the flow. Checked rather than
 * inferred from `Platform.OS` because iPads running older iOS, and the
 * simulator without an iCloud account, both report unavailable — and a button
 * that opens nothing is the worst kind of dead end.
 */
export function useAppleSignInAvailable(): boolean {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let alive = true;
    AppleAuthentication.isAvailableAsync()
      .then((ok) => {
        if (alive) setAvailable(ok);
      })
      .catch(() => {
        /* treat an unreadable capability as "not offered" */
      });
    return () => {
      alive = false;
    };
  }, []);

  return available;
}

/* --------------------------------------------------------------- component */

function SocialButton({
  provider,
  label,
  icon,
  background,
  ink,
  border,
  loading,
  inert,
  onPress,
}: SocialButtonProps) {
  const t = useTheme();

  const busy = useSharedValue(loading ? 1 : 0);
  useEffect(() => {
    busy.value = withTiming(loading ? 1 : 0, t.motion.timing(t.motion.duration.fast, 'smooth'));
  }, [busy, loading, t.motion]);

  const labelStyle = useAnimatedStyle(() => ({ opacity: 1 - busy.value }));
  const dotsStyle = useAnimatedStyle(() => ({ opacity: busy.value }));

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inert, busy: loading }}
      disabled={inert}
      haptic="tap"
      onPress={loading ? undefined : onPress}
      pressScale="medium"
      testID={`social-${provider}`}
      style={[
        t.elevation(0),
        styles.button,
        {
          backgroundColor: background,
          borderRadius: t.radius.lg,
          paddingVertical: t.spacing.md,
          paddingHorizontal: t.spacing.lg,
          borderWidth: border ? t.borderWidth.hairline : 0,
          borderColor: border ?? undefined,
        },
      ]}
    >
      <Animated.View style={[styles.content, { gap: t.spacing.sm }, labelStyle]}>
        <Icon name={icon} size="md" color={ink} />
        <Text variant="button" color={ink} numberOfLines={1}>
          {label}
        </Text>
      </Animated.View>

      <Animated.View
        style={[StyleSheet.absoluteFill, styles.content, dotsStyle]}
        pointerEvents="none"
        importantForAccessibility="no-hide-descendants"
      >
        <LoadingDots color={ink} active={loading} />
      </Animated.View>
    </Touchable>
  );
}

export function SocialAuthButtons({
  onSelect,
  pending = null,
  disabled = false,
  verb = 'Continue',
  separator = 'or',
  style,
  testID,
}: SocialAuthButtonsProps) {
  const t = useTheme();
  const appleAvailable = useAppleSignInAvailable();

  const busy = pending !== null;

  return (
    <View style={[{ gap: t.spacing.md }, style]} testID={testID}>
      {separator ? (
        <Row gap="md" style={{ paddingVertical: t.spacing.xs }}>
          <View style={[styles.rule, { height: t.borderWidth.hairline, backgroundColor: t.color.divider }]} />
          <Text variant="caption" color="textTertiary">
            {separator}
          </Text>
          <View style={[styles.rule, { height: t.borderWidth.hairline, backgroundColor: t.color.divider }]} />
        </Row>
      ) : null}

      {appleAvailable ? (
        // `text` on `textInverse` is near-black-on-white in light and
        // near-white-on-black in dark — which is exactly Apple's rule, expressed
        // in tokens so it also survives a palette retune.
        <SocialButton
          provider="apple"
          label={`${verb} with Apple`}
          icon="logo-apple"
          background={t.color.text}
          ink={t.color.textInverse}
          border={null}
          loading={pending === 'apple'}
          inert={disabled || (busy && pending !== 'apple')}
          onPress={() => onSelect('apple')}
        />
      ) : null}

      <SocialButton
        provider="google"
        label={`${verb} with Google`}
        icon="logo-google"
        background={t.color.surface}
        ink={t.color.text}
        border={t.color.borderStrong}
        loading={pending === 'google'}
        inert={disabled || (busy && pending !== 'google')}
        onPress={() => onSelect('google')}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  button: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  content: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  rule: { flex: 1 },
});

export default SocialAuthButtons;
