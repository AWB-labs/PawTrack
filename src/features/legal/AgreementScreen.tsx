/**
 * The agreement.
 *
 * One component, mounted in two places, because the App Store's requirement has
 * two halves and both have to be true at once:
 *
 *   · `app/(auth)/agreement` — reached from the welcome screen, *before* either
 *     the sign-up or the sign-in form. This is the "presented before registering
 *     or logging in" half, and it is the screen a review recording shows.
 *   · `app/(legal)/accept-terms` — the router's post-authentication gate, for the
 *     accounts that already existed when the terms landed, or that were created
 *     against an older version. Same screen, different button, no way past it.
 *
 * Three things it refuses to do, all of them deliberate:
 *
 *   · **It does not pre-tick the box.** Consent that arrives already given is
 *     not consent, and a reviewer looking for the control will look for it
 *     unticked.
 *   · **It does not let you scroll past the rules to the button.** The action
 *     bar is pinned, but the checkbox that arms it sits underneath the last
 *     rule, so the rules pass under your thumb on the way to agreeing.
 *   · **It does not bury the consequence.** The zero-tolerance clause is the
 *     first rule and is written in the same size as everything else, rather
 *     than as small print below the fold.
 *
 * `onDecline` is a real path, not a courtesy. Somebody who does not want these
 * terms should be able to leave without an account, and on the gate they are
 * signed out rather than trapped on a screen with one button.
 */

import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { openExternal } from '@/lib/deeplinks';
import haptics from '@/lib/haptics';
import { useTheme } from '@/theme';
import {
  Button,
  Checkbox,
  Column,
  Divider,
  Icon,
  Row,
  Screen,
  ScreenHeader,
  Surface,
  Text,
  Touchable,
  type IconName,
} from '@/ui';
import {
  AGREEMENT_CONSENT,
  AGREEMENT_CONSEQUENCE,
  AGREEMENT_SUMMARY,
  COMMUNITY_RULES,
  LEGAL_URLS,
  REVIEW_PROMISE,
  TERMS_EFFECTIVE,
} from './agreement';

/* -------------------------------------------------------------------- types */

export type AgreementScreenProps = {
  /** Header copy. The gate and the pre-sign-up screen say different things. */
  title: string;
  subtitle: string;
  confirmLabel: string;
  declineLabel: string;
  /** Called once the box is ticked and the button pressed. */
  onAgree: () => void;
  onDecline: () => void;
  busy?: boolean;
  showBack?: boolean;
  onBack?: () => void;
  testID?: string;
};

/* ---------------------------------------------------------------- component */

