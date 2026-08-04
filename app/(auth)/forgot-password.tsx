/**
 * Forgot password — one question, then a designed answer.
 *
 * The screen deliberately never says whether an address is registered. Telling a
 * stranger "no account with that email" is an account-enumeration oracle, so the
 * success copy is phrased as a conditional ("if we know that address") and the
 * adapter resolves identically either way. That constraint is also why the
 * confirmation has to be *designed* rather than a toast: since we can't promise
 * an email arrived, the screen has to be reassuring enough that nobody taps
 * "send again" four times wondering if it worked.
 *
 * The resend cooldown exists for the same reason — a visible countdown answers
 * "did that do anything?" better than a second identical toast would.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import Animated, { FadeIn, FadeInDown, FadeOut, ZoomIn } from 'react-native-reanimated';

import { AuthScaffold } from '@/features/auth/AuthScaffold';
import haptics from '@/lib/haptics';
import { useRequestPasswordReset } from '@/data/queries/useUsers';
import { useTheme } from '@/theme';
import { Button, Column, Icon, Input, Row, Surface, Text, Touchable, type InputHandle } from '@/ui';
import { SuccessCheck } from '@/ui/illustrations';

/* ---------------------------------------------------------------- constants */

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Long enough to stop a rapid double-tap, short enough not to feel punitive. */
const RESEND_SECONDS = 30;

/* ------------------------------------------------------------------ helpers */

function emailProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'Pop in the email you signed up with.';
  if (!EMAIL_SHAPE.test(trimmed)) return 'That looks a little off — check for a missing @ or a stray dot.';
  return null;
}

/* -------------------------------------------------------------------- screen */

export default function ForgotPasswordScreen() {
  const t = useTheme();
  const router = useRouter();
  const reset = useRequestPasswordReset();

  const emailRef = useRef<InputHandle>(null);

  const [email, setEmail] = useState('');
  const [touched, setTouched] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  const error = touched ? emailProblem(email) : null;

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const send = useCallback(
    async (address: string, resend: boolean) => {
      try {
        await reset.mutateAsync(address);
        haptics.success();
        setSentTo(address);
        setCooldown(RESEND_SECONDS);
      } catch {
        // `useRequestPasswordReset` already raised the themed toast; there is
        // nothing this screen can add, and a second message would be noise.
        if (!resend) haptics.error();
      }
    },
    [reset],
  );

  const submit = useCallback(() => {
    setTouched(true);
    const bad = emailProblem(email);
    if (bad) {
      emailRef.current?.focus();
      emailRef.current?.shake();
      haptics.warn();
      return;
    }
    void send(email.trim(), false);
  }, [email, send]);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/sign-in');
  }, [router]);

  // Built per call rather than once and re-delayed: the two branches are
  // different builder classes, and a union of them is awkward to chain.
  const enter = (step: number) =>
    t.reduceMotion
      ? FadeIn.duration(t.motion.duration.base).delay(step * t.motion.stagger.tight)
      : FadeInDown.duration(t.motion.duration.slow)
          .delay(step * t.motion.stagger.loose)
          .easing(t.motion.easing.decelerate);

  /* ------------------------------------------------------------------ sent */

  if (sentTo) {
    return (
      <AuthScaffold
        brand={false}
        centerTitle
        eyebrow="On its way"
        title="Check your inbox"
        subtitle="If we know that address, there’s a link waiting to set a new password."
        showBack={false}
        footer={
          <Column gap="sm">
            <Button
              label="Back to sign in"
              onPress={leave}
              size="lg"
              hero
              fullWidth
              haptic="commit"
            />
            <Button
              label="Use a different email"
              onPress={() => {
                setSentTo(null);
                setTouched(false);
                setCooldown(0);
              }}
              variant="ghost"
              size="md"
              fullWidth
            />
          </Column>
        }
        testID="forgot-password-sent"
      >
        <Column gap="xl" align="center" style={{ paddingTop: t.spacing.lg }}>
          <Animated.View entering={ZoomIn.duration(t.motion.duration.slower).easing(t.motion.easing.overshoot)}>
            <SuccessCheck size={t.spacing.colossal * 2.4} />
          </Animated.View>

          <Animated.View entering={enter(1)}>
            <Surface variant="surfaceAlt" radius="pill" paddingX="lg" paddingY="md" border>
              <Row gap="sm">
                <Icon name="mail-open-outline" size="sm" color="primaryText" />
                <Text variant="bodyStrong" numberOfLines={1}>
                  {sentTo}
                </Text>
              </Row>
            </Surface>
          </Animated.View>

          <Animated.View entering={enter(2)} style={{ alignItems: 'center' }}>
            <Text variant="footnote" color="textSecondary" align="center">
              Links last an hour. If nothing turns up in a couple of minutes, it’s worth a look in
              the spam folder — password emails end up there more than they should.
            </Text>

            <Touchable
              accessibilityRole="button"
              accessibilityLabel={cooldown > 0 ? `Send again in ${cooldown} seconds` : 'Send the link again'}
              accessibilityState={{ disabled: cooldown > 0 || reset.isPending }}
              disabled={cooldown > 0 || reset.isPending}
              haptic="tap"
              onPress={() => void send(sentTo, true)}
              pressScale="small"
              style={{ paddingVertical: t.spacing.md, paddingHorizontal: t.spacing.md }}
            >
              <Row gap="xs">
                <Icon
                  name="refresh-outline"
                  size="xs"
                  color={cooldown > 0 ? 'textTertiary' : 'primaryText'}
                />
                <Text variant="buttonSmall" color={cooldown > 0 ? 'textTertiary' : 'primaryText'} tabular>
                  {cooldown > 0 ? `Send again in ${cooldown}s` : 'Send it again'}
                </Text>
              </Row>
            </Touchable>
          </Animated.View>
        </Column>
      </AuthScaffold>
    );
  }

  /* ------------------------------------------------------------------ form */

  return (
    <AuthScaffold
      eyebrow="No harm done"
      title="Let’s get you back in"
      subtitle="Tell us the email you signed up with and we’ll send a link to set a new password."
      footer={
        <Row gap="xs" justify="center">
          <Text variant="footnote" color="textSecondary">
            Remembered it?
          </Text>
          <Touchable
            accessibilityRole="link"
            accessibilityLabel="Back to sign in"
            haptic="tap"
            onPress={leave}
            pressScale="small"
          >
            <Text variant="buttonSmall" color="primaryText">
              Back to sign in
            </Text>
          </Touchable>
        </Row>
      }
      testID="forgot-password"
    >
      <Animated.View entering={enter(0)} exiting={FadeOut.duration(t.motion.duration.fast)}>
        <Column gap="lg">
          <Input
            ref={emailRef}
            label="Email"
            value={email}
            onChangeText={setEmail}
            onBlur={() => setTouched(true)}
            error={error ?? undefined}
            leadingIcon="mail-outline"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            textContentType="emailAddress"
            returnKeyType="send"
            onSubmitEditing={submit}
            autoFocus
            clearable
            testID="forgot-password-email"
          />

          <Button
            label="Send the reset link"
            onPress={submit}
            loading={reset.isPending}
            size="lg"
            hero
            fullWidth
            haptic="commit"
            testID="forgot-password-submit"
          />

          <Row gap="sm" align="start">
            <Icon name="lock-closed-outline" size="xs" color="textTertiary" />
            <Text variant="caption" color="textTertiary" style={{ flex: 1 }}>
              We answer the same way whether or not that address has an account — which keeps
              anyone from using this screen to find out who’s on Petal.
            </Text>
          </Row>
        </Column>
      </Animated.View>
    </AuthScaffold>
  );
}
