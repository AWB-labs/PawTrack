/**
 * Settings — Security.
 *
 * The single worst settings screen in the world is a toggle greyed out with no
 * reason given, so this one refuses to do that. `biometrics.isAvailable()`
 * reports hardware and enrolment separately on purpose, and the two failures get
 * different treatment because they *are* different: "this phone has no sensor"
 * is a dead end and gets a plain sentence; "you haven't set Face ID up yet" is a
 * two-tap fix and gets a button to the place that fixes it.
 *
 * Three more decisions:
 *
 *   · **Turning the lock on proves itself first.** We prompt before writing the
 *     preference, so nobody arms a lock that turns out not to work and finds out
 *     at the worst moment.
 *   · **Turning it off asks too.** A lock that anyone holding your unlocked
 *     phone can switch off in two taps isn't a lock. The passcode fallback stays
 *     enabled, so a misfiring sensor can never strand you.
 *   · **The delay picker stops where the guarantee stops.** The session store
 *     re-locks after a minute away; offering "after five minutes" would be
 *     writing a cheque the app can't cash.
 */

import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut } from 'react-native-reanimated';

import { SettingsGroup } from '@/features/settings/SettingsGroup';
import { SettingsRow } from '@/features/settings/SettingsRow';
import {
  AUTO_LOCK_OPTIONS,
  MAX_AUTO_LOCK_MS,
  describeAutoLock,
  useAppSettings,
} from '@/features/settings/appSettings';
import biometrics, { type BiometricAvailability, type BiometricKind } from '@/lib/biometrics';
import { openAppSettings } from '@/lib/deeplinks';
import haptics from '@/lib/haptics';
import { usePreferences } from '@/stores/preferences';
import { useCurrentUser, useSession } from '@/stores/session';
import { useTheme } from '@/theme';
import {
  Banner,
  Column,
  ConfirmSheet,
  Icon,
  Row,
  Screen,
  ScreenHeader,
  SegmentedControl,
  Skeleton,
  SkeletonGroup,
  Surface,
  Text,
  toast,
  useSheet,
  type IconName,
  type Segment,
} from '@/ui';

/* ---------------------------------------------------------------- constants */

/** `availability.icon` is a plain string; the row needs a typed glyph name. */
const KIND_ICON: Record<BiometricKind, IconName> = {
  faceId: 'scan-outline',
  touchId: 'finger-print-outline',
  faceUnlock: 'scan-outline',
  fingerprint: 'finger-print-outline',
  iris: 'eye-outline',
  passcode: 'keypad-outline',
  none: 'lock-closed-outline',
};

/** Four segments need four short labels; the full ones live on the option. */
const SHORT_DELAY: Record<number, string> = {
  0: 'Now',
  15_000: '15s',
  30_000: '30s',
  60_000: '1 min',
};

const DELAY_SEGMENTS: Segment<number>[] = AUTO_LOCK_OPTIONS.map((option) => ({
  value: option.ms,
  label: SHORT_DELAY[option.ms] ?? option.label,
  accessibilityLabel: option.label,
}));

/* ---------------------------------------------------------------- component */

