/**
 * Settings — the hub.
 *
 * The failure mode of a settings hub is that it becomes a list of doors: five
 * words, five chevrons, and no way to know whether anything behind them is on.
 * So every row here carries its *current value*, and the values are read from
 * the same places the sub-screens write to — the preference store, the app
 * settings store, the OS permission.
 *
 * Two consequences of that decision:
 *
 *   · **The device-owned values are refetched on focus.** Notification
 *     permission can change while Petal is in the background — someone taps
 *     "Open settings", flips a switch, and comes back. Re-reading on focus is
 *     what stops this screen from confidently showing yesterday's answer.
 *   · **A blocked permission is stated, not implied.** "Blocked" in the warning
 *     tone beats "All on" over a switch the OS is quietly ignoring.
 *
 * The account card at the top exists so this reads as a place rather than a
 * menu — you land on yourself, not on a list of nouns.
 */

import Constants from 'expo-constants';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { describeDataSource } from '@/data';
import { SettingsGroup } from '@/features/settings/SettingsGroup';
import { SettingsRow } from '@/features/settings/SettingsRow';
import {
  countActiveReminders,
  describeQuietHours,
  describeReminders,
  useAppSettings,
} from '@/features/settings/appSettings';
import { toHref } from '@/lib/deeplinks';
import { getPermission, type PermissionOutcome } from '@/lib/notifications';
import { usePreferences } from '@/stores/preferences';
import { useCurrentUser, useSession } from '@/stores/session';
import { useTheme } from '@/theme';
import {
  Avatar,
  Badge,
  Column,
  ConfirmSheet,
  Icon,
  Row,
  Screen,
  ScreenHeader,
  Surface,
  Text,
  Touchable,
  useSheet,
} from '@/ui';

/* ---------------------------------------------------------------- constants */

const THEME_LABEL = { system: 'System', light: 'Light', dark: 'Dark' } as const;

const UNIT_LABEL = { kg: 'Kilograms', lb: 'Pounds' } as const;

/** Falls back to the manifest's own version rather than a literal string. */
const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';

/* ---------------------------------------------------------------- component */

