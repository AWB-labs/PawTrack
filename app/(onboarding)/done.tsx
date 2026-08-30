/**
 * Onboarding, step four — the finish.
 *
 * A celebration screen has one job beyond the confetti: to close the loop. Four
 * screens ago the app asked for things; this one shows what those answers became
 * and what happens next, so the transition into a mostly-empty app is a plan
 * rather than a drop.
 *
 * Note what the summary does *not* do — it never congratulates you on completing
 * a form. Each line is a fact about your household ("reminders are on", "Buddy
 * is next"), because that's what was actually gained.
 *
 * There is deliberately no navigation call on the CTA. Completing onboarding
 * flips the router's guard, the app branch mounts, and expo-router lands the
 * user itself. An imperative `replace` racing that guard is how you get a flash
 * of the wrong screen.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import Animated, {
  FadeIn,
  FadeInDown,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  type WithSpringConfig,
} from 'react-native-reanimated';

import { OnboardingScaffold } from '@/features/onboarding/OnboardingScaffold';
import haptics from '@/lib/haptics';
import { useSession } from '@/stores/session';
import { useUI } from '@/stores/ui';
import { spring, useTheme } from '@/theme';
import { Avatar, Column, Divider, Icon, Row, Surface, Text, confetti, type IconName } from '@/ui';

/* -------------------------------------------------------------------- types */

type SummaryLine = {
  key: string;
  icon: IconName;
  title: string;
  body: string;
  /** `next` reads as an invitation; `done` reads as a receipt. */
  kind: 'done' | 'next';
};

/* ---------------------------------------------------------------- constants */

/** See `Touchable` — the theme's `springWith` helper doesn't type-check yet. */
const BLOOM_SPRING: WithSpringConfig = { ...spring.bouncy, reduceMotion: ReduceMotion.System };

/** Let the screen settle before the burst, or it fires under the transition. */
const CELEBRATION_DELAY_MS = 260;

/* ------------------------------------------------------------------ helpers */

function firstName(value: string | undefined): string {
  return (value ?? '').trim().split(/\s+/)[0] ?? '';
}

function nextStepFor(intent: string): { title: string; body: string; icon: IconName } {
  switch (intent) {
    case 'help':
      return {
        icon: 'key-outline',
        title: 'Next: join a household',
        body: 'Ask for the invite code and pop it in from the Pets tab — you’ll see exactly what you’ve been given before you accept.',
      };
    case 'later':
      return {
        icon: 'compass-outline',
        title: 'Next: pick your moment',
        body: 'Add an animal of your own, or join someone else’s with a code. Both live on the Pets tab, side by side.',
      };
    default:
      return {
        icon: 'paw-outline',
        title: 'Next: introduce us',
        body: 'Add your first animal from the Pets tab. Name, species, and a photo if you have one — the rest can wait.',
      };
  }
}

/* --------------------------------------------------------------------- hero */

function CelebrationHero({ name, photo }: { name: string | null; photo: string | null }) {
  const t = useTheme();
  const bloom = useSharedValue(0);

  useEffect(() => {
    bloom.value = withDelay(t.motion.duration.base, withSpring(1, BLOOM_SPRING));
  }, [bloom, t.motion.duration.base]);

  const avatarStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, bloom.value * 1.6),
    transform: [{ scale: 0.7 + bloom.value * 0.3 }],
  }));

  const haloStyle = useAnimatedStyle(() => ({
    opacity: (1 - bloom.value) * 0.6,
    transform: [{ scale: 0.9 + bloom.value * 0.9 }],
  }));

  const halo = t.spacing.colossal + t.spacing.xxxl;

  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', height: halo }}>
      <Animated.View
        pointerEvents="none"
        style={[
          {
            position: 'absolute',
            width: halo,
            height: halo,
            borderRadius: halo / 2,
            borderWidth: t.borderWidth.thick,
            borderColor: t.color.primary,
          },
          haloStyle,
        ]}
      />
      <Animated.View style={avatarStyle}>
        <Avatar
          uri={photo}
          name={name}
          size="xxl"
          ring
          ringColor="primary"
          fallbackIcon="person"
          accessibilityLabel={name ? `${name}, ready to go` : 'Your account, ready to go'}
        />
      </Animated.View>
    </View>
  );
}

