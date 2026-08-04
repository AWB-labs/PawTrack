/**
 * Settings — Reminders.
 *
 * Notifications are the only part of Petal most people see on a normal Tuesday,
 * so this screen is built around one question: is the thing you just switched on
 * actually going to happen?
 *
 * Four things follow from that:
 *
 *   · **The OS permission is stated first and plainly.** A wall of switches
 *     above a permission the phone is quietly refusing is a lie told six times.
 *     When it's blocked, the banner says so and offers the one control that
 *     fixes it — `Linking.openSettings()`, because on a second refusal iOS will
 *     never ask again from inside the app.
 *   · **Coming back from Settings re-asks properly.** `getPermission()` caches
 *     for half a minute, which is exactly the window someone spends flipping a
 *     switch in the OS and walking back. So a return *from that trip* goes
 *     through `requestPermission()`, which refreshes the cache and — since the
 *     decision is already made — never shows a prompt.
 *   · **The test notification is real.** It goes through the same scheduler,
 *     content builder and channel as a genuine dose reminder. A preview that
 *     isn't the real thing is worth nothing.
 *   · **Your choices survive a refusal.** Turning the permission off doesn't
 *     wipe the categories; they sit and wait, and the footnote says so.
 */

import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut } from 'react-native-reanimated';

import { usePets } from '@/data/queries/usePets';
import { SettingsGroup } from '@/features/settings/SettingsGroup';
import { SettingsRow } from '@/features/settings/SettingsRow';
import {
  REMINDER_CATEGORIES,
  countActiveReminders,
  describeQuietHours,
  useAppSettings,
  type ReminderCategory,
} from '@/features/settings/appSettings';
import { openAppSettings, toHref } from '@/lib/deeplinks';
import { possessive } from '@/lib/format';
import haptics from '@/lib/haptics';
import {
  countScheduledForPet,
  getPermission,
  permissionCopy,
  requestPermission,
  sendPreview,
  type PermissionOutcome,
} from '@/lib/notifications';
import { useTheme } from '@/theme';
import {
  Banner,
  Column,
  ErrorState,
  Row,
  Screen,
  ScreenHeader,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Surface,
  Text,
  TimeField,
  toast,
} from '@/ui';

/* ---------------------------------------------------------------- component */

