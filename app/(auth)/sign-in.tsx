/**
 * Sign in — the returning-user door.
 *
 * Three decisions worth knowing about:
 *
 *   · **Local validation never turns red before you've finished typing.** A
 *     field is only marked once it has been submitted or left; after that it
 *     clears the instant it becomes valid. Being corrected mid-word is the
 *     fastest way to make a form feel hostile.
 *   · **The demo is explained, not hidden.** On the seeded adapter any email and
 *     password get you in, so the screen says so — and then goes further and
 *     offers the four seeded accounts, because signing in as Priya is the
 *     shortest possible explanation of what a caregiver can and can't see.
 *   · **The biometric affordance is honest about what it can do.** Petal's lock
 *     guards a session that already exists, and by the time you're on this
 *     screen there isn't one. So with a live backend we only *reassure* — you'll
 *     type this password once — while on the demo adapter, where no credential
 *     is actually being checked, the same control genuinely signs you in.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { isMockData } from '@/data';
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from '@/data/mock/MockAdapter';
import { AuthScaffold } from '@/features/auth/AuthScaffold';
import { PasswordField } from '@/features/auth/PasswordField';
import { LEGAL_URLS } from '@/features/legal/agreement';
import biometrics, { type BiometricAvailability } from '@/lib/biometrics';
import { openExternal, toHref } from '@/lib/deeplinks';
import { toUserMessage, type UserMessage } from '@/lib/errors';
import haptics from '@/lib/haptics';
import { usePreferences } from '@/stores/preferences';
import { useSession } from '@/stores/session';
import { useTheme } from '@/theme';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  Column,
  Icon,
  Input,
  Row,
  Sheet,
  Surface,
  Text,
  Touchable,
  useSheet,
  type IconName,
  type InputHandle,
} from '@/ui';

/* ---------------------------------------------------------------- constants */

/**
 * Deliberately permissive. A stricter pattern rejects real addresses (plus
 * signs, new TLDs, unicode locals) far more often than it catches a typo, and
 * the server is the only thing that truly knows.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const COPY = {
  emailMissing: 'We’ll need your email to find you.',
  emailShape: 'That looks a little off — check for a missing @ or a stray dot.',
  passwordMissing: 'Pop your password in and we’re through.',
} as const;

/* ------------------------------------------------------------------ helpers */

function emailProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return COPY.emailMissing;
  if (!EMAIL_SHAPE.test(trimmed)) return COPY.emailShape;
  return null;
}

/* --------------------------------------------------------------- demo card */

