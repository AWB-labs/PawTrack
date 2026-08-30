/**
 * Report and block, as one attachable piece.
 *
 * Every surface that shows somebody else's words needs the same two controls,
 * and getting them subtly different on the feed, the post screen and the
 * comment thread is how an app ends up with a report flow that works in one
 * place and quietly doesn't in another. So this is a hook that owns all the
 * state and hands back one element to render:
 *
 *     const safety = useContentSafety();
 *     …
 *     <PostCard onMore={() => safety.open({ kind: 'post', … })} />
 *     {safety.element}
 *
 * Three sheets, in the order somebody actually moves through them:
 *
 *   1. **The menu.** Report, block, and — on your own content — delete. Short
 *      enough that the destructive option is never the one under your thumb by
 *      accident.
 *   2. **The reasons.** A radio list, because a report with a category is worth
 *      several times one without, and a free-text box underneath, because the
 *      category is never the whole story. Nothing is required beyond the choice.
 *   3. **The block confirmation.** Says exactly what will happen — both
 *      directions, immediately, and that we get told — because a control people
 *      are unsure about is a control they don't use when they need it.
 *
 * After a report lands, blocking is *offered* rather than assumed. Reporting a
 * stranger's cruel post and blocking a person you have to keep seeing are
 * different decisions, and the sheet that conflates them makes one of them
 * harder than it should be.
 */