export default function SettingsHubScreen() {
  const t = useTheme();
  const router = useRouter();

  const user = useCurrentUser();
  const signOut = useSession((s) => s.signOut);
  const signOutSheet = useSheet();

  const theme = usePreferences((s) => s.theme);
  const weightUnit = usePreferences((s) => s.weightUnit);
  const hapticsOn = usePreferences((s) => s.haptics);
  const appReduceMotion = usePreferences((s) => s.reduceMotion);
  const reminders = useAppSettings((s) => s.reminders);
  const quietHours = useAppSettings((s) => s.quietHours);

  /* ---- values the device owns ------------------------------------------ */

  const [permission, setPermission] = useState<PermissionOutcome | null>(null);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void getPermission().then((next) => {
        if (alive) setPermission(next);
      });
      return () => {
        alive = false;
      };
    }, []),
  );

  /* ---- derived ---------------------------------------------------------- */

  const dataSource = useMemo(() => describeDataSource(), []);

  const appearanceSubtitle = useMemo(() => {
    const parts = [`Weights in ${UNIT_LABEL[weightUnit].toLowerCase()}`];
    if (!hapticsOn) parts.push('haptics off');
    if (appReduceMotion) parts.push('motion reduced');
    return parts.join(' · ');
  }, [appReduceMotion, hapticsOn, weightUnit]);

  const remindersValue = useMemo(() => {
    if (permission && !permission.granted) return 'Blocked';
    return describeReminders(reminders);
  }, [permission, reminders]);

  const remindersSubtitle = useMemo(() => {
    if (permission && !permission.granted) {
      return 'Your phone is holding notifications back — one tap fixes it';
    }
    if (countActiveReminders(reminders) === 0) return 'Nothing is set to interrupt you';
    if (quietHours.enabled) return `Held quietly from ${describeQuietHours(quietHours)}`;
    return 'Meals, doses, vet visits and refills';
  }, [permission, quietHours, reminders]);

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
      title="Settings"
      subtitle="How Furry Tracker looks, when it speaks up, and who gets to see your pets."
    />
  );

  return (
    <Screen
      header={header}
      scroll
      contentContainerStyle={{ gap: t.spacing.xl, paddingBottom: t.spacing.xxl }}
    >
      {user ? (
        <Animated.View entering={enter(0)}>
          <AccountCard
            name={user.displayName}
            email={user.email}
            avatarUrl={user.avatarUrl}
            onPress={() => router.push(toHref('/settings/account'))}
          />
        </Animated.View>
      ) : null}

      <Animated.View entering={enter(1)}>
        <SettingsGroup
          title="Furry Tracker on this phone"
          icon="phone-portrait-outline"
          animate={false}
          footer="Both live on this handset. Sign in somewhere else and you’ll choose them again there."
        >
          <SettingsRow
            icon="contrast-outline"
            tone="primary"
            title="Appearance"
            subtitle={appearanceSubtitle}
            value={THEME_LABEL[theme]}
            accessibilityHint="Opens theme, weight units, haptics and motion."
            onPress={() => router.push(toHref('/settings/appearance'))}
          />
          <SettingsRow
            icon="alarm-outline"
            tone="warning"
            title="Reminders"
            subtitle={remindersSubtitle}
            value={remindersValue}
            accessibilityHint="Opens reminder categories, quiet hours and a test notification."
            onPress={() => router.push(toHref('/settings/notifications'))}
          />
        </SettingsGroup>
      </Animated.View>

      <Animated.View entering={enter(2)}>
        <SettingsGroup
          title="Wherever you sign in"
          icon="person-outline"
          animate={false}
          footer="Your name, photo and email travel with your account, so they follow you onto any phone."
        >
          <SettingsRow
            icon="person-circle-outline"
            tone="accent"
            title="Profile and account"
            subtitle={user ? user.email : 'Your name, photo and password'}
            accessibilityHint="Opens your name, photo, password and account deletion."
            onPress={() => router.push(toHref('/settings/account'))}
          />
          <SettingsRow
            icon="information-circle-outline"
            tone="neutral"
            title="About Furry Tracker"
            subtitle={`Version ${APP_VERSION} · ${dataSource.label}`}
            accessibilityHint="Opens version, credits and licences."
            onPress={() => router.push(toHref('/settings/about'))}
          />
        </SettingsGroup>
      </Animated.View>

      <Animated.View entering={enter(3)}>
        <SettingsGroup
          animate={false}
          footer={
            user
              ? `Signed in as ${user.email}. Everything you’ve logged stays put — signing out only closes it on this phone.`
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
        title="Sign out of Furry Tracker?"
        body="Everything you’ve logged stays exactly where it is. You’ll just need to sign in again to see it."
        confirmLabel="Sign out"
        cancelLabel="Stay signed in"
        icon="log-out-outline"
        onConfirm={() => signOut()}
      />
    </Screen>
  );
}

/* ------------------------------------------------------------ account card */

type AccountCardProps = {
  name: string;
  email: string;
  avatarUrl: string | null;
  onPress: () => void;
};

function AccountCard({ name, email, avatarUrl, onPress }: AccountCardProps) {
  const t = useTheme();

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={`${name}. ${email}.`}
      accessibilityHint="Opens your profile and account settings."
      haptic="tap"
      onPress={onPress}
      pressScale="large"
    >
      <Surface variant="surface" elevation={1} radius="xxl" padding="base">
        <Row gap="base">
          <Avatar uri={avatarUrl} name={name} size="lg" ring ringColor="primary" />
          <Column flex gap="hair">
            <Text variant="title3" numberOfLines={1}>
              {name}
            </Text>
            <Text variant="footnote" color="textTertiary" numberOfLines={1}>
              {email}
            </Text>
          </Column>
          <View style={{ paddingRight: t.spacing.xxs }}>
            <Badge label="Signed in" tone="success" size="sm" />
          </View>
          <Icon name="chevron-forward" size="sm" color="textTertiary" />
        </Row>
      </Surface>
    </Touchable>
  );
}
