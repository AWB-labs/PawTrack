/**
 * Lock — biometric re-entry.
 *
 * This is a *route*, not a modal, because the alternative is rendering a pet's
 * medication schedule underneath a sheet where the app switcher's screenshot can
 * find it. The router's `locked` branch mounts nothing else.
 *
 * The behaviour that matters:
 *
 *   · **It asks immediately.** Nobody comes to this screen wanting to read it —
 *     they want to be past it. The sheet is raised once on mount, and the manual
 *     button exists for the second attempt, not the first.
 *   · **Every outcome gets its own sentence.** A cancel is not a failure, a
 *     mismatch is not a lockout, and a lockout is not something a retry button
 *     can fix. Rendering `result.message` for all four would be the lazy version
 *     of honest.
 *   · **There is always a way in.** "Use my password instead" signs out to the
 *     sign-in screen — a longer road, never a locked door. Being shut out of
 *     your own dog's dosing schedule because a sensor misfired is a worse
 *     outcome than anything this lock protects against.
 *
 * The success beat plays during the route's own cross-fade: the store flips
 * `status` the instant the sensor agrees, and the native stack keeps this screen
 * mounted while it fades, which is exactly long enough for the check to land.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, {
  FadeIn,
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
  type SharedValue,
  type WithSpringConfig,
} from 'react-native-reanimated';

import { AuthAtmosphere } from '@/features/auth/AuthScaffold';
import biometrics, { type BiometricAvailability, type BiometricFailure } from '@/lib/biometrics';
import haptics from '@/lib/haptics';
import { useSession } from '@/stores/session';
import { spring, useTheme } from '@/theme';
import { Avatar, Button, Column, Icon, LoadingDots, Row, Screen, Text, type IconName } from '@/ui';
import { PermissionLocked } from '@/ui/illustrations';

/* -------------------------------------------------------------------- types */

type Phase = 'checking' | 'idle' | 'prompting' | 'denied' | 'success';

type Denial = {
  title: string;
  body: string;
  /** False when trying the sensor again genuinely cannot work. */
  canRetry: boolean;
  /** Warning tone for a real refusal; info for a deliberate cancel. */
  tone: 'info' | 'warning';
};

/* ---------------------------------------------------------------- constants */

/** See `Touchable` — the theme's `springWith` helper doesn't type-check yet. */
const SUCCESS_SPRING: WithSpringConfig = { ...spring.bouncy, reduceMotion: ReduceMotion.System };

/** How far the lock scene breathes while the sensor is listening. */
const BREATH = 0.05;

/**
 * Screen-specific copy. `lib/biometrics` returns a message tuned for a settings
 * row; here the user is standing in front of a closed door, and the difference
 * between "have another go" and "your phone has paused this" decides whether
 * they tap retry or reach for their password.
 */
function denialFor(reason: BiometricFailure, message: string, label: string): Denial {
  switch (reason) {
    case 'cancelled':
      return {
        title: 'No rush',
        body: `Tap unlock whenever you’re ready — ${label} is still armed and nothing has moved.`,
        canRetry: true,
        tone: 'info',
      };
    case 'fallback':
      return {
        title: 'Rather use your password?',
        body: 'Sign back in with your Furry Tracker password and we’ll leave the sensor out of it this time.',
        canRetry: true,
        tone: 'info',
      };
    case 'failed':
      return {
        title: 'That wasn’t quite a match',
        body: `Have another go — ${label} sometimes needs a second look. Your password works too.`,
        canRetry: true,
        tone: 'warning',
      };
    case 'lockout':
      return {
        title: `Your phone has paused ${label}`,
        body: 'Too many attempts in a row. Unlock your phone with its passcode to reset it, or sign in with your Furry Tracker password.',
        canRetry: false,
        tone: 'warning',
      };
    default:
      return {
        title: `${label} isn’t answering`,
        body: message || 'Something interrupted the check. Your Furry Tracker password will get you straight in.',
        canRetry: false,
        tone: 'warning',
      };
  }
}

