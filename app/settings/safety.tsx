/**
 * Settings — Safety.
 *
 * The place the two community controls become undoable and inspectable. Apple's
 * Guideline 1.2 asks for a way to block; a way to *unblock*, and a record of
 * what you reported and where it got to, is what turns that from a trapdoor
 * into a setting.
 *
 * Three things it says out loud rather than implying:
 *
 *   · **What blocking actually did.** Both directions, everywhere, and reversible
 *     from this row. People hesitate over controls they can't picture undoing.
 *   · **Where a report went.** Open, actioned, or dismissed — with the promise
 *     it was made under restated at the top, because a queue you can see is the
 *     only version of "we're on it" worth printing.
 *   · **How to reach a person.** The wordlist and the report queue between them
 *     miss things, and the address for what they miss belongs on this screen
 *     rather than three taps into a policy page.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { useBlockedAccounts, useMyReports, useUnblockUser } from '@/data/queries/useModeration';
import type { BlockedAccount, ContentReport, ReportStatus } from '@/data/types';
import { REPORT_REASON_META } from '@/data/types';
import { SettingsGroup } from '@/features/settings/SettingsGroup';
import { SettingsRow } from '@/features/settings/SettingsRow';
import {
  LEGAL_URLS,
  REVIEW_WINDOW_HOURS,
  SAFETY_ADDRESS,
} from '@/features/legal/agreement';
import { relativeTime } from '@/lib/date';
import { composeEmail, openExternal } from '@/lib/deeplinks';
import { useTheme } from '@/theme';
import {
  Avatar,
  Badge,
  Button,
  Column,
  ConfirmSheet,
  EmptyState,
  Icon,
  ListRow,
  Row,
  Screen,
  ScreenHeader,
  SkeletonGroup,
  Surface,
  Text,
  useSheet,
  type IconName,
} from '@/ui';
import { ListRowSkeleton } from '@/ui/skeletons/ContentSkeletons';

/* ---------------------------------------------------------------- constants */

const STATUS_META: Record<ReportStatus, { label: string; tone: 'warning' | 'success' | 'neutral' }> =
  {
    open: { label: 'With us', tone: 'warning' },
    actioned: { label: 'Acted on', tone: 'success' },
    dismissed: { label: 'Reviewed', tone: 'neutral' },
  };

/** Past this the list is a history rather than a status, and belongs elsewhere. */
const REPORTS_SHOWN = 10;

/* ---------------------------------------------------------------- component */

