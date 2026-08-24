/**
 * Onboarding, step three — reminders.
 *
 * The permission prompt is the most expensive single tap in the app: iOS asks
 * once, and a "Don't Allow" is close to permanent. So this screen exists purely
 * to make sure the OS sheet is never the first time the question is put.
 *
 * Three things buy the yes:
 *
 *   · **Show, don't sell.** The mock-up is the real notification — same title
 *     and body shape the scheduler actually sends, with this household's pet
 *     name in it. Nobody has to imagine what they're agreeing to.
 *   · **Bound the promise.** Meals, doses, vet visits. The line that says what
 *     we *won't* send is doing at least as much work as the three that say what
 *     we will.
 *   · **Make "not now" a real door.** It carries on to the next step with no
 *     scolding and no second ask — and the settings screen can turn this on
 *     later, which the copy says out loud.
 *
 * The looping arrival of the mock-up is decoration, so it pins itself open
 * under reduced motion rather than disappearing.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Animated, {
  FadeIn,
  FadeInDown,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';

import { usePets } from '@/data/queries/usePets';
import { OnboardingScaffold } from '@/features/onboarding/OnboardingScaffold';
import { openAppSettings, toHref } from '@/lib/deeplinks';
import haptics from '@/lib/haptics';
import {
  getPermission,
  permissionCopy,
  requestPermission,
  type PermissionOutcome,
} from '@/lib/notifications';
import { possessive } from '@/lib/format';
import { useTheme } from '@/theme';
import { Badge, Banner, Column, Icon, PawPrint, Row, Surface, Text, type IconName } from '@/ui';

/* ---------------------------------------------------------------- constants */

/** The stand-in when there's no pet on the account yet. */
const EXAMPLE_PET = 'Buddy';

const PROMISES: readonly { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'restaurant-outline',
    title: 'Meals, at the time you set',
    body: 'Breakfast at seven, dinner at six — whatever the schedule says.',
  },
  {
    icon: 'medkit-outline',
    title: 'Doses, before they’re late',
    body: 'Including the awkward ones: every other day, with food, twice daily.',
  },
  {
    icon: 'calendar-outline',
    title: 'Vet visits, in time to leave',
    body: 'A day before, and again an hour before you need to be walking out.',
  },
];

/* ---------------------------------------------------------- notification art */

/**
 * A lock-screen notification, drawn rather than screenshotted so it re-tints in
 * dark mode and always carries this household's pet name.
 */
function NotificationPreview({ petName }: { petName: string }) {
  const t = useTheme();
  const arrive = useSharedValue(t.reduceMotion ? 1 : 0);

  useEffect(() => {
    if (t.reduceMotion) {
      cancelAnimation(arrive);
      arrive.value = 1;
      return;
    }
    // Pause · arrive · hold · leave, on a loop. The hold is the whole point —
    // a notification that flies past before you can read it sells nothing.
    arrive.value = withRepeat(
      withSequence(
        withDelay(t.motion.duration.slow, withTiming(1, t.motion.timing(t.motion.duration.slower, 'decelerate'))),
        withDelay(
          t.motion.duration.ambient,
          withTiming(0, t.motion.timing(t.motion.duration.base, 'accelerate')),
        ),
      ),
      -1,
      false,
    );
    return () => cancelAnimation(arrive);
  }, [arrive, t.motion, t.reduceMotion]);

  const cardStyle = useAnimatedStyle(() => ({
    opacity: arrive.value,
    transform: [
      { translateY: (1 - arrive.value) * -t.spacing.xxl },
      { scale: 0.94 + arrive.value * 0.06 },
    ],
  }));

  const tile = t.spacing.xxl;
  const brandWash: readonly [string, string] = [t.color.primary, t.color.primaryHover];

  return (
    <View style={{ minHeight: t.spacing.colossal + t.spacing.xxl }} accessible accessibilityRole="image"
      accessibilityLabel={`Example notification: ${possessive(petName)} dinner time. One cup of chicken and rice — the bowl awaits.`}
    >
      <Animated.View style={cardStyle}>
        <Surface variant="glass" radius="xxl" padding="md" elevation={3}>
          <Row gap="md" align="start">
            <View
              style={[
                { width: tile, height: tile, borderRadius: t.radius.md, overflow: 'hidden' },
              ]}
            >
              <LinearGradient
                colors={brandWash}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
              >
                <PawPrint size={tile * 0.55} color={t.color.onPrimary} />
              </LinearGradient>
            </View>

            <Column flex gap="hair">
              <Row justify="between">
                <Text variant="caption" color="textTertiary">
                  PETAL
                </Text>
                <Text variant="caption" color="textTertiary">
                  now
                </Text>
              </Row>
              <Text variant="subheadStrong" numberOfLines={1}>
                {possessive(petName)} dinner time! 🐾
              </Text>
              <Text variant="footnote" color="textSecondary" numberOfLines={2}>
                1 cup of chicken &amp; rice — the bowl awaits.
              </Text>
            </Column>
          </Row>
        </Surface>
      </Animated.View>

      <View style={{ position: 'absolute', top: 0, right: 0 }} pointerEvents="none">
        <Badge label="Example" tone="neutral" size="sm" />
      </View>
    </View>
  );
}

/* ------------------------------------------------------------- promise rows */

