/**
 * Settings — About.
 *
 * The page most apps fill with a version number and a link to a marketing site.
 * This one tries to be useful instead, and the useful thing here is *honesty
 * about which backend answered*: Petal runs on a seeded offline demo household
 * when there are no Supabase credentials, and someone wondering why their edit
 * didn't reach a colleague deserves to find that out in one tap rather than
 * three days later.
 *
 * Two details worth knowing:
 *
 *   · **"Reset demo data" is guarded on the capability, not on a flag.**
 *     `resetDemoData` is optional on the adapter interface — Supabase doesn't
 *     have one — so the row appears only when the method genuinely exists.
 *   · **Build details are copyable.** `lib/errors.ts` tells people to "tell us
 *     from Settings › About" when something goes sideways; that instruction only
 *     works if this screen hands them something worth pasting.
 *
 * Credits are here because the app is made almost entirely of other people's
 * work, and the licences are the terms that work was given under.
 */

import * as Clipboard from 'expo-clipboard';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { useQueryClient } from '@tanstack/react-query';

import { adapter, describeDataSource } from '@/data';
import { SettingsGroup } from '@/features/settings/SettingsGroup';
import { SettingsRow } from '@/features/settings/SettingsRow';
import { composeEmail } from '@/lib/deeplinks';
import { logError } from '@/lib/errors';
import haptics from '@/lib/haptics';
import { useSession } from '@/stores/session';
import { useTheme } from '@/theme';
import {
  Badge,
  Banner,
  Column,
  ConfirmSheet,
  Divider,
  PawPrint,
  Row,
  Screen,
  ScreenHeader,
  Sheet,
  SheetHeader,
  Surface,
  Text,
  toast,
  useSheet,
} from '@/ui';

/* ---------------------------------------------------------------- constants */

const APP_NAME = Constants.expoConfig?.name ?? 'Petal';
const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';

/** Where feedback goes. Matches the web origin the invite links already use. */
const FEEDBACK_ADDRESS = 'hello@petal.app';

type Credit = { name: string; role: string; licence: string };

/**
 * The pieces Petal is built from, and the terms they were given under. Kept
 * hand-written rather than generated: a list nobody reads is worse than no
 * list, and the *role* column is the part that makes it readable.
 */
const CREDITS: readonly Credit[] = [
  { name: 'React Native', role: 'The app itself, on both phones', licence: 'MIT' },
  { name: 'Expo SDK 54', role: 'Camera, notifications, biometrics, fonts', licence: 'MIT' },
  { name: 'Expo Router', role: 'Every screen you can navigate to', licence: 'MIT' },
  { name: 'Reanimated', role: 'Everything that springs, fades or follows a finger', licence: 'MIT' },
  { name: 'Gesture Handler', role: 'Swipes, drags and pull-to-refresh', licence: 'MIT' },
  { name: '@gorhom/bottom-sheet', role: 'Every sheet that rises from the bottom', licence: 'MIT' },
  { name: 'TanStack Query', role: 'Keeping your pets’ records in sync', licence: 'MIT' },
  { name: 'Zustand', role: 'Preferences and session state', licence: 'MIT' },
  { name: 'date-fns', role: 'Every “due Friday” and “two hours ago”', licence: 'MIT' },
  { name: 'react-native-svg', role: 'Charts, rings and the illustrations', licence: 'MIT' },
  { name: 'Ionicons', role: 'Every glyph in the app', licence: 'MIT' },
  { name: 'supabase-js', role: 'The live backend, when one is configured', licence: 'MIT' },
  { name: 'Fraunces', role: 'The headline typeface', licence: 'SIL Open Font License 1.1' },
  { name: 'Plus Jakarta Sans', role: 'Everything else you read', licence: 'SIL Open Font License 1.1' },
];

/* ------------------------------------------------------------------ helpers */

/** "Expo Go 54.0.0" / "Standalone build" — what actually ran this code. */
function describeRuntime(): string {
  switch (Constants.executionEnvironment) {
    case ExecutionEnvironment.StoreClient:
      return Constants.expoVersion ? `Expo Go ${Constants.expoVersion}` : 'Expo Go';
    case ExecutionEnvironment.Standalone:
      return 'Standalone build';
    default:
      return 'Development build';
  }
}

/* ---------------------------------------------------------------- component */