/* -------------------------------------------------------------------- screen */

export default function OnboardingDoneScreen() {
  const t = useTheme();
  const params = useLocalSearchParams<{ intent?: string; reminders?: string }>();

  const user = useSession((s) => s.user);
  const completeOnboarding = useUI((s) => s.completeOnboarding);

  const celebrated = useRef(false);
  const name = firstName(user?.displayName);
  const remindersOn = params.reminders === 'on';
  const next = nextStepFor(params.intent ?? 'own');

  useEffect(() => {
    if (celebrated.current) return;
    celebrated.current = true;

    // Fired by hand so the moment still lands under reduced motion, where the
    // burst itself is skipped on purpose.
    const timer = setTimeout(() => {
      haptics.celebrate();
      confetti.fire({ power: 1.15, haptic: false });
    }, CELEBRATION_DELAY_MS);

    return () => clearTimeout(timer);
  }, []);

  const lines: SummaryLine[] = [
    {
      key: 'profile',
      icon: 'person-circle-outline',
      title: name ? `You’re ${name}` : 'Your profile is set',
      body: 'That’s the name your sitters and the community will see beside anything you log.',
      kind: 'done',
    },
    {
      key: 'reminders',
      icon: remindersOn ? 'notifications-outline' : 'notifications-off-outline',
      title: remindersOn ? 'Reminders are on' : 'Reminders are off for now',
      body: remindersOn
        ? 'Meals, doses and vet visits will nudge you at the moment they’re due — and nothing else will.'
        : 'Nothing will interrupt you. Settings › Notifications switches them on whenever you want them.',
      kind: 'done',
    },
    { key: 'next', icon: next.icon, title: next.title, body: next.body, kind: 'next' },
  ];

  const finish = useCallback(() => {
    haptics.commit();
    // Flipping the marker unmounts this branch and mounts the app; the router
    // does the navigating.
    completeOnboarding();
  }, [completeOnboarding]);

  return (
    <OnboardingScaffold
      step={4}
      eyebrow="All set"
      title={name ? `Welcome to Petal, ${name}` : 'Welcome to Petal'}
      body="Here’s where that leaves you."
      primary={{
        label: 'Take me in',
        onPress: finish,
        icon: 'arrow-forward',
      }}
      footnote={
        <Text variant="caption" color="textTertiary" align="center">
          Everything from here on is one tap from the Today screen.
        </Text>
      }
      testID="onboarding-done"
    >
      <Column gap="xl">
        <CelebrationHero name={user?.displayName ?? null} photo={user?.avatarUrl ?? null} />

        <Surface variant="surface" radius="xxl" padding="base" elevation={1}>
          <Column gap="base">
            {lines.map((line, index) => (
              <React.Fragment key={line.key}>
                {index > 0 ? <Divider inset="content" /> : null}
                <Animated.View
                  entering={
                    t.reduceMotion
                      ? FadeIn.duration(t.motion.duration.base).delay(index * t.motion.stagger.tight)
                      : FadeInDown.duration(t.motion.duration.slow)
                          .delay(t.motion.duration.base + index * t.motion.stagger.loose)
                          .easing(t.motion.easing.decelerate)
                  }
                >
                  <Row gap="md" align="start">
                    <View
                      style={{
                        width: t.spacing.xxl,
                        height: t.spacing.xxl,
                        borderRadius: t.radius.pill,
                        backgroundColor:
                          line.kind === 'next' ? t.color.accentSoft : t.color.successSoft,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Icon
                        name={line.icon}
                        size="sm"
                        color={line.kind === 'next' ? 'onAccentSoft' : 'onSuccessSoft'}
                      />
                    </View>

                    <Column flex gap="hair">
                      <Row gap="xs">
                        <Text variant="subheadStrong">{line.title}</Text>
                        {line.kind === 'done' ? (
                          <Icon name="checkmark-circle" size="xs" color="success" />
                        ) : null}
                      </Row>
                      <Text variant="footnote" color="textSecondary">
                        {line.body}
                      </Text>
                    </Column>
                  </Row>
                </Animated.View>
              </React.Fragment>
            ))}
          </Column>
        </Surface>
      </Column>
    </OnboardingScaffold>
  );
}