import React, { useCallback, useMemo, useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { useBlockUser, useReportContent } from '@/data/queries/useModeration';
import type { ID, ReportReason, ReportTargetKind } from '@/data/types';
import { REPORT_REASON_META } from '@/data/types';
import { REVIEW_WINDOW_HOURS } from '@/features/legal/agreement';
import haptics from '@/lib/haptics';
import { useTheme } from '@/theme';
import {
  Button,
  Column,
  ConfirmSheet,
  Divider,
  Icon,
  ListRow,
  RadioButton,
  Row,
  Sheet,
  Text,
  TextArea,
  toast,
  Touchable,
  useSheet,
  type IconName,
} from '@/ui';

/* -------------------------------------------------------------------- types */

export type SafetyTarget = {
  kind: ReportTargetKind;
  id: ID;
  authorId: ID;
  authorName: string;
  /** What it said, kept with the report so a take-down is still reviewable. */
  snapshot: string;
  /** Your own content gets a delete row instead of a report row. */
  mine?: boolean;
  /** Only called for `mine` targets. The caller owns the deletion. */
  onDelete?: () => void;
  /** Called once the target is gone from this screen — pop a detail view. */
  onRemoved?: () => void;
};

export type ContentSafety = {
  open: (target: SafetyTarget) => void;
  element: ReactNode;
};

/* ---------------------------------------------------------------- constants */

const REASONS: readonly ReportReason[] = [
  'harassment',
  'hate',
  'sexual',
  'violence',
  'animalCruelty',
  'spam',
  'impersonation',
  'selfHarm',
  'other',
];

/** What a block files when the person didn't stop to pick a category. */
const BLOCK_REASON: ReportReason = 'harassment';

const DETAIL_MAX = 500;

const NOUN: Record<ReportTargetKind, string> = {
  post: 'post',
  comment: 'comment',
  user: 'account',
};

/* ---------------------------------------------------------------------- hook */

export function useContentSafety(): ContentSafety {
  const menu = useSheet();
  const reportSheet = useSheet();
  const blockSheet = useSheet();
  const offerBlock = useSheet();

  const [target, setTarget] = useState<SafetyTarget | null>(null);
  const [reason, setReason] = useState<ReportReason>('harassment');
  const [details, setDetails] = useState('');

  const report = useReportContent();
  const block = useBlockUser();

  const open = useCallback(
    (next: SafetyTarget) => {
      setTarget(next);
      setReason('harassment');
      setDetails('');
      menu.open();
    },
    [menu],
  );

  /* ---- steps ----------------------------------------------------------- */

  const startReport = useCallback(() => {
    menu.close();
    reportSheet.open();
  }, [menu, reportSheet]);

  const startBlock = useCallback(() => {
    menu.close();
    blockSheet.open();
  }, [blockSheet, menu]);

  const submitReport = useCallback(() => {
    if (!target) return;
    haptics.commit();
    reportSheet.close();

    report.mutate(
      {
        targetKind: target.kind,
        targetId: target.id,
        targetAuthorId: target.authorId,
        reason,
        details: details.trim() || null,
        snapshot: target.snapshot,
      },
      {
        onSuccess: () => {
          toast.success('Thank you — we’re on it', {
            description: `It’s out of your feed already, and a person looks at every report within ${REVIEW_WINDOW_HOURS} hours.`,
          });
          target.onRemoved?.();
          // Offered, never assumed. See the note at the top of this file.
          if (target.kind !== 'user') offerBlock.open();
        },
      },
    );
  }, [details, offerBlock, reason, report, reportSheet, target]);

  const submitBlock = useCallback(
    (withReport: boolean) => {
      if (!target) return;
      haptics.commit();

      block.mutate(
        {
          userId: target.authorId,
          // A block from a piece of content carries that content with it, so
          // the report we file names something specific rather than a person.
          ...(withReport && target.kind !== 'user'
            ? {
                reason: BLOCK_REASON,
                contextKind: target.kind,
                contextId: target.id,
                snapshot: target.snapshot,
                details: `Blocked from a ${NOUN[target.kind]}.`,
              }
            : null),
        },
        {
          onSuccess: (account) => {
            toast.success(`${account.displayName} is blocked`, {
              description: 'You won’t see each other anywhere in the community. Undo it in Settings → Safety.',
            });
            target.onRemoved?.();
          },
        },
      );
    },
    [block, target],
  );

  /* ---- element --------------------------------------------------------- */

  const element = useMemo(
    () => (
      <>
        <MenuSheet
          controller={menu}
          target={target}
          onReport={startReport}
          onBlock={startBlock}
          onDelete={() => {
            menu.close();
            target?.onDelete?.();
          }}
        />

        <ReasonSheet
          controller={reportSheet}
          target={target}
          reason={reason}
          onReason={setReason}
          details={details}
          onDetails={setDetails}
          submitting={report.isPending}
          onSubmit={submitReport}
        />

        <ConfirmSheet
          controller={blockSheet}
          title={target ? `Block ${target.authorName}?` : 'Block this account?'}
          body="You disappear from each other straight away — no posts, no comments, either direction. We’re told why, and you can undo it any time in Settings → Safety."
          confirmLabel="Block them"
          cancelLabel="Not yet"
          icon="hand-left-outline"
          onConfirm={() => submitBlock(true)}
        />

        <ConfirmSheet
          controller={offerBlock}
          title={target ? `Block ${target.authorName} too?` : 'Block them too?'}
          body="Reporting takes the content down. Blocking takes the person out of your community entirely — some people want one, some want both."
          confirmLabel="Block them as well"
          cancelLabel="Reporting was enough"
          tone="primary"
          icon="hand-left-outline"
          // Already reported; a second report of the same thing is one signal.
          onConfirm={() => submitBlock(false)}
        />
      </>
    ),
    [
      blockSheet,
      details,
      menu,
      offerBlock,
      reason,
      report.isPending,
      reportSheet,
      startBlock,
      startReport,
      submitBlock,
      submitReport,
      target,
    ],
  );

  return { open, element };
}

/* --------------------------------------------------------------------- menu */

function MenuSheet({
  controller,
  target,
  onReport,
  onBlock,
  onDelete,
}: {
  controller: ReturnType<typeof useSheet>;
  target: SafetyTarget | null;
  onReport: () => void;
  onBlock: () => void;
  onDelete: () => void;
}) {
  const t = useTheme();
  const noun = target ? NOUN[target.kind] : 'post';

  return (
    <Sheet
      controller={controller}
      title={target?.mine ? `Your ${noun}` : `This ${noun}`}
      subtitle={
        target?.mine
          ? 'Yours to take down whenever you like.'
          : `Written by ${target?.authorName ?? 'someone else'}.`
      }
      testID="safety-menu"
    >
      <Column gap="xxs" style={{ paddingBottom: t.spacing.md }}>
        {target?.mine ? (
          <ListRow
            icon="trash-outline"
            iconTone="danger"
            title={`Delete this ${noun}`}
            subtitle="Gone for everyone, and it can’t be undone."
            destructive
            chevron={false}
            onPress={onDelete}
            testID="safety-delete"
          />
        ) : (
          <>
            <ListRow
              icon="flag-outline"
              iconTone="warning"
              title={`Report this ${noun}`}
              subtitle="Tell us what’s wrong. It leaves your feed immediately."
              chevron
              onPress={onReport}
              testID="safety-report"
            />
            <ListRow
              icon="hand-left-outline"
              iconTone="danger"
              title={`Block ${target?.authorName ?? 'this account'}`}
              subtitle="You disappear from each other, both ways, right now."
              chevron
              onPress={onBlock}
              testID="safety-block"
            />
          </>
        )}
      </Column>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ reasons */

function ReasonSheet({
  controller,
  target,
  reason,
  onReason,
  details,
  onDetails,
  submitting,
  onSubmit,
}: {
  controller: ReturnType<typeof useSheet>;
  target: SafetyTarget | null;
  reason: ReportReason;
  onReason: (next: ReportReason) => void;
  details: string;
  onDetails: (next: string) => void;
  submitting: boolean;
  onSubmit: () => void;
}) {
  const t = useTheme();
  const noun = target ? NOUN[target.kind] : 'post';

  return (
    <Sheet
      controller={controller}
      size="tall"
      scrollable
      title={`Report this ${noun}`}
      subtitle="What’s wrong with it? Pick the closest one."
      footer={
        <Button
          label="Send the report"
          onPress={onSubmit}
          loading={submitting}
          size="lg"
          fullWidth
          haptic="none"
          testID="safety-report-submit"
        />
      }
      testID="safety-reasons"
    >
      <Column gap="md" style={{ paddingBottom: t.spacing.lg }}>
        <Column gap="xs">
          {REASONS.map((value) => {
            const meta = REPORT_REASON_META[value];
            return (
              <RadioButton
                key={value}
                selected={reason === value}
                onSelect={() => onReason(value)}
                label={meta.label}
                description={meta.description}
                testID={`safety-reason-${value}`}
              />
            );
          })}
        </Column>

        <Divider spacing={0} />

        <TextArea
          label="Anything else we should know?"
          helper="Optional — but it’s usually the part that helps most."
          value={details}
          onChangeText={onDetails}
          maxLength={DETAIL_MAX}
          minRows={3}
          showCounter
          testID="safety-report-details"
        />

        <Row gap="sm" align="start">
          <View style={{ paddingTop: t.spacing.hair }}>
            <Icon name="lock-closed-outline" size="xs" color="textTertiary" />
          </View>
          <Text variant="caption" color="textTertiary" style={{ flex: 1 }}>
            {`Reports are private — ${target?.authorName ?? 'the person who posted it'} is never told who reported them. A person reviews every one within ${REVIEW_WINDOW_HOURS} hours and removes anything that breaks the rules, along with the account behind it.`}
          </Text>
        </Row>
      </Column>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ trigger */

export type SafetyButtonProps = {
  onPress: () => void;
  /** Spoken label — "More options for Maya's post". */
  accessibilityLabel: string;
  icon?: IconName;
};

/**
 * The overflow control itself, so every card spells it the same way. Deliberately
 * quiet: it is not an action anybody is looking for until the moment they are,
 * and a loud one on every row makes a friendly feed look like a moderation
 * console.
 */
export function SafetyButton({
  onPress,
  accessibilityLabel,
  icon = 'ellipsis-horizontal',
}: SafetyButtonProps) {
  const t = useTheme();

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="Opens reporting and blocking."
      haptic="tap"
      onPress={onPress}
      pressScale="small"
      style={{
        width: t.spacing.xl + t.spacing.xs,
        height: t.spacing.xl + t.spacing.xs,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon name={icon} size="sm" color="textTertiary" />
    </Touchable>
  );
}

export default useContentSafety;
