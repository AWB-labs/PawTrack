/**
 * Onboarding, step two — the dual-role reveal.
 *
 * This is the screen where Petal's central idea gets said out loud: **a role
 * belongs to a (person, pet) pair, not to an account.** Owning Buddy and sitting
 * for Mochi are not two kinds of user, they're two rows — so the question here
 * is never "what type of account do you want", it's "who are you here for right
 * now", and the footnote makes clear the answer isn't binding.
 *
 * The two paths genuinely diverge:
 *
 *   · **Mine** carries on through the flow and lands in the app, where adding a
 *     pet is a first-class task with its own form rather than a cramped step in
 *     a wizard.
 *   · **Someone else's** leaves the flow entirely for the invite screen, because
 *     the code *is* their household — asking a sitter about notification
 *     permissions before they've joined anything is asking about nothing.
 *
 * The invite field only appears once that path is chosen. A code box sitting
 * open on a screen most people don't need it on reads as homework.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  ReduceMotion,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type WithSpringConfig,
} from 'react-native-reanimated';

import { OnboardingScaffold } from '@/features/onboarding/OnboardingScaffold';
import { toHref } from '@/lib/deeplinks';
import haptics from '@/lib/haptics';
import { formatInviteCodeInput, parseInviteCode } from '@/lib/id';
import { useUI } from '@/stores/ui';
import { spring, useTheme } from '@/theme';
import { Column, Icon, Input, Row, Text, Touchable, type InputHandle } from '@/ui';
import { EmptyCaregivers, EmptyPets, type IllustrationProps } from '@/ui/illustrations';

/* -------------------------------------------------------------------- types */

type Path = 'own' | 'help';

type Choice = {
  path: Path;
  eyebrow: string;
  title: string;
  body: string;
  Art: React.ComponentType<IllustrationProps>;
};

/* ---------------------------------------------------------------- constants */

/** See `Touchable` — the theme's `springWith` helper doesn't type-check yet. */
const SELECT_SPRING: WithSpringConfig = { ...spring.gentle, reduceMotion: ReduceMotion.System };

const CHOICES: readonly Choice[] = [
  {
    path: 'own',
    eyebrow: 'My own',
    title: 'I look after my own animal',
    body: 'The record is yours: every meal, dose and vet note. You decide who else gets to see it, and for how long.',
    Art: EmptyPets,
  },
  {
    path: 'help',
    eyebrow: 'Lending a hand',
    title: 'I’m helping with someone else’s',
    body: 'They send you a code. You get exactly the days and the jobs they chose — and it ends by itself when the sit does.',
    Art: EmptyCaregivers,
  },
];

const CODE_HELP: Record<'too-short' | 'bad-characters' | 'empty', string> = {
  empty: 'Pop the code in and we’ll find the household.',
  'too-short': 'Petal codes look like BUDDY-4KQ2 — a name, a dash, four characters.',
  'bad-characters': 'One of those characters isn’t one we use. Check for a 0 that should be an O.',
};

/* -------------------------------------------------------------- choice card */