export default function NotificationSettingsScreen() {
  const t = useTheme();
  const router = useRouter();

  const reminders = useAppSettings((s) => s.reminders);
  const setReminder = useAppSettings((s) => s.setReminder);
  const setAllReminders = useAppSettings((s) => s.setAllReminders);
  const quietHours = useAppSettings((s) => s.quietHours);
  const setQuietHours = useAppSettings((s) => s.setQuietHours);

  const petsQuery = usePets();
  // Memoised because the reminder tally below keys off it — a fresh `[]` on
  // every render would re-run that effect forever.
  const pets = useMemo(() => petsQuery.data ?? [], [petsQuery.data]);
  const firstPet = pets[0];

  const [permission, setPermission] = useState<PermissionOutcome | null>(null);
  const [asking, setAsking] = useState(false);
  const [sending, setSending] = useState(false);
  const [queued, setQueued] = useState<number | null>(null);

  /** Set while the user is away in the OS settings app, so the return re-reads. */
  const wentToSettings = useRef(false);

  /* ---- permission ------------------------------------------------------- */

  const readPermission = useCallback(async () => {
    setPermission(await getPermission());
  }, []);

  useFocusEffect(
    useCallback(() => {
      void readPermission();
    }, [readPermission]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (wentToSettings.current) {
        wentToSettings.current = false;
        // The decision has already been made in the OS, so this resolves
        // straight away rather than prompting — and it refreshes the cache the
        // plain read would otherwise serve stale.
        void requestPermission().then(setPermission);
        return;
      }
      void readPermission();
    });
    return () => subscription.remove();
  }, [readPermission]);

  const ask = useCallback(async () => {
    setAsking(true);
    try {
      const outcome = await requestPermission();
      setPermission(outcome);
      if (outcome.granted) {
        haptics.success();
        toast.success('Reminders are on 🐾', {
          description: 'Every schedule you’ve set starts nudging you from now.',
        });
      } else {
        haptics.warn();
      }
    } finally {
      setAsking(false);
    }
  }, []);

  const goToSettings = useCallback(() => {
    wentToSettings.current = true;
    void openAppSettings();
  }, []);

  /* ---- how many are actually queued ------------------------------------ */

  useEffect(() => {
    if (pets.length === 0) {
      setQueued(0);
      return;
    }
    let alive = true;
    void Promise.all(pets.map((pet) => countScheduledForPet(pet.id))).then((counts) => {
      if (alive) setQueued(counts.reduce((total, count) => total + count, 0));
    });
    return () => {
      alive = false;
    };
  }, [pets]);

  /* ---- actions ---------------------------------------------------------- */

  const toggleCategory = useCallback(
    (category: ReminderCategory, next: boolean) => {
      setReminder(category, next);
    },
    [setReminder],
  );

  const activeCount = countActiveReminders(reminders);
  const allOn = activeCount === REMINDER_CATEGORIES.length;

  const toggleAll = useCallback(() => {
    setAllReminders(!allOn);
    haptics.commit();
  }, [allOn, setAllReminders]);

  const sendTest = useCallback(async () => {
    if (!firstPet || sending) return;
    setSending(true);
    try {
      let outcome = permission ?? (await getPermission());
      if (!outcome.granted && outcome.reason === 'denied' && outcome.canAskAgain) {
        outcome = await requestPermission();
        setPermission(outcome);
      }

      if (!outcome.granted) {
        haptics.warn();
        toast.warning('Your phone is holding that back', {
          description: 'Turn notifications on for Petal and the test will land straight away.',
          action: { label: 'Open settings', onPress: goToSettings },
        });
        return;
      }

      await sendPreview(firstPet);
      haptics.success();
      toast.success('On its way', {
        description: `Lock your phone and it’ll arrive in a couple of seconds, exactly as ${possessive(firstPet.name)} real ones will.`,
      });
    } finally {
      setSending(false);
    }
  }, [firstPet, goToSettings, permission, sending]);

  /* ---- chrome ----------------------------------------------------------- */

  const copy = permission ? permissionCopy(permission) : null;
  const blocked = permission !== null && !permission.granted;
  const showBanner = copy !== null && copy.action !== 'none';

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
      title="Reminders"
      subtitle="Petal only ever interrupts you about an animal that needs something. You decide which ones."
    />
  );

  const queuedFootnote =
    queued === null
      ? 'Counting what’s already queued…'
      : queued === 0
        ? 'Nothing is queued yet — set a feeding time or a dose and reminders build themselves.'
        : `${queued} reminder${queued === 1 ? '' : 's'} queued across your pets right now.`;

  return (
    <Screen
      header={header}
      scroll
      contentContainerStyle={{ gap: t.spacing.xl, paddingBottom: t.spacing.xxl }}
    >
      {showBanner ? (
        <Animated.View
          entering={FadeIn.duration(t.motion.duration.base)}
          exiting={FadeOut.duration(t.motion.duration.fast)}
        >
          <Banner
            tone={blocked ? 'warning' : 'info'}
            title={copy.title}
            message={copy.body}
            icon={blocked ? 'notifications-off-outline' : 'notifications-outline'}
            action={
              copy.actionLabel
                ? {
                    label: asking ? 'Asking…' : copy.actionLabel,
                    icon: copy.action === 'request' ? 'notifications-outline' : 'settings-outline',
                    onPress: copy.action === 'request' ? () => void ask() : goToSettings,
                  }
                : undefined
            }
          />
        </Animated.View>
      ) : null}

      <Animated.View entering={enter(0)} style={{ gap: t.spacing.sm }}>
        <SectionHeader
          first
          title="What Petal may interrupt you for"
          subtitle={
            allOn
              ? 'Everything below is on. Turn off anything that isn’t worth a buzz.'
              : `${activeCount} of ${REMINDER_CATEGORIES.length} on.`
          }
          actionLabel={allOn ? 'Turn all off' : 'Turn all on'}
          onAction={toggleAll}
        />
        <SettingsGroup animate={false} footer={queuedFootnote}>
          {REMINDER_CATEGORIES.map((category) => (
            <SettingsRow
              key={category.id}
              icon={category.icon}
              tone={category.id === 'community' ? 'accent' : 'primary'}
              title={category.label}
              subtitle={category.description}
              checked={reminders[category.id]}
              onCheckedChange={(next) => toggleCategory(category.id, next)}
            />
          ))}
        </SettingsGroup>
      </Animated.View>

      <Animated.View entering={enter(1)}>
        <SettingsGroup
          title="Quiet hours"
          icon="moon-outline"
          animate={false}
          footer="Anything held arrives the moment quiet hours end — nothing is dropped. A dose that’s genuinely time-critical is worth keeping outside this window."
        >
          <SettingsRow
            icon="bed-outline"
            tone="info"
            title="Hold reminders overnight"
            subtitle={
              quietHours.enabled
                ? `Held from ${describeQuietHours(quietHours)}`
                : 'Reminders arrive at whatever time they’re due'
            }
            checked={quietHours.enabled}
            onCheckedChange={(next) => setQuietHours({ enabled: next })}
          />
          {quietHours.enabled ? (
            <View style={{ padding: t.spacing.base }}>
              <Row gap="sm" align="start">
                <View style={{ flex: 1 }}>
                  <TimeField
                    label="Quiet from"
                    title="Start holding reminders at"
                    value={quietHours.start}
                    onChange={(start) => setQuietHours({ start })}
                    minuteStep={15}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <TimeField
                    label="Until"
                    title="Let them through again at"
                    value={quietHours.end}
                    onChange={(end) => setQuietHours({ end })}
                    minuteStep={15}
                  />
                </View>
              </Row>
            </View>
          ) : null}
        </SettingsGroup>
      </Animated.View>

      <Animated.View entering={enter(2)}>
        {petsQuery.isPending ? (
          <TestRowSkeleton />
        ) : petsQuery.isError ? (
          <ErrorState
            variant="compact"
            frame
            error={petsQuery.error}
            title="We couldn’t check your pets"
            body="Without the list we can’t send you a test reminder. Everything above is saved either way."
            onRetry={() => petsQuery.refetch()}
          />
        ) : (
          <SettingsGroup
            title="See one for yourself"
            icon="paper-plane-outline"
            animate={false}
            footer={
              firstPet
                ? 'It goes through exactly the same machinery a real dose reminder does — same channel, same sound, same tap-through.'
                : 'Reminders are built from feeding times and doses, so there’s nothing to preview until there’s a pet to remind you about.'
            }
          >
            {firstPet ? (
              <SettingsRow
                icon="notifications-outline"
                tone="success"
                title="Send a test reminder"
                subtitle={`Arrives in a couple of seconds, naming ${firstPet.name}`}
                value={sending ? 'Sending…' : undefined}
                chevron={false}
                accessibilityHint="Sends one real notification to this phone."
                onPress={() => void sendTest()}
              />
            ) : (
              <SettingsRow
                icon="add-circle-outline"
                tone="primary"
                title="Add your first pet"
                subtitle="Then we can show you exactly what a reminder looks like"
                accessibilityHint="Opens the new pet form."
                onPress={() => router.push(toHref('/pet/new'))}
              />
            )}
          </SettingsGroup>
        )}
      </Animated.View>

      <Animated.View entering={enter(3)}>
        <Surface variant="surfaceAlt" radius="xl" padding="base" border>
          <Row gap="md" align="start">
            <Text variant="footnote" color="textTertiary" style={{ flex: 1 }}>
              No streaks, no “we miss you”, no marketing. If Petal buzzes, an animal needs
              something — and your categories above stay saved even while notifications are
              switched off at the phone.
            </Text>
          </Row>
        </Surface>
      </Animated.View>

    </Screen>
  );
}

/* ---------------------------------------------------------------- skeleton */

/** Matches the test row's shape, so the swap-in doesn't shift the page. */
function TestRowSkeleton() {
  const t = useTheme();

  return (
    <Column gap="sm">
      <Skeleton w="45%" h={t.spacing.md} r="sm" dim />
      <Surface variant="surface" elevation={1} radius="xl" padding="base">
        <SkeletonGroup label="Checking your pets" gap="md">
          <Row gap="md">
            <Skeleton w={t.spacing.xxxl} h={t.spacing.xxxl} r="md" />
            <View style={{ flex: 1, gap: t.spacing.xs }}>
              <Skeleton w="60%" h={t.spacing.base} r="sm" />
              <Skeleton w="85%" h={t.spacing.md} r="sm" dim />
            </View>
          </Row>
        </SkeletonGroup>
      </Surface>
    </Column>
  );
}