export default function SecuritySettingsScreen() {
  const t = useTheme();

  const user = useCurrentUser();
  const signOut = useSession((s) => s.signOut);
  const lock = useSession((s) => s.lock);
  const signOutSheet = useSheet();

  const biometricLock = usePreferences((s) => s.biometricLock);
  const setBiometricLock = usePreferences((s) => s.setBiometricLock);
  const autoLockAfterMs = useAppSettings((s) => s.autoLockAfterMs);
  const setAutoLockAfterMs = useAppSettings((s) => s.setAutoLockAfterMs);

  const [availability, setAvailability] = useState<BiometricAvailability | null>(null);
  const [working, setWorking] = useState(false);

  /* ---- what this phone can do ------------------------------------------ */

  const read = useCallback(async () => {
    setAvailability(await biometrics.isAvailable());
  }, []);

  useFocusEffect(
    useCallback(() => {
      void read();
    }, [read]),
  );

  // Enrolment can appear while Petal is in the background — someone taps "Open
  // phone settings", adds a fingerprint, and comes straight back. There's no
  // cache behind `isAvailable()`, so re-reading on foreground is always honest.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void read();
    });
    return () => subscription.remove();
  }, [read]);

  /* ---- arming and disarming -------------------------------------------- */

  const setLock = useCallback(
    async (next: boolean) => {
      if (working || !availability?.available) return;
      setWorking(true);
      try {
        const result = await biometrics.authenticate({
          reason: next
            ? 'Confirm it’s you, then Petal will ask for this every time'
            : 'Confirm it’s you before turning the lock off',
          cancelLabel: 'Not now',
        });

        if (!result.ok) {
          // A deliberate cancel carries no message on purpose — answering it
          // with an error toast is the app arguing with the user.
          if (result.message) {
            haptics.error();
            toast.error(result.message);
          }
          return;
        }

        setBiometricLock(next);
        haptics.success();
        toast.success(next ? `${availability.label} it is 🔒` : 'Lock turned off', {
          description: next
            ? `Petal will ask for ${availability.label} whenever you’ve been away for a moment.`
            : 'Petal opens straight to your pets from now on.',
        });
      } finally {
        setWorking(false);
      }
    },
    [availability, setBiometricLock, working],
  );

  const lockNow = useCallback(() => {
    haptics.commit();
    lock();
  }, [lock]);

  const chooseDelay = useCallback(
    (ms: number) => {
      setAutoLockAfterMs(ms);
    },
    [setAutoLockAfterMs],
  );

  /* ---- derived ---------------------------------------------------------- */

  const delayHint = useMemo(
    () =>
      AUTO_LOCK_OPTIONS.find((option) => option.ms === autoLockAfterMs)?.hint ??
      'Petal re-locks after a minute away.',
    [autoLockAfterMs],
  );

  const unavailableAction = useMemo(() => {
    if (!availability || availability.available) return null;
    // No hardware is a dead end; anything else is a trip to the OS settings.
    return availability.reason === 'no-hardware' ? null : 'openSettings';
  }, [availability]);

  const enter = useCallback(
    (index: number) =>
      t.reduceMotion
        ? FadeIn.duration(t.motion.duration.base).delay(index * t.motion.stagger.tight)
        : FadeInDown.duration(t.motion.duration.slow)
            .delay(index * t.motion.stagger.base)
            .easing(t.motion.easing.decelerate),
    [t.motion, t.reduceMotion],
  );

  const header = (
    <ScreenHeader
      title="Security"
      subtitle="Petal holds vaccination records, medication schedules and vet letters. Here’s who gets to see them."
    />
  );

  /* ---- states ----------------------------------------------------------- */

  if (!availability) {
    return (
      <Screen header={header} scroll contentContainerStyle={{ gap: t.spacing.xl }}>
        <LockSkeleton />
      </Screen>
    );
  }

  const available = availability.available;

  return (
    <Screen
      header={header}
      scroll
      contentContainerStyle={{ gap: t.spacing.xl, paddingBottom: t.spacing.xxl }}
    >
      {!available ? (
        <Animated.View entering={FadeIn.duration(t.motion.duration.base)}>
          <Banner
            tone="warning"
            icon={availability.reason === 'no-hardware' ? 'hardware-chip-outline' : 'key-outline'}
            title={
              availability.reason === 'no-hardware'
                ? 'This phone can’t do the lock'
                : availability.reason === 'device-not-secured'
                  ? 'Your phone has no screen lock yet'
                  : `${availability.label} isn’t set up yet`
            }
            message={availability.explanation ?? 'Petal can’t lock itself on this device.'}
            action={
              unavailableAction
                ? {
                    label: 'Open phone settings',
                    icon: 'settings-outline',
                    onPress: () => void openAppSettings(),
                  }
                : undefined
            }
          />
        </Animated.View>
      ) : null}

      <Animated.View entering={enter(0)}>
        <SettingsGroup
          title="App lock"
          icon="lock-closed-outline"
          animate={false}
          footer={
            available
              ? `Petal asks for ${availability.label} when you open it after a break. Confirming it now is how we make sure the lock actually works before you rely on it.`
              : 'The switch comes back on its own the moment this phone can do it — nothing here needs setting up twice.'
          }
        >
          {available ? (
            <SettingsRow
              icon={KIND_ICON[availability.kind]}
              tone="info"
              title={`Unlock with ${availability.label}`}
              subtitle={
                biometricLock
                  ? 'On. Your pets’ records are behind it.'
                  : 'Off. Anyone holding your unlocked phone can read everything.'
              }
              checked={biometricLock}
              onCheckedChange={(next) => void setLock(next)}
              accessibilityHint={
                working
                  ? 'Waiting for your phone to confirm.'
                  : `Asks for ${availability.label} before changing.`
              }
            />
          ) : (
            <SettingsRow
              icon={KIND_ICON[availability.kind]}
              tone="neutral"
              title="Unlock with a fingerprint or face"
              subtitle={availability.explanation ?? undefined}
              value="Unavailable"
            />
          )}
        </SettingsGroup>
      </Animated.View>

      {available && biometricLock ? (
        <Animated.View
          entering={
            t.reduceMotion
              ? FadeIn.duration(t.motion.duration.base)
              : FadeInDown.duration(t.motion.duration.slow).easing(t.motion.easing.decelerate)
          }
          exiting={FadeOut.duration(t.motion.duration.fast)}
          style={{ gap: t.spacing.xl }}
        >
          <SettingsGroup
            title="Ask again after"
            icon="time-outline"
            animate={false}
            footer={`${delayHint} A minute is as long as Petal will promise — beyond that the app has been asleep and the guarantee stops meaning anything.`}
          >
            <View style={{ padding: t.spacing.md }}>
              <SegmentedControl
                segments={DELAY_SEGMENTS}
                value={Math.min(autoLockAfterMs, MAX_AUTO_LOCK_MS)}
                onChange={chooseDelay}
                accessibilityLabel="Lock again after"
              />
            </View>
          </SettingsGroup>

          <SettingsGroup animate={false}>
            <SettingsRow
              icon="lock-closed"
              tone="primary"
              title="Lock Petal now"
              subtitle={`Drops straight to the ${availability.label} screen`}
              chevron={false}
              accessibilityHint="Locks the app immediately."
              onPress={lockNow}
            />
          </SettingsGroup>
        </Animated.View>
      ) : null}

      <Animated.View entering={enter(1)}>
        <Surface variant="surfaceAlt" radius="xl" padding="base" border>
          <Column gap="md">
            <Row gap="sm">
              <Icon name="shield-checkmark-outline" size="sm" color="primaryText" />
              <Text variant="subheadStrong">What the lock does, honestly</Text>
            </Row>
            <Text variant="footnote" color="textSecondary">
              It stops someone who already has your unlocked phone from reading your pets’
              records, and it hides them from the app switcher. It isn’t encryption, and it
              doesn’t change who can see your pets on the other side of the network — that’s the
              caregiver list on each pet, and only you can change it.
            </Text>
            <Text variant="footnote" color="textTertiary">
              {`Currently ${
                biometricLock
                  ? `armed — Petal re-locks ${describeAutoLock(autoLockAfterMs).toLowerCase()}.`
                  : 'off — Petal opens straight to your pets.'
              }`}
            </Text>
          </Column>
        </Surface>
      </Animated.View>

      <Animated.View entering={enter(2)}>
        <SettingsGroup
          animate={false}
          footer={
            user
              ? `Signed in as ${user.email}. Signing out clears this phone only — nothing you’ve logged is deleted.`
              : undefined
          }
        >
          <SettingsRow
            icon="log-out-outline"
            tone="danger"
            destructive
            title="Sign out"
            chevron={false}
            accessibilityHint="Asks you to confirm first."
            onPress={() => signOutSheet.open()}
          />
        </SettingsGroup>
      </Animated.View>

      <ConfirmSheet
        controller={signOutSheet}
        title="Sign out of Petal?"
        body="Everything you’ve logged stays exactly where it is. You’ll just need to sign in again to see it."
        confirmLabel="Sign out"
        cancelLabel="Stay signed in"
        icon="log-out-outline"
        onConfirm={() => signOut()}
      />
    </Screen>
  );
}

/* ---------------------------------------------------------------- skeleton */

/** Shaped like the lock row, so nothing jumps when the answer arrives. */
function LockSkeleton() {
  const t = useTheme();

  return (
    <Column gap="sm">
      <Skeleton w="35%" h={t.spacing.md} r="sm" dim />
      <Surface variant="surface" elevation={1} radius="xl" padding="base">
        <SkeletonGroup label="Checking what this phone can do" gap="md">
          <Row gap="md">
            <Skeleton w={t.spacing.xxxl} h={t.spacing.xxxl} r="md" />
            <View style={{ flex: 1, gap: t.spacing.xs }}>
              <Skeleton w="55%" h={t.spacing.base} r="sm" />
              <Skeleton w="80%" h={t.spacing.md} r="sm" dim />
            </View>
            <Skeleton w={t.spacing.huge} h={t.spacing.xl} r="pill" dim />
          </Row>
        </SkeletonGroup>
      </Surface>
    </Column>
  );
}