export function AgreementScreen({
  title,
  subtitle,
  confirmLabel,
  declineLabel,
  onAgree,
  onDecline,
  busy = false,
  showBack = false,
  onBack,
  testID = 'agreement',
}: AgreementScreenProps) {
  const t = useTheme();
  const [agreed, setAgreed] = useState(false);
  const [nudged, setNudged] = useState(false);

  const confirm = useCallback(() => {
    if (!agreed) {
      // The button stays pressable so it can explain itself — same contract as
      // the rest of the library. Pressing it un-ticked paints the box red and
      // says why, rather than doing nothing and leaving you to guess.
      setNudged(true);
      haptics.warn();
      return;
    }
    haptics.commit();
    onAgree();
  }, [agreed, onAgree]);

  const enter = useCallback(
    (index: number) =>
      t.reduceMotion
        ? FadeIn.duration(t.motion.duration.base).delay(index * t.motion.stagger.tight)
        : FadeInDown.duration(t.motion.duration.slow)
            .delay(index * t.motion.stagger.base)
            .easing(t.motion.easing.decelerate),
    [t.motion, t.reduceMotion],
  );

  return (
    <Screen
      header={<ScreenHeader title={title} subtitle={subtitle} showBack={showBack} onBack={onBack} />}
      scroll
      contentContainerStyle={{ gap: t.spacing.lg, paddingBottom: t.spacing.xxl }}
      footer={
        <Column gap="sm">
          <Button
            label={confirmLabel}
            onPress={confirm}
            loading={busy}
            size="lg"
            hero
            fullWidth
            haptic="none"
            accessibilityHint={
              agreed ? undefined : 'Tick the box above first — we need your agreement on the record.'
            }
            testID={`${testID}-agree`}
          />
          <Button
            label={declineLabel}
            onPress={onDecline}
            variant="ghost"
            size="md"
            fullWidth
            testID={`${testID}-decline`}
          />
        </Column>
      }
      testID={testID}
    >
      <Animated.View entering={enter(0)}>
        <Text variant="callout" color="textSecondary">
          {AGREEMENT_SUMMARY}
        </Text>
      </Animated.View>

      <Column gap="md">
        {COMMUNITY_RULES.map((rule, index) => (
          <Animated.View key={rule.key} entering={enter(index + 1)}>
            <Rule icon={rule.icon as IconName} title={rule.title} body={rule.body} />
          </Animated.View>
        ))}
      </Column>

      <Animated.View entering={enter(COMMUNITY_RULES.length + 1)}>
        <Surface variant="surfaceAlt" radius="lg" padding="md" elevation={0} border>
          <Row gap="sm" align="start">
            <Icon name="time-outline" size="sm" color="primaryText" />
            <Text variant="footnote" color="textSecondary" style={{ flex: 1 }}>
              {REVIEW_PROMISE}
            </Text>
          </Row>
        </Surface>
      </Animated.View>

      <Divider spacing={0} />

      <Animated.View entering={enter(COMMUNITY_RULES.length + 2)}>
        <Column gap="md">
          <Checkbox
            checked={agreed}
            onChange={(next) => {
              setAgreed(next);
              if (next) setNudged(false);
            }}
            label={AGREEMENT_CONSENT}
            description={AGREEMENT_CONSEQUENCE}
            invalid={nudged && !agreed}
            accessibilityLabel={`${AGREEMENT_CONSENT} ${AGREEMENT_CONSEQUENCE}`}
            testID={`${testID}-consent`}
          />

          {nudged && !agreed ? (
            <Text variant="footnote" color="danger">
              We need this one before you can go on — it’s the agreement itself, not a formality.
            </Text>
          ) : null}

          <Row gap="md" justify="center" style={{ paddingTop: t.spacing.xxs }}>
            <LegalLink label="Terms of Use" url={LEGAL_URLS.terms} />
            <Text variant="caption" color="textFaint">
              ·
            </Text>
            <LegalLink label="Community Rules" url={LEGAL_URLS.guidelines} />
            <Text variant="caption" color="textFaint">
              ·
            </Text>
            <LegalLink label="Privacy" url={LEGAL_URLS.privacy} />
          </Row>

          <Text variant="caption" color="textFaint" align="center">
            In effect since {TERMS_EFFECTIVE}.
          </Text>
        </Column>
      </Animated.View>
    </Screen>
  );
}

/* --------------------------------------------------------------------- rule */

function Rule({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  const t = useTheme();

  return (
    <Surface variant="surface" radius="lg" padding="base" elevation={0} border>
      <Row gap="md" align="start">
        <View
          style={{
            width: t.spacing.xl + t.spacing.xs,
            height: t.spacing.xl + t.spacing.xs,
            borderRadius: t.radius.md,
            backgroundColor: t.color.primarySoft,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name={icon} size="sm" color="onPrimarySoft" />
        </View>
        <Column flex gap="xxs">
          <Text variant="bodyStrong">{title}</Text>
          <Text variant="footnote" color="textSecondary">
            {body}
          </Text>
        </Column>
      </Row>
    </Surface>
  );
}

function LegalLink({ label, url }: { label: string; url: string }) {
  return (
    <Touchable
      accessibilityRole="link"
      accessibilityLabel={`Read the ${label.toLowerCase()}`}
      accessibilityHint="Opens in your browser."
      haptic="tap"
      onPress={() => void openExternal(url)}
      pressScale="small"
    >
      <Text variant="caption" color="primaryText">
        {label}
      </Text>
    </Touchable>
  );
}

export default AgreementScreen;