function DemoCard({ onExplore }: { onExplore: () => void }) {
  const t = useTheme();

  return (
    <Surface variant="glass" radius="xl" padding="base" elevation={1}>
      <Row gap="md" align="start">
        <View
          style={{
            width: t.spacing.xxl,
            height: t.spacing.xxl,
            borderRadius: t.radius.pill,
            backgroundColor: t.color.primarySoft,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="paw" size="sm" color="onPrimarySoft" />
        </View>

        <Column flex gap="xs">
          <Text variant="subheadStrong">You’re in the demo household</Text>
          <Text variant="footnote" color="textSecondary">
            Any email and password will let you in. Curious what a sitter sees? Borrow someone
            else’s account for a minute.
          </Text>
          <Touchable
            accessibilityRole="button"
            accessibilityLabel="Choose a demo account"
            accessibilityHint="Opens the four seeded accounts, each with a different level of access."
            haptic="tap"
            onPress={onExplore}
            pressScale="small"
            style={{ paddingVertical: t.spacing.xxs }}
          >
            <Row gap="xxs">
              <Text variant="buttonSmall" color="primaryText">
                Choose an account
              </Text>
              <Icon name="arrow-forward" size="xs" color="primaryText" />
            </Row>
          </Touchable>
        </Column>
      </Row>
    </Surface>
  );
}

/* -------------------------------------------------------------------- screen */

export default function SignInScreen() {
  const t = useTheme();
  const router = useRouter();

  const signIn = useSession((s) => s.signIn);
  const pending = useSession((s) => s.pending);
  const biometricArmed = usePreferences((s) => s.biometricLock);

  const roles = useSheet();
  const emailRef = useRef<InputHandle>(null);
  const passwordRef = useRef<InputHandle>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState({ email: false, password: false });
  const [failure, setFailure] = useState<UserMessage | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [sensor, setSensor] = useState<BiometricAvailability | null>(null);

  useEffect(() => {
    let alive = true;
    void biometrics.isAvailable().then((result) => {
      if (alive) setSensor(result);
    });
    return () => {
      alive = false;
    };
  }, []);

  const busy = pending === 'signIn' || pending === 'oauth';
  const emailError = touched.email ? emailProblem(email) : null;
  const passwordError = touched.password && password.length === 0 ? COPY.passwordMissing : null;

  const attemptSignIn = useCallback(
    async (credentials: { email: string; password: string }) => {
      setFailure(null);
      try {
        await signIn({ email: credentials.email.trim(), password: credentials.password });
        haptics.success();
        // The router's guard swaps the branch — no navigation call belongs here.
      } catch (error) {
        haptics.error();
        setFailure(toUserMessage(error));
        setAttempt((n) => n + 1);
        passwordRef.current?.shake();
      }
    },
    [signIn],
  );

  const submit = useCallback(() => {
    setTouched({ email: true, password: true });

    const bad = emailProblem(email);
    if (bad) {
      emailRef.current?.focus();
      emailRef.current?.shake();
      haptics.warn();
      return;
    }
    if (password.length === 0) {
      passwordRef.current?.focus();
      passwordRef.current?.shake();
      haptics.warn();
      return;
    }

    void attemptSignIn({ email, password });
  }, [attemptSignIn, email, password]);

  const signInAsDemoAccount = useCallback(
    (account: (typeof DEMO_ACCOUNTS)[number]) => {
      roles.close();
      setEmail(account.email);
      setPassword(DEMO_PASSWORD);
      setTouched({ email: false, password: false });
      void attemptSignIn({ email: account.email, password: DEMO_PASSWORD });
    },
    [attemptSignIn, roles],
  );

  /**
   * Only offered where it can actually complete: the demo adapter authorises on
   * presence, not on a credential, so a successful sensor check is genuinely
   * enough to open the household it seeded.
   */
  const quickUnlock = isMockData && biometricArmed && sensor?.available === true;

  const onQuickUnlock = useCallback(async () => {
    if (!sensor) return;
    const result = await biometrics.authenticate({ reason: 'Sign back in to Furry Tracker' });
    if (result.ok) {
      void attemptSignIn({ email: DEMO_ACCOUNTS[0].email, password: DEMO_PASSWORD });
      return;
    }
    // A deliberate cancel isn't a failure and mustn't be answered like one.
    if (result.reason === 'cancelled' || result.reason === 'fallback') return;
    haptics.warn();
    setFailure({
      title: `${sensor.label} didn’t get through`,
      body: result.message,
      action: 'none',
      actionLabel: null,
      retryable: result.canRetry,
      tone: 'warning',
    });
  }, [attemptSignIn, sensor]);

  return (
    <AuthScaffold
      eyebrow="Welcome back"
      title="Everyone’s been waiting"
      subtitle="Sign in and we’ll pick up exactly where you left off."
      headerAction={
        <Touchable
          accessibilityRole="link"
          accessibilityLabel="Create an account instead"
          haptic="tap"
          onPress={() => router.replace('/sign-up')}
          pressScale="small"
          style={{ paddingHorizontal: t.spacing.sm, paddingVertical: t.spacing.xs }}
        >
          <Text variant="buttonSmall" color="primaryText">
            Create account
          </Text>
        </Touchable>
      }
      footer={
        <Column gap="md">
          {/* Stated on the way *in*, not only on the way up. Signing back in is
              an agreement to the current rules, and somebody whose account
              predates them meets the gate on the other side of this button. */}
          <Column gap="xs" align="center">
            <Text variant="caption" color="textTertiary" align="center">
              Signing in means you agree to our terms and community rules.
            </Text>
            <Row gap="md">
              <Touchable
                accessibilityRole="link"
                accessibilityLabel="Read the terms of use"
                haptic="tap"
                onPress={() => void openExternal(LEGAL_URLS.terms)}
                pressScale="small"
                style={{ paddingVertical: t.spacing.xxs }}
              >
                <Text variant="caption" color="primaryText">
                  Terms of Use
                </Text>
              </Touchable>
              <Text variant="caption" color="textFaint">
                ·
              </Text>
              <Touchable
                accessibilityRole="link"
                accessibilityLabel="Read the community rules"
                haptic="tap"
                onPress={() => void openExternal(LEGAL_URLS.guidelines)}
                pressScale="small"
                style={{ paddingVertical: t.spacing.xxs }}
              >
                <Text variant="caption" color="primaryText">
                  Community Rules
                </Text>
              </Touchable>
            </Row>
          </Column>

          <Row gap="xs" justify="center">
            <Text variant="footnote" color="textSecondary">
              New to Furry Tracker?
            </Text>
            <Touchable
              accessibilityRole="link"
              accessibilityLabel="Create an account"
              haptic="tap"
              onPress={() => router.replace(toHref('/sign-up'))}
              pressScale="small"
            >
              <Text variant="buttonSmall" color="primaryText">
                Create an account
              </Text>
            </Touchable>
          </Row>
        </Column>
      }
      testID="sign-in"
    >
      <Column gap="lg">
        {isMockData ? <DemoCard onExplore={roles.open} /> : null}

        {failure ? (
          // Keyed on the attempt so a second identical failure still animates —
          // otherwise a repeated wrong password looks like nothing happened.
          <Banner
            key={attempt}
            tone={failure.tone === 'danger' ? 'danger' : failure.tone === 'info' ? 'info' : 'warning'}
            title={failure.title}
            message={failure.body}
            onDismiss={() => setFailure(null)}
            dismissLabel="Dismiss this message"
          />
        ) : null}

        <Column gap="md">
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
            testID="sign-in-email"
          />

          <PasswordField
            ref={passwordRef}
            value={password}
            onChangeText={setPassword}
            onBlur={() => setTouched((prev) => ({ ...prev, password: true }))}
            error={passwordError ?? undefined}
            autoComplete="current-password"
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={submit}
            testID="sign-in-password"
            footer={
              <Row justify="end">
                <Touchable
                  accessibilityRole="link"
                  accessibilityLabel="Forgot your password"
                  accessibilityHint="Sends a reset link to your email."
                  haptic="tap"
                  onPress={() => router.push('/forgot-password')}
                  pressScale="small"
                  style={{ paddingVertical: t.spacing.xxs }}
                >
                  <Text variant="caption" color="primaryText">
                    Forgot your password?
                  </Text>
                </Touchable>
              </Row>
            }
          />
        </Column>

        <Column gap="md">
          <Button
            label="Sign in"
            onPress={submit}
            loading={pending === 'signIn'}
            disabled={busy && pending !== 'signIn'}
            size="lg"
            hero
            fullWidth
            haptic="commit"
            testID="sign-in-submit"
          />

          {quickUnlock && sensor ? (
            <Animated.View entering={FadeIn.duration(t.motion.duration.base)}>
              <Button
                label={`Use ${sensor.label}`}
                onPress={() => void onQuickUnlock()}
                // `icon` is documented as an Ionicons glyph name in lib/biometrics.
                leftIcon={sensor.icon as IconName}
                variant="secondary"
                size="md"
                fullWidth
                disabled={busy}
                accessibilityHint={`Unlocks the account remembered on this phone with ${sensor.label}.`}
              />
            </Animated.View>
          ) : biometricArmed && sensor?.available ? (
            <Row gap="xs" justify="center">
              <Icon name={sensor.icon as IconName} size="xs" color="textTertiary" />
              <Text variant="caption" color="textTertiary">
                {sensor.label} is on — you’ll only need this password once.
              </Text>
            </Row>
          ) : null}
        </Column>
      </Column>

      <Sheet
        controller={roles}
        title="Sign in as someone else"
        subtitle="Four seeded people, four different views of the same household. Access follows the person, not the app."
        scrollable
        size="tall"
      >
        <Column gap="sm">
          {DEMO_ACCOUNTS.map((account, index) => (
            <Animated.View
              key={account.email}
              entering={
                t.reduceMotion
                  ? FadeIn.duration(t.motion.duration.base)
                  : FadeInDown.duration(t.motion.duration.slow)
                      .delay(index * t.motion.stagger.base)
                      .easing(t.motion.easing.decelerate)
              }
            >
              <Touchable
                accessibilityRole="button"
                accessibilityLabel={`Sign in as ${account.name}, ${account.role}`}
                accessibilityHint={account.blurb}
                haptic="commit"
                onPress={() => signInAsDemoAccount(account)}
                pressScale="large"
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: t.spacing.md,
                  padding: t.spacing.md,
                  borderRadius: t.radius.lg,
                  backgroundColor: t.color.surfaceAlt,
                }}
              >
                <Avatar name={account.name} size="md" />
                <Column flex gap="hair">
                  <Row gap="sm">
                    <Text variant="bodyStrong" numberOfLines={1}>
                      {account.name}
                    </Text>
                    <Badge label={account.role} tone="neutral" size="sm" />
                  </Row>
                  <Text variant="footnote" color="textTertiary">
                    {account.blurb}
                  </Text>
                </Column>
                <Icon name="chevron-forward" size="sm" color="textFaint" />
              </Touchable>
            </Animated.View>
          ))}
        </Column>
      </Sheet>
    </AuthScaffold>
  );
}