/* ----------------------------------------------------------------- success */

/** The one beat between the sensor agreeing and the app appearing. */
function SuccessBloom({ progress }: { progress: SharedValue<number> }) {
  const t = useTheme();
  const disc = t.spacing.colossal;

  const bloomStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: 0.6 + progress.value * 0.4 }],
  }));

  const ringStyle = useAnimatedStyle(() => ({
    opacity: (1 - progress.value) * 0.5,
    transform: [{ scale: 0.8 + progress.value * 1.4 }],
  }));

  return (
    <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
      <Animated.View
        style={[
          styles.center,
          {
            position: 'absolute',
            width: disc,
            height: disc,
            borderRadius: disc / 2,
            borderWidth: t.borderWidth.thick,
            borderColor: t.color.primary,
          },
          ringStyle,
        ]}
      />
      <Animated.View
        style={[
          styles.center,
          t.glow(t.color.primary),
          {
            width: disc,
            height: disc,
            borderRadius: disc / 2,
            backgroundColor: t.color.primary,
          },
          bloomStyle,
        ]}
      >
        <Icon name="checkmark" size="xxl" color={t.color.onPrimary} />
      </Animated.View>
    </View>
  );
}

/* -------------------------------------------------------------------- screen */

export default function LockScreen() {
  const t = useTheme();
  const { width } = useWindowDimensions();

  const unlock = useSession((s) => s.unlock);
  const signOut = useSession((s) => s.signOut);
  const pending = useSession((s) => s.pending);
  const lastKnown = useSession((s) => s.lastKnown);

  const [sensor, setSensor] = useState<BiometricAvailability | null>(null);
  const [phase, setPhase] = useState<Phase>('checking');
  const [denial, setDenial] = useState<Denial | null>(null);

  const asked = useRef(false);
  const breath = useSharedValue(0);
  const success = useSharedValue(0);

  const label = sensor?.label ?? 'Face ID';
  const glyph = (sensor?.icon ?? 'lock-closed-outline') as IconName;
  const name = lastKnown?.displayName.trim().split(/\s+/)[0] ?? null;

  /* --------------------------------------------------------------- sensing */

  const prompt = useCallback(async () => {
    setPhase('prompting');
    setDenial(null);

    const result = await unlock({ reason: 'Unlock your pets’ records' });

    if (result.ok) {
      haptics.success();
      setPhase('success');
      success.value = withSpring(1, SUCCESS_SPRING);
      return;
    }

    haptics.warn();
    setDenial(denialFor(result.reason, result.message, sensor?.label ?? 'Biometric unlock'));
    setPhase('denied');
  }, [sensor, success, unlock]);

  useEffect(() => {
    let alive = true;
    void biometrics.isAvailable().then((available) => {
      if (!alive) return;
      setSensor(available);
      setPhase('idle');
    });
    return () => {
      alive = false;
      // An Android prompt outlives the screen that raised it unless it's told.
      void biometrics.cancel();
    };
  }, []);

  useEffect(() => {
    // Once, and only after the capability read has landed, so the prompt's
    // fallback label is right the first time.
    if (phase !== 'idle' || asked.current) return;
    asked.current = true;
    void prompt();
  }, [phase, prompt]);

  /* ---------------------------------------------------------------- motion */

  useEffect(() => {
    const listening = phase === 'prompting';
    if (t.reduceMotion || !listening) {
      cancelAnimation(breath);
      breath.value = withTiming(0, t.motion.timing(t.motion.duration.base, 'smooth'));
      return;
    }
    breath.value = withRepeat(
      withTiming(1, {
        duration: t.motion.duration.ambient / 2,
        easing: t.motion.easing.smooth,
        reduceMotion: ReduceMotion.System,
      }),
      -1,
      true,
    );
    return () => cancelAnimation(breath);
  }, [breath, phase, t.motion, t.reduceMotion]);

  const sceneStyle = useAnimatedStyle(() => ({
    opacity: 1 - success.value * 0.85,
    transform: [{ scale: (1 + breath.value * BREATH) * (1 - success.value * 0.12) }],
  }));

  /* --------------------------------------------------------------- actions */

  const usePassword = useCallback(() => {
    haptics.commit();
    // Signing out drops the locked session; the router's guard lands on
    // sign-in on its own, so there is no navigation call to race with it.
    void signOut();
  }, [signOut]);

  const busy = phase === 'prompting' || phase === 'checking' || pending === 'unlock';
  // Hero-sized, but it yields to the copy first: at 2× text the scene shrinks
  // rather than pushing the unlock button off a small phone.
  const art = Math.min(width * 0.62, t.spacing.colossal * 3) / (t.isLargeText ? 1.3 : 1);

  return (
    <View style={[styles.flex, { backgroundColor: t.color.bg }]}>
      <AuthAtmosphere intensity={0.75} />

      <Screen scroll background="transparent" keyboardAvoiding={false} testID="lock">
        <Column flex justify="center" align="center" gap="xl">
          <Animated.View entering={FadeIn.duration(t.motion.duration.slow)} style={styles.center}>
            <Column align="center" gap="md">
              <Avatar
                uri={lastKnown?.avatarUrl ?? null}
                name={lastKnown?.displayName ?? null}
                size="lg"
                ring
                fallbackIcon="person"
                accessibilityLabel={name ? `${name}’s account` : 'Your account'}
              />
              <Text variant="title1" align="center" accessibilityRole="header">
                {name ? `Welcome back, ${name}` : 'Welcome back'}
              </Text>
            </Column>
          </Animated.View>

          <View style={styles.center}>
            <Animated.View style={sceneStyle}>
              <PermissionLocked size={art} />
            </Animated.View>
            {phase === 'success' ? <SuccessBloom progress={success} /> : null}
          </View>

          {/* Keyed so a new outcome cross-fades rather than swapping mid-word. */}
          <Animated.View
            key={phase === 'denied' ? (denial?.title ?? 'denied') : phase}
            entering={FadeIn.duration(t.motion.duration.base)}
            style={{ paddingHorizontal: t.spacing.md }}
          >
            {phase === 'success' ? (
              <Text variant="callout" color="primaryText" align="center">
                Unlocked — everyone’s waiting.
              </Text>
            ) : phase === 'denied' && denial ? (
              <Column gap="xs" align="center">
                <Text
                  variant="bodyStrong"
                  color={denial.tone === 'warning' ? 'onWarningSoft' : 'text'}
                  align="center"
                >
                  {denial.title}
                </Text>
                <Text variant="footnote" color="textSecondary" align="center">
                  {denial.body}
                </Text>
              </Column>
            ) : phase === 'prompting' || phase === 'checking' ? (
              <Row gap="sm" justify="center">
                <LoadingDots size="sm" color="textTertiary" />
                <Text variant="callout" color="textSecondary">
                  Looking for you…
                </Text>
              </Row>
            ) : (
              <Text variant="callout" color="textSecondary" align="center">
                Your pets’ records are private on this phone. {label} opens them.
              </Text>
            )}
          </Animated.View>
        </Column>

        <Column gap="sm" style={{ paddingBottom: t.spacing.base }}>
          {phase !== 'success' && (denial?.canRetry ?? true) ? (
            <Button
              label={phase === 'denied' ? `Try ${label} again` : `Unlock with ${label}`}
              onPress={() => void prompt()}
              leftIcon={glyph}
              loading={busy}
              size="lg"
              hero
              fullWidth
              haptic="commit"
              accessibilityHint="Raises your phone’s unlock prompt."
              testID="lock-unlock"
            />
          ) : null}

          <Button
            label="Use my password instead"
            onPress={usePassword}
            variant={denial && !denial.canRetry ? 'secondary' : 'ghost'}
            size="md"
            fullWidth
            loading={pending === 'signOut'}
            disabled={phase === 'success'}
            accessibilityHint="Signs you out so you can sign back in with your Furry Tracker password."
            testID="lock-password"
          />
        </Column>
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
});
