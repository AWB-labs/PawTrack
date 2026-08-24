/**
 * Create an account.
 *
 * The shortest honest form we could get to: a name, an email, a password. There
 * is no "confirm password" field because the reveal toggle already solves the
 * problem it was invented for, and no marketing checkbox because we don't send
 * marketing.
 *
 * Two things carry the screen past "stacked inputs":
 *
 *   · **The name field greets you back.** As soon as there's something to say
 *     hello to, the eyebrow above the form changes from an instruction into a
 *     welcome. It costs one line of state and it's the moment the account stops
 *     feeling like a database row.
 *   · **The promise sits where the doubt is** — directly under the password,
 *     right before the button that commits, rather than buried in a policy page
 *     nobody opens.
 */

import React, { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { FadeIn } from 'react-native-reanimated';

import { AuthScaffold } from '@/features/auth/AuthScaffold';
import { PasswordField, passwordProblem } from '@/features/auth/PasswordField';
import { openExternal } from '@/lib/deeplinks';
import { toUserMessage, type UserMessage } from '@/lib/errors';
import haptics from '@/lib/haptics';
import { useSession } from '@/stores/session';
import { useTheme } from '@/theme';
import {
  Banner,
  Button,
  Column,
  Icon,
  Input,
  Row,
  Surface,
  Text,
  Touchable,
  type InputHandle,
} from '@/ui';

/* ---------------------------------------------------------------- constants */

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const TERMS_URL = 'https://petal.app/terms';
const PRIVACY_URL = 'https://petal.app/privacy';

/** Long enough for "Dr. María-José van der Berg", short enough to fit a header. */
const NAME_MAX = 40;

const COPY = {
  nameMissing: 'What should we call you?',
  emailMissing: 'We’ll need an email so you can get back in.',
  emailShape: 'That looks a little off — check for a missing @ or a stray dot.',
} as const;

/* ------------------------------------------------------------------ helpers */

function nameProblem(value: string): string | null {
  return value.trim().length === 0 ? COPY.nameMissing : null;
}

function emailProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return COPY.emailMissing;
  if (!EMAIL_SHAPE.test(trimmed)) return COPY.emailShape;
  return null;
}

/** "Maya Ellison" → "Maya". Used only for the greeting, never for storage. */
function firstName(value: string): string {
  return value.trim().split(/\s+/)[0] ?? '';
}

/* ------------------------------------------------------------------ promise */