export default function SafetySettingsScreen() {
  const t = useTheme();

  const blocked = useBlockedAccounts();
  const reports = useMyReports();
  const unblock = useUnblockUser();
  const confirmUnblock = useSheet();

  const [pending, setPending] = useState<BlockedAccount | null>(null);

  const accounts = useMemo(() => blocked.data ?? [], [blocked.data]);
  const filed = useMemo(() => (reports.data ?? []).slice(0, REPORTS_SHOWN), [reports.data]);
  const open = useMemo(() => filed.filter((row) => row.status === 'open').length, [filed]);

  const askUnblock = useCallback(
    (account: BlockedAccount) => {
      setPending(account);
      confirmUnblock.open();
    },
    [confirmUnblock],
  );

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
      header={
        <ScreenHeader
          title="Safety"
          subtitle="Who you’ve blocked, what you’ve reported, and what happens next."
        />
      }
      scroll
      contentContainerStyle={{ gap: t.spacing.xl, paddingBottom: t.spacing.xxl }}
    >
      <Animated.View entering={enter(0)}>
        <ReviewPromise />
      </Animated.View>

      {/* ------------------------------------------------------------ blocks */}

      <Animated.View entering={enter(1)}>
        <SettingsGroup
          title="Blocked accounts"
          icon="hand-left-outline"
          animate={false}
          footer={
            accounts.length > 0
              ? 'Blocking works both ways. Neither of you sees the other’s posts or comments anywhere in the community.'
              : undefined
          }
        >
          {blocked.isPending ? (
            <View style={{ padding: t.spacing.base }}>
              <SkeletonGroup label="Loading blocked accounts">
                <ListRowSkeleton count={2} avatar />
              </SkeletonGroup>
            </View>
          ) : accounts.length === 0 ? (
            <View style={{ padding: t.spacing.base }}>
              <Text variant="footnote" color="textSecondary">
                Nobody. If that changes, the block control is on every post and every comment —
                tap the ⋯ and it’s the second row.
              </Text>
            </View>
          ) : (
            accounts.map((account) => (
              <ListRow
                key={account.userId}
                leading={<Avatar uri={account.avatarUrl} name={account.displayName} size="sm" />}
                title={account.displayName}
                subtitle={`Blocked ${relativeTime(account.blockedAt)}`}
                trailing={
                  <Button
                    label="Unblock"
                    variant="ghost"
                    size="sm"
                    onPress={() => askUnblock(account)}
                    accessibilityHint={`Lets ${account.displayName} see your posts again, and you theirs.`}
                  />
                }
                accessibilityLabel={`${account.displayName}, blocked ${relativeTime(account.blockedAt)}`}
              />
            ))
          )}
        </SettingsGroup>
      </Animated.View>

      {/* ----------------------------------------------------------- reports */}

      <Animated.View entering={enter(2)}>
        <SettingsGroup
          title="Reports you’ve filed"
          icon="flag-outline"
          animate={false}
          footer={
            open > 0
              ? `${open === 1 ? 'One is' : `${open} are`} with our safety team. We answer every report within ${REVIEW_WINDOW_HOURS} hours.`
              : undefined
          }
        >
          {reports.isPending ? (
            <View style={{ padding: t.spacing.base }}>
              <SkeletonGroup label="Loading your reports">
                <ListRowSkeleton count={2} />
              </SkeletonGroup>
            </View>
          ) : filed.length === 0 ? (
            <View style={{ padding: t.spacing.base }}>
              <EmptyState
                variant="compact"
                headline="Nothing reported"
                body={`If something crosses the line, the flag is on every post and comment. We look at each one within ${REVIEW_WINDOW_HOURS} hours.`}
              />
            </View>
          ) : (
            filed.map((report) => <ReportRow key={report.id} report={report} />)
          )}
        </SettingsGroup>
      </Animated.View>

      {/* ------------------------------------------------------------- rules */}

      <Animated.View entering={enter(3)}>
        <SettingsGroup
          title="The rules, and us"
          icon="document-text-outline"
          animate={false}
          footer="Zero tolerance means what it says: objectionable content is removed and the account behind it is ejected."
        >
          <SettingsRow
            icon="people-outline"
            tone="primary"
            title="Community rules"
            subtitle="What’s allowed here, and what ends an account"
            accessibilityHint="Opens the community rules in your browser."
            onPress={() => void openExternal(LEGAL_URLS.guidelines)}
          />
          <SettingsRow
            icon="reader-outline"
            tone="neutral"
            title="Terms of Use"
            subtitle="The agreement you accepted when you joined"
            accessibilityHint="Opens the terms in your browser."
            onPress={() => void openExternal(LEGAL_URLS.terms)}
          />
          <SettingsRow
            icon="mail-outline"
            tone="accent"
            title="Email our safety team"
            subtitle={SAFETY_ADDRESS}
            accessibilityHint="Opens your mail app with a message started."
            onPress={() => void composeEmail(SAFETY_ADDRESS, 'Petal — safety')}
          />
        </SettingsGroup>
      </Animated.View>

      <ConfirmSheet
        controller={confirmUnblock}
        title={pending ? `Unblock ${pending.displayName}?` : 'Unblock this account?'}
        body="You’ll start seeing each other’s posts and comments again. You can block them again whenever you like."
        confirmLabel="Unblock"
        cancelLabel="Keep them blocked"
        tone="primary"
        icon="hand-left-outline"
        onConfirm={() => {
          if (pending) unblock.mutate(pending.userId);
        }}
      />
    </Screen>
  );
}

/* ------------------------------------------------------------------ promise */

function ReviewPromise() {
  const t = useTheme();

  return (
    <Surface variant="surfaceAlt" radius="xl" padding="base" elevation={0} border>
      <Row gap="md" align="start">
        <View
          style={{
            width: t.spacing.xxl,
            height: t.spacing.xxl,
            borderRadius: t.radius.pill,
            backgroundColor: t.color.successSoft,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="shield-checkmark-outline" size="sm" color="onSuccessSoft" />
        </View>
        <Column flex gap="xxs">
          <Text variant="bodyStrong">Reports reach a person within {REVIEW_WINDOW_HOURS} hours</Text>
          <Text variant="footnote" color="textSecondary">
            Anything you report leaves your feed the moment you report it. If it breaks the rules,
            it comes down for everyone and the account that posted it is removed.
          </Text>
        </Column>
      </Row>
    </Surface>
  );
}

/* ------------------------------------------------------------------- report */

function ReportRow({ report }: { report: ContentReport }) {
  const meta = REPORT_REASON_META[report.reason];
  const status = STATUS_META[report.status];
  const noun = report.targetKind === 'user' ? 'an account' : `a ${report.targetKind}`;

  return (
    <ListRow
      icon={meta.icon as IconName}
      iconTone={report.status === 'open' ? 'warning' : 'neutral'}
      title={meta.label}
      subtitle={`You reported ${noun} · ${relativeTime(report.createdAt)}`}
      trailing={<Badge label={status.label} tone={status.tone} size="sm" />}
      accessibilityLabel={`${meta.label}. You reported ${noun} ${relativeTime(report.createdAt)}. ${status.label}.`}
    />
  );
}