export default function AboutScreen() {
  const t = useTheme();
  const client = useQueryClient();
  const refreshMemberships = useSession((s) => s.refreshMemberships);

  const creditsSheet = useSheet();
  const resetSheet = useSheet();
  const [resetting, setResetting] = useState(false);

  const source = useMemo(() => describeDataSource(), []);
  const runtime = useMemo(() => describeRuntime(), []);

  const buildDetails = useMemo(
    () =>
      [
        `${APP_NAME} ${APP_VERSION}`,
        `Runtime: ${runtime}`,
        `Data: ${source.label}`,
        source.fallbackReason ? `Fallback: ${source.fallbackReason}` : null,
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
    [runtime, source.fallbackReason, source.label],
  );

  const copyBuildDetails = useCallback(() => {
    void Clipboard.setStringAsync(buildDetails).then(() => {
      haptics.success();
      toast.success('Copied', {
        description: 'Paste it into your message and we’ll know exactly what you were running.',
      });
    });
  }, [buildDetails]);

  const emailUs = useCallback(() => {
    void composeEmail(FEEDBACK_ADDRESS, `${APP_NAME} ${APP_VERSION} — feedback`).then((opened) => {
      if (opened) return;
      // No mail client is a real state on a fresh simulator; say so rather than
      // letting the tap do nothing.
      toast.info('No mail app on this phone', {
        description: `Write to ${FEEDBACK_ADDRESS} from wherever you read your email.`,
      });
    });
  }, []);

  const resetDemo = useCallback(async () => {
    if (resetting) return;
    setResetting(true);
    try {
      // Optional on the interface — Supabase has no such thing — so the call is
      // guarded even though the row that reaches it is guarded too.
      await adapter.resetDemoData?.();
      await refreshMemberships();
      // The seed mints brand-new ids, so patching the cache is meaningless;
      // clearing it is the only reconciliation that tells the truth.
      client.clear();
      haptics.success();
      toast.success('Demo household restored', {
        description: 'Every pet, schedule and log is back to the way it shipped.',
      });
    } catch (error) {
      logError('settings.resetDemoData', error);
      haptics.error();
      toast.error('That reset didn’t finish', {
        description: 'Nothing was half-written — try it once more.',
      });
    } finally {
      setResetting(false);
    }
  }, [client, refreshMemberships, resetting]);

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
    <ScreenHeader title="About" subtitle="What you’re running, and what it’s made of." />
  );

  return (
    <Screen
      header={header}
      scroll
      contentContainerStyle={{ gap: t.spacing.xl, paddingBottom: t.spacing.xxl }}
    >
      <Animated.View entering={enter(0)}>
        <AppMark version={APP_VERSION} runtime={runtime} />
      </Animated.View>

      {source.fallbackReason ? (
        <Animated.View entering={FadeIn.duration(t.motion.duration.base)}>
          <Banner
            tone="warning"
            icon="cloud-offline-outline"
            title="Petal fell back to the demo household"
            message={`Your Supabase details didn’t load, so nothing you change here is leaving this phone. ${source.fallbackReason}`}
          />
        </Animated.View>
      ) : null}

      <Animated.View entering={enter(1)}>
        <SettingsGroup
          title="This build"
          icon="hardware-chip-outline"
          animate={false}
          footer={source.detail}
        >
          <SettingsRow
            icon="pricetag-outline"
            tone="neutral"
            title="Version"
            subtitle={runtime}
            value={APP_VERSION}
          />
          <SettingsRow
            icon={source.mode === 'mock' ? 'flask-outline' : 'cloud-done-outline'}
            tone={source.mode === 'mock' ? 'warning' : 'success'}
            title="Data source"
            subtitle={
              source.mode === 'mock'
                ? 'Everything you change stays on this device'
                : 'Changes sync to everyone who shares a pet with you'
            }
            value={source.label}
          />
          <SettingsRow
            icon="copy-outline"
            tone="info"
            title="Copy build details"
            subtitle="Worth pasting into any message you send us"
            chevron={false}
            accessibilityHint="Copies the version, runtime and data source to the clipboard."
            onPress={copyBuildDetails}
          />
        </SettingsGroup>
      </Animated.View>

      {source.canResetDemoData ? (
        <Animated.View entering={enter(2)}>
          <SettingsGroup
            title="Demo data"
            icon="flask-outline"
            animate={false}
            footer="Only here because Petal is running its offline demo. Connect a Supabase project and this row disappears — there’d be nothing safe to reset."
          >
            <SettingsRow
              icon="refresh-outline"
              tone="warning"
              title="Reset the demo household"
              subtitle="Puts every pet, schedule and log back the way it shipped"
              value={resetting ? 'Resetting…' : undefined}
              chevron={false}
              accessibilityHint="Asks you to confirm first."
              onPress={() => resetSheet.open()}
            />
          </SettingsGroup>
        </Animated.View>
      ) : null}

      <Animated.View entering={enter(3)}>
        <SettingsGroup
          title="Credits"
          icon="heart-outline"
          animate={false}
          footer="Petal is made almost entirely of work other people gave away. The least it can do is say so."
        >
          <SettingsRow
            icon="library-outline"
            tone="accent"
            title="Open source and licences"
            subtitle={`${CREDITS.length} pieces, and the terms each was given under`}
            accessibilityHint="Opens the full list."
            onPress={() => creditsSheet.open()}
          />
          <SettingsRow
            icon="mail-outline"
            tone="primary"
            title="Email the team"
            subtitle={FEEDBACK_ADDRESS}
            chevron={false}
            accessibilityHint="Opens your mail app with a new message."
            onPress={emailUs}
          />
        </SettingsGroup>
      </Animated.View>

      <Animated.View entering={enter(4)}>
        <Column gap="sm" align="center" style={{ paddingTop: t.spacing.sm }}>
          <PawPrint size={t.spacing.xxl} color={t.color.textFaint} />
          <Text variant="footnote" color="textTertiary" align="center">
            Made for the people who keep an animal fed, dosed and cheerful on an ordinary Tuesday.
          </Text>
        </Column>
      </Animated.View>

      <ConfirmSheet
        controller={resetSheet}
        tone="primary"
        icon="refresh-outline"
        title="Reset the demo household?"
        body="Every pet, caregiver, schedule and log goes back to the seeded set. Anything you’ve added while exploring is lost — which is rather the point of a demo."
        confirmLabel="Reset it"
        cancelLabel="Leave it as it is"
        onConfirm={() => resetDemo()}
      />

      <Sheet controller={creditsSheet} size="tall" scrollable>
        <SheetHeader
          title="Open source and licences"
          subtitle="Every piece below is used under its own licence, unmodified unless noted."
          onClose={creditsSheet.close}
        />
        <Column gap="base">
          {CREDITS.map((credit, index) => (
            <View key={credit.name}>
              {index === 0 ? null : <Divider spacing={t.spacing.md} />}
              <Row gap="md" align="start">
                <Column flex gap="hair">
                  <Text variant="bodyStrong">{credit.name}</Text>
                  <Text variant="footnote" color="textTertiary">
                    {credit.role}
                  </Text>
                </Column>
                <Badge
                  label={credit.licence === 'MIT' ? 'MIT' : 'OFL 1.1'}
                  tone={credit.licence === 'MIT' ? 'neutral' : 'accent'}
                  size="sm"
                  accessibilityLabel={credit.licence}
                />
              </Row>
            </View>
          ))}
          <Text variant="caption" color="textTertiary" style={{ paddingTop: t.spacing.sm }}>
            Full licence texts ship with each package. MIT and the SIL Open Font License both
            allow use and redistribution provided the notices stay with the work — which is what
            this page is.
          </Text>
        </Column>
      </Sheet>
    </Screen>
  );
}

/* ------------------------------------------------------------------ mark */

function AppMark({ version, runtime }: { version: string; runtime: string }) {
  const t = useTheme();
  const tile = t.spacing.giant;
  const wash: readonly [string, string] = [t.color.primary, t.color.primaryHover];

  return (
    <Surface variant="surface" elevation={1} radius="xxl" padding="lg">
      <Row gap="base">
        <View style={{ width: tile, height: tile, borderRadius: t.radius.xl, overflow: 'hidden' }}>
          <LinearGradient
            colors={wash}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
          >
            <PawPrint size={tile * 0.5} color={t.color.onPrimary} />
          </LinearGradient>
        </View>

        <Column flex gap="xxs">
          <Text variant="title2">{APP_NAME}</Text>
          <Text variant="footnote" color="textTertiary">
            Version {version} · {runtime}
          </Text>
          <Text variant="caption" color="textFaint">
            Pet care that two people can share without treading on each other.
          </Text>
        </Column>
      </Row>
    </Surface>
  );
}