function ChoiceCard({
  choice,
  selected,
  onPress,
}: {
  choice: Choice;
  selected: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const on = useSharedValue(selected ? 1 : 0);

  useEffect(() => {
    on.value = withSpring(selected ? 1 : 0, SELECT_SPRING);
  }, [on, selected]);

  const frameStyle = useAnimatedStyle(() => ({
    borderColor: interpolateColor(on.value, [0, 1], [t.color.border, t.color.primary]),
    backgroundColor: interpolateColor(on.value, [0, 1], [t.color.surface, t.color.primarySoft]),
  }));

  const tickStyle = useAnimatedStyle(() => ({
    opacity: on.value,
    transform: [{ scale: 0.4 + on.value * 0.6 }],
  }));

  const thumb = t.spacing.giant + t.spacing.md;

  return (
    <Touchable
      accessibilityRole="radio"
      accessibilityLabel={choice.title}
      accessibilityHint={choice.body}
      accessibilityState={{ selected }}
      haptic="select"
      onPress={onPress}
      pressScale="large"
      testID={`first-pet-${choice.path}`}
    >
      <Animated.View
        style={[
          t.elevation(selected ? 2 : 0),
          {
            flexDirection: 'row',
            alignItems: 'center',
            gap: t.spacing.md,
            padding: t.spacing.md,
            borderRadius: t.radius.xl,
            borderWidth: t.borderWidth.thin,
          },
          frameStyle,
        ]}
      >
        <View
          style={{
            width: thumb,
            height: thumb,
            borderRadius: t.radius.lg,
            backgroundColor: t.color.surfaceAlt,
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
          }}
        >
          <choice.Art size={thumb} />
        </View>

        <Column flex gap="xxs">
          <Text variant="overline" color={selected ? 'onPrimarySoft' : 'textTertiary'}>
            {choice.eyebrow}
          </Text>
          <Text variant="title3">{choice.title}</Text>
          <Text variant="footnote" color="textSecondary">
            {choice.body}
          </Text>
        </Column>

        <Animated.View
          style={[
            {
              width: t.spacing.xl,
              height: t.spacing.xl,
              borderRadius: t.radius.pill,
              backgroundColor: t.color.primary,
              alignItems: 'center',
              justifyContent: 'center',
            },
            tickStyle,
          ]}
        >
          <Icon name="checkmark" size="xs" color={t.color.onPrimary} />
        </Animated.View>
      </Animated.View>
    </Touchable>
  );
}

/* -------------------------------------------------------------------- screen */

export default function OnboardingFirstPetScreen() {
  const t = useTheme();
  const router = useRouter();
  const setOnboardingStep = useUI((s) => s.setOnboardingStep);

  const codeRef = useRef<InputHandle>(null);
  const [path, setPath] = useState<Path | null>(null);
  const [code, setCode] = useState('');
  const [codeTouched, setCodeTouched] = useState(false);

  const parsed = parseInviteCode(code);
  const codeError = codeTouched && !parsed.valid ? CODE_HELP[parsed.reason] : undefined;

  const choose = useCallback((next: Path) => {
    setPath(next);
    setCodeTouched(false);
  }, []);

  const continueTo = useCallback(
    (intent: 'own' | 'help' | 'later') => {
      setOnboardingStep('reminders');
      router.push(toHref(`/reminders?intent=${intent}`));
    },
    [router, setOnboardingStep],
  );

  const join = useCallback(() => {
    setCodeTouched(true);
    if (!parsed.valid) {
      codeRef.current?.focus();
      codeRef.current?.shake();
      haptics.warn();
      return;
    }
    haptics.commit();
    // The invite screen owns the preview, the confirmation and the "sign in
    // first" case — handing it the code is the whole handoff.
    router.push(toHref(`/invite/${parsed.code}`));
  }, [parsed, router]);

  const primary =
    path === 'help'
      ? { label: 'Join with this code', onPress: join, icon: 'enter-outline' as const }
      : {
          label: path === 'own' ? 'Continue' : 'Pick one to carry on',
          onPress: () => continueTo('own'),
          disabled: path === null,
        };

  return (
    <OnboardingScaffold
      step={2}
      eyebrow="Step two"
      title="Who are you here for?"
      body="Petal works the same either way — and plenty of people end up doing both."
      onBack={() => router.back()}
      onSkip={() => continueTo('later')}
      skipLabel="Decide later"
      primary={primary}
      secondary={
        path === 'help'
          ? { label: 'I don’t have a code yet', onPress: () => continueTo('help') }
          : undefined
      }
      footnote={
        <Row gap="xs" align="start">
          <Icon name="git-compare-outline" size="xs" color="textTertiary" />
          <Text variant="caption" color="textTertiary" align="center">
            You can be both. Access is per animal, so owning one and sitting for another never mix.
          </Text>
        </Row>
      }
      testID="onboarding-first-pet"
    >
      <Column gap="md" accessibilityRole="radiogroup">
        {CHOICES.map((choice, index) => (
          <Animated.View
            key={choice.path}
            entering={
              t.reduceMotion
                ? FadeIn.duration(t.motion.duration.base)
                : FadeInDown.duration(t.motion.duration.slow)
                    .delay(index * t.motion.stagger.base)
                    .easing(t.motion.easing.decelerate)
            }
          >
            <ChoiceCard
              choice={choice}
              selected={path === choice.path}
              onPress={() => choose(choice.path)}
            />
          </Animated.View>
        ))}

        {path === 'help' ? (
          <Animated.View
            entering={
              t.reduceMotion
                ? FadeIn.duration(t.motion.duration.base)
                : FadeInDown.duration(t.motion.duration.base).easing(t.motion.easing.decelerate)
            }
            exiting={FadeOut.duration(t.motion.duration.fast)}
            style={{ gap: t.spacing.xs }}
          >
            <Input
              ref={codeRef}
              label="Invite code"
              value={code}
              onChangeText={(next) => setCode(formatInviteCodeInput(next))}
              onBlur={() => setCodeTouched(code.length > 0)}
              error={codeError}
              helper="It’s in the message or link they sent you."
              leadingIcon="key-outline"
              placeholder="BUDDY-4KQ2"
              autoCapitalize="characters"
              autoCorrect={false}
              spellCheck={false}
              returnKeyType="go"
              onSubmitEditing={join}
              testID="first-pet-code"
            />
          </Animated.View>
        ) : null}
      </Column>
    </OnboardingScaffold>
  );
}