function PrivacyPromise() {
  const t = useTheme();

  return (
    <Surface variant="surfaceAlt" radius="lg" padding="md" elevation={0} border>
      <Row gap="md" align="start">
        <View
          style={{
            width: t.spacing.xl + t.spacing.xxs,
            height: t.spacing.xl + t.spacing.xxs,
            borderRadius: t.radius.pill,
            backgroundColor: t.color.successSoft,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="shield-checkmark-outline" size="sm" color="onSuccessSoft" />
        </View>
        <Text variant="footnote" color="textSecondary" style={{ flex: 1 }}>
          Vaccination records, doses and photos stay inside your household. You choose who sees
          what, for exactly how long — and you can take it all back in a tap.
        </Text>
      </Row>
    </Surface>
  );
}

/* -------------------------------------------------------------------- screen */

export default function SignUpScreen() {
  const t = useTheme();
  const router = useRouter();

  const signUp = useSession((s) => s.signUp);
  const pending = useSession((s) => s.pending);

  const nameRef = useRef<InputHandle>(null);
  const emailRef = useRef<InputHandle>(null);
  const passwordRef = useRef<InputHandle>(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState({ name: false, email: false, password: false });
  const [failure, setFailure] = useState<UserMessage | null>(null);
  const [attempt, setAttempt] = useState(0);

  const busy = pending === 'signUp' || pending === 'oauth';
  const greeting = firstName(name);

  const nameError = touched.name ? nameProblem(name) : null;
  const emailError = touched.email ? emailProblem(email) : null;
  const passwordError = touched.password ? passwordProblem(password) : null;

  const submit = useCallback(async () => {
    setTouched({ name: true, email: true, password: true });

    const firstBad =
      nameProblem(name) !== null
        ? nameRef
        : emailProblem(email) !== null
          ? emailRef
          : passwordProblem(password) !== null
            ? passwordRef
            : null;

    if (firstBad) {
      firstBad.current?.focus();
      firstBad.current?.shake();
      haptics.warn();
      return;
    }

    setFailure(null);
    try {
      await signUp({ email: email.trim(), password, displayName: name.trim() });
      haptics.success();
      // The onboarding guard takes it from here — profile, then first pet.
    } catch (error) {
      haptics.error();
      setFailure(toUserMessage(error));
      setAttempt((n) => n + 1);
    }
  }, [email, name, password, signUp]);

  return (
    <AuthScaffold
      eyebrow={greeting ? `Hello, ${greeting}` : 'Let’s begin'}
      title="Make Furry Tracker yours"
      subtitle="One account holds every animal you look after — and everyone who helps you look after them."
      footer={
        <Column gap="md">
          <Column gap="xs" align="center">
            <Text variant="caption" color="textTertiary" align="center">
              Creating an account means you’re happy with how we handle your data.
            </Text>
            <Row gap="md">
              <Touchable
                accessibilityRole="link"
                accessibilityLabel="Read the terms of service"
                haptic="tap"
                onPress={() => void openExternal(TERMS_URL)}
                pressScale="small"
                style={{ paddingVertical: t.spacing.xxs }}
              >
                <Text variant="caption" color="primaryText">
                  Terms of Service
                </Text>
              </Touchable>
              <Text variant="caption" color="textFaint">
                ·
              </Text>
              <Touchable
                accessibilityRole="link"
                accessibilityLabel="Read the privacy policy"
                haptic="tap"
                onPress={() => void openExternal(PRIVACY_URL)}
                pressScale="small"
                style={{ paddingVertical: t.spacing.xxs }}
              >
                <Text variant="caption" color="primaryText">
                  Privacy Policy
                </Text>
              </Touchable>
            </Row>
          </Column>

          <Row gap="xs" justify="center">
            <Text variant="footnote" color="textSecondary">
              Already with us?
            </Text>
            <Touchable
              accessibilityRole="link"
              accessibilityLabel="Sign in instead"
              haptic="tap"
              onPress={() => router.replace('/sign-in')}
              pressScale="small"
            >
              <Text variant="buttonSmall" color="primaryText">
                Sign in
              </Text>
            </Touchable>
          </Row>
        </Column>
      }
      testID="sign-up"
    >
      <Column gap="lg">
        {failure ? (
          <Banner
            key={attempt}
            tone={failure.tone === 'danger' ? 'danger' : failure.tone === 'info' ? 'info' : 'warning'}
            title={failure.title}
            message={failure.body}
            action={
              failure.action === 'signIn'
                ? { label: 'Go to sign in', onPress: () => router.replace('/sign-in'), icon: 'log-in-outline' }
                : undefined
            }
            onDismiss={() => setFailure(null)}
            dismissLabel="Dismiss this message"
          />
        ) : null}

        <Column gap="md">
          <Input
            ref={nameRef}
            label="Your name"
            value={name}
            onChangeText={setName}
            onBlur={() => setTouched((prev) => ({ ...prev, name: true }))}
            error={nameError ?? undefined}
            helper="This is what your sitters and the community see."
            leadingIcon="person-outline"
            autoCapitalize="words"
            autoComplete="name"
            textContentType="name"
            maxLength={NAME_MAX}
            showCounter={false}
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => emailRef.current?.focus()}
            testID="sign-up-name"
          />

          <Input
            ref={emailRef}
            label="Email"
            value={email}
            onChangeText={setEmail}
            onBlur={() => setTouched((prev) => ({ ...prev, email: true }))}
            error={emailError ?? undefined}
            leadingIcon="mail-outline"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            textContentType="emailAddress"
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => passwordRef.current?.focus()}
            clearable
            testID="sign-up-email"
          />

          <PasswordField
            ref={passwordRef}
            label="Choose a password"
            value={password}
            onChangeText={setPassword}
            onBlur={() => setTouched((prev) => ({ ...prev, password: true }))}
            error={passwordError ?? undefined}
            meter
            autoComplete="new-password"
            textContentType="newPassword"
            returnKeyType="go"
            onSubmitEditing={() => void submit()}
            testID="sign-up-password"
          />
        </Column>

        <Animated.View entering={FadeIn.duration(t.motion.duration.slow).delay(t.motion.stagger.loose)}>
          <PrivacyPromise />
        </Animated.View>

        <Column gap="md">
          <Button
            label={greeting ? `Create ${greeting}’s account` : 'Create my account'}
            onPress={() => void submit()}
            loading={pending === 'signUp'}
            disabled={busy && pending !== 'signUp'}
            size="lg"
            hero
            fullWidth
            haptic="commit"
            testID="sign-up-submit"
          />
        </Column>
      </Column>
    </AuthScaffold>
  );
}
