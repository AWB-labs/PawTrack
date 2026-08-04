/**
 * Onboarding, step one — who are we talking to?
 *
 * Two fields is the whole screen, and one of them is optional. Everything else
 * an app like this is tempted to ask for on day one (a phone number, a city, a
 * "how did you hear about us") can be inferred, asked later, or done without —
 * and every extra field here costs accounts.
 *
 * The photo comes *after* the name in reading order but sits above it visually,
 * because an empty avatar with a name under it looks like a person waiting to be
 * finished, while an empty avatar on its own looks like a chore.
 *
 * The greeting under the field is the point of the step: the moment the name is
 * real, the app uses it. That's the promise the rest of Petal keeps — Buddy's
 * dinner, Mochi's dose, Maya's household — made on the first screen that can.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import Animated, { FadeIn, FadeInDown, FadeOut } from 'react-native-reanimated';

import { usePets } from '@/data/queries/usePets';
import { useUpdateProfile } from '@/data/queries/useUsers';
import { OnboardingScaffold } from '@/features/onboarding/OnboardingScaffold';
import haptics from '@/lib/haptics';
import { useSession } from '@/stores/session';
import { useUI } from '@/stores/ui';
import { useTheme } from '@/theme';
import { Column, Icon, Input, PhotoPicker, Row, Text } from '@/ui';

/* ---------------------------------------------------------------- constants */

/** Long enough for a full name with a title, short enough to fit a header. */
const NAME_MAX = 40;

/* ------------------------------------------------------------------ helpers */

function firstName(value: string): string {
  return value.trim().split(/\s+/)[0] ?? '';
}

/* -------------------------------------------------------------------- screen */

export default function OnboardingProfileScreen() {
  const t = useTheme();
  const router = useRouter();

  const user = useSession((s) => s.user);
  const memberships = useSession((s) => s.memberships);
  const { data: pets } = usePets();
  const updateProfile = useUpdateProfile();
  const setOnboardingStep = useUI((s) => s.setOnboardingStep);

  const [name, setName] = useState(user?.displayName ?? '');
  const [photo, setPhoto] = useState<string | null>(user?.avatarUrl ?? null);
  const [touched, setTouched] = useState(false);

  const greeting = firstName(name);
  const problem = touched && name.trim().length === 0 ? 'We just need something to call you.' : undefined;

  /**
   * Someone who arrived through an invite (or signed in with a provider that
   * already gave us pets) has a household waiting; the first-pet step would be
   * asking a question they've already answered. The router lands them in the
   * app on its own once the name exists.
   */
  const hasHousehold = useMemo(
    () => (pets?.length ?? 0) > 0 || memberships.length > 0,
    [memberships.length, pets],
  );

  const advance = useCallback(async () => {
    setTouched(true);
    if (name.trim().length === 0) {
      haptics.warn();
      return;
    }

    try {
      await updateProfile.mutateAsync({ displayName: name.trim(), avatarUrl: photo });
      haptics.commit();
      if (hasHousehold) return;
      setOnboardingStep('firstPet');
      router.push('/first-pet');
    } catch {
      // `useUpdateProfile` rolls the optimistic patch back and raises the
      // themed toast; staying put with the typed name intact is the right
      // outcome here, not a second message.
      haptics.error();
    }
  }, [hasHousehold, name, photo, router, setOnboardingStep, updateProfile]);

  return (
    <OnboardingScaffold
      step={1}
      eyebrow="First things first"
      title="Who should we say hello to?"
      body="A name, and a face if you fancy it. This is what the people you share a pet with will see — nothing else travels with it."
      primary={{
        label: greeting ? `Continue as ${greeting}` : 'Continue',
        onPress: () => void advance(),
        loading: updateProfile.isPending,
      }}
      footnote={
        <Row gap="xs" align="start">
          <Icon name="sparkles-outline" size="xs" color="textTertiary" />
          <Text variant="caption" color="textTertiary" align="center">
            All of this is yours to change later, in Settings.
          </Text>
        </Row>
      }
      testID="onboarding-profile"
    >
      <Column gap="xl" align="center">
        <PhotoPicker
          value={photo}
          onChange={setPhoto}
          shape="circle"
          label="Your photo"
          placeholderText="Add a photo"
          helper="Optional — it just helps your sitters know who’s who."
        />

        <Column gap="sm" style={{ alignSelf: 'stretch' }}>
          <Input
            label="Your name"
            value={name}
            onChangeText={setName}
            onBlur={() => setTouched(true)}
            error={problem}
            leadingIcon="person-outline"
            autoCapitalize="words"
            autoComplete="name"
            textContentType="name"
            autoFocus={!user?.displayName}
            maxLength={NAME_MAX}
            showCounter={false}
            returnKeyType="done"
            onSubmitEditing={() => void advance()}
            testID="onboarding-name"
          />

          {greeting ? (
            <Animated.View
              key={greeting}
              entering={
                t.reduceMotion
                  ? FadeIn.duration(t.motion.duration.base)
                  : FadeInDown.duration(t.motion.duration.base).easing(t.motion.easing.decelerate)
              }
              exiting={FadeOut.duration(t.motion.duration.fast)}
            >
              <Row gap="xs" justify="center">
                <Text variant="callout" color="primaryText">
                  Lovely to meet you, {greeting}.
                </Text>
                <Text variant="callout">🐾</Text>
              </Row>
            </Animated.View>
          ) : null}
        </Column>
      </Column>
    </OnboardingScaffold>
  );
}