function PromiseRow({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  const t = useTheme();
  const disc = t.spacing.xxl;

  return (
    <Row gap="md" align="start">
      <View
        style={{
          width: disc,
          height: disc,
          borderRadius: t.radius.pill,
          backgroundColor: t.color.primarySoft,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name={icon} size="sm" color="onPrimarySoft" />
      </View>
      <Column flex gap="hair">
        <Text variant="subheadStrong">{title}</Text>
        <Text variant="footnote" color="textTertiary">
          {body}
        </Text>
      </Column>
    </Row>
  );
}

/* -------------------------------------------------------------------- screen */

export default function OnboardingRemindersScreen() {
  const t = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ intent?: string }>();
  const { data: pets } = usePets();

  const [outcome, setOutcome] = useState<PermissionOutcome | null>(null);
  const [working, setWorking] = useState(false);

  const intent = params.intent ?? 'own';
  const petName = pets?.[0]?.name ?? EXAMPLE_PET;

  useEffect(() => {
    let alive = true;
    void getPermission().then((current) => {
      // Only adopt an *affirmative* answer on mount: a plain "not granted" is
      // indistinguishable from "never asked", so treating it as a refusal would
      // show a refusal message to someone nobody has asked yet.
      if (alive && current.granted) setOutcome(current);
    });
    return () => {
      alive = false;
    };
  }, []);

  const advance = useCallback(
    (remindersOn: boolean) => {
      // Deliberately NOT setOnboardingStep('done') here — `useOnboardingStatus()`
      // treats onboarding.step === 'done' as the completion sentinel, and setting
      // it before we've even navigated flips the root layout's guard mid-push,
      // unmounting the (onboarding) stack out from under this navigation ("PUSH
      // ... was not handled by any navigator"). Only done.tsx's finish() —
      // via completeOnboarding() — may mark onboarding complete.
      router.push(toHref(`/done?intent=${intent}&reminders=${remindersOn ? 'on' : 'off'}`));
    },
    [intent, router],
  );

  const ask = useCallback(async () => {
    setWorking(true);
    try {
      const result = await requestPermission();
      setOutcome(result);
      if (result.granted) haptics.success();
      else haptics.warn();
    } finally {
      setWorking(false);
    }
  }, []);

  const granted = outcome?.granted === true;
  /** Only ever set by an actual answer — mount adopts nothing but a yes. */
  const refused = outcome !== null && !outcome.granted;
  /**
   * Android will ask a second time; iOS won't, and neither will a permanent
   * "Don't Allow". When another ask is impossible the only honest primary is
   * the one that moves on.
   */
  const askableAgain = refused && outcome.reason === 'denied' && outcome.canAskAgain;
  const settled = refused && !askableAgain;
  const copy = outcome ? permissionCopy(outcome) : null;

  const primary = granted
    ? { label: 'Perfect, carry on', onPress: () => advance(true), icon: 'arrow-forward' as const }
    : settled
      ? { label: 'Carry on without them', onPress: () => advance(false) }
      : {
          label: refused ? 'Ask me once more' : 'Turn reminders on',
          onPress: () => void ask(),
          icon: 'notifications-outline' as const,
          loading: working,
        };

  return (
    <OnboardingScaffold
      step={3}
      eyebrow="Step three"
      title={granted ? 'That’s the hard part done' : `Want a nudge at ${possessive(petName)} dinner time?`}
      body={
        granted
          ? 'Every schedule you set from here on will nudge you at the right moment — and only for the things below.'
          : 'Furry Tracker already knows when the bowl and the tablet are due. Let it tell you, and you can stop keeping the list in your head.'
      }
      onBack={() => router.back()}
      primary={primary}
      secondary={
        granted || settled ? undefined : { label: 'Not now, thanks', onPress: () => advance(false) }
      }
      footnote={
        granted ? undefined : (
          <Text variant="caption" color="textTertiary" align="center">
            No rush — Settings › Notifications turns this on whenever you’re ready.
          </Text>
        )
      }
      testID="onboarding-reminders"
    >
      <Column gap="xl">
        <NotificationPreview petName={petName} />

        {copy && (granted || refused) ? (
          <Animated.View entering={FadeIn.duration(t.motion.duration.base)}>
            <Banner
              tone={granted ? 'success' : 'warning'}
              title={copy.title}
              message={copy.body}
              action={
                copy.action === 'openSettings' && copy.actionLabel
                  ? { label: copy.actionLabel, onPress: () => void openAppSettings(), icon: 'settings-outline' }
                  : undefined
              }
            />
          </Animated.View>
        ) : null}

        <Surface variant="surfaceAlt" radius="xl" padding="base" border>
          <Column gap="base">
            {PROMISES.map((promise, index) => (
              <Animated.View
                key={promise.title}
                entering={
                  t.reduceMotion
                    ? FadeIn.duration(t.motion.duration.base)
                    : FadeInDown.duration(t.motion.duration.slow)
                        .delay(index * t.motion.stagger.base)
                        .easing(t.motion.easing.decelerate)
                }
              >
                <PromiseRow icon={promise.icon} title={promise.title} body={promise.body} />
              </Animated.View>
            ))}

            <Row gap="sm" align="start">
              <Icon name="close-circle-outline" size="xs" color="textTertiary" />
              <Text variant="caption" color="textTertiary" style={{ flex: 1 }}>
                Nothing else. No streaks, no “we miss you”, no marketing — Furry Tracker only ever
                interrupts you about an animal that needs something.
              </Text>
            </Row>
          </Column>
        </Surface>
      </Column>
    </OnboardingScaffold>
  );
}
