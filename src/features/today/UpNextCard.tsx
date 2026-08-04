/**
 * Petal — UpNextCard.
 *
 * The single next thing, given a whole card to itself.
 *
 * A list is the right shape for a day and the wrong shape for a moment. Most
 * times you open Petal there is exactly one thing you're here to do, and making
 * you find it in a list of eleven is the difference between an app you use and
 * an app you check. So the next thing gets the pet's face at 80pt, a live
 * countdown, and a button big enough to hit while holding a lead.
 *
 * Notes:
 *   · **The countdown is honest and live.** It reads the app's shared 30-second
 *     clock (`useNow`) rather than owning a timer, so "in 25 minutes" becomes
 *     "Due right now" becomes "Running 40m late" without a refresh.
 *   · **The wash is the pet's own colour**, drawn from `speciesColor`, so the
 *     card belongs to Buddy before you've read his name — and it stays a
 *     *gradient over a surface* rather than text over a photo, because ink on a
 *     photograph can't be contrast-guaranteed in both schemes.
 *   · **Completion runs through `useTaskCompletion`**, exactly like a row, so
 *     the optimistic patch, the undo toast and the caches all behave the same
 *     whichever surface you tapped.
 */

import React, { useCallback } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import type { CareTask, Pet } from '@/data/types';
import { countdownLabel, formatClock, minutesUntil } from '@/lib/date';
import { possessive } from '@/lib/format';
import haptics from '@/lib/haptics';
import { useNow } from '@/rbac/usePermission';
import { useTheme } from '@/theme';
import {
  Avatar,
  Badge,
  Button,
  Column,
  Row,
  Surface,
  Text,
  Touchable,
  confetti,
  type BadgeTone,
} from '@/ui';
import { KIND_DONE_ACTION, KIND_SKIP_LABEL, latenessLabel, useTaskCompletion } from './TaskRow';

/* -------------------------------------------------------------------- types */

export type UpNextCardProps = {
  task: CareTask;
  /** Undefined only while the household is still loading. */
  pet: Pet | undefined;
  /** True when finishing this one finishes the day. */
  celebrateOnComplete?: boolean;
  onOpen?: (task: CareTask) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

type Urgency = { label: string; tone: BadgeTone };

/* ------------------------------------------------------------------ helpers */

function urgencyFor(task: CareTask): Urgency {
  if (task.state === 'overdue') return { label: 'Overdue', tone: 'danger' };
  if (task.state === 'due') return { label: 'Due now', tone: 'accent' };
  return { label: 'Coming up', tone: 'primary' };
}

/** "Due in 25 minutes" · "Due right now" · "Running 40m late". */
function countdownFor(task: CareTask, now: Date): string {
  if (task.state === 'overdue') {
    const late = latenessLabel(task.at, now);
    return late ? `Running ${late}` : 'Overdue';
  }
  const minutes = minutesUntil(task.at, now);
  if (minutes === null) return `At ${formatClock(task.at)}`;
  if (minutes <= 0) return 'Due right now';
  return `Due ${countdownLabel(minutes)}`;
}

/* ---------------------------------------------------------------- component */

export function UpNextCard({
  task,
  pet,
  celebrateOnComplete = false,
  onOpen,
  style,
  testID,
}: UpNextCardProps) {
  const t = useTheme();
  const now = useNow();

  const petName = pet?.name ?? 'your pet';
  const action = useTaskCompletion(task, petName);

  const identity = pet ? t.speciesColor(pet.species) : null;
  const urgency = urgencyFor(task);
  const countdown = countdownFor(task, now);

  const complete = useCallback(async () => {
    if (!action.allowed) {
      action.explain();
      return;
    }
    const landed = await action.complete();
    if (!landed) return;
    haptics.success();
    if (celebrateOnComplete) confetti.fire({ power: 1.2 });
  }, [action, celebrateOnComplete]);

  const skip = useCallback(async () => {
    if (!action.allowed) {
      action.explain();
      return;
    }
    const landed = await action.skip();
    if (landed) haptics.soft();
  }, [action]);

  return (
    <Surface
      elevation={2}
      radius="xxl"
      padding="base"
      style={[styles.clip, { gap: t.spacing.base }, style]}
      testID={testID}
    >
      <LinearGradient
        colors={[identity?.tint ?? t.color.primarySoft, t.color.surface]}
        start={GRADIENT_START}
        end={GRADIENT_END}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      <Touchable
        accessibilityRole={onOpen ? 'button' : 'text'}
        accessibilityLabel={`Up next: ${task.title} at ${formatClock(task.at)}. ${countdown}.`}
        accessibilityHint={onOpen ? `Opens ${possessive(petName)} full record.` : undefined}
        haptic="tap"
        onPress={onOpen ? () => onOpen(task) : undefined}
        pressScale="subtle"
      >
        <Row gap="base" align="start">
          <Avatar uri={pet?.photoUrl} name={pet?.name} species={pet?.species} size="xl" ring />

          <Column flex gap="xxs">
            <Row gap="sm">
              <Text variant="overline" color="textTertiary">
                Up next
              </Text>
              <Badge label={urgency.label} tone={urgency.tone} size="sm" />
            </Row>

            <Text variant="title2" numberOfLines={2}>
              {task.title}
            </Text>

            <Text variant="callout" color="textSecondary" numberOfLines={2}>
              {task.subtitle}
            </Text>

            <Row gap="xs" style={{ paddingTop: t.spacing.xxs }}>
              <Text variant="subheadStrong" color={task.state === 'overdue' ? 'danger' : 'accentText'}>
                {countdown}
              </Text>
              <Text variant="subhead" color="textTertiary">
                · {formatClock(task.at)}
              </Text>
            </Row>
          </Column>
        </Row>
      </Touchable>

      {/* Owner-only work is hidden outright rather than dangled — see the RBAC
          rule. Everything else stays visible and explains itself on tap. */}
      {action.hidden ? null : (
        <Row gap="sm">
          <Button
            label={KIND_DONE_ACTION[task.kind]}
            leftIcon="checkmark"
            onPress={() => {
              void complete();
            }}
            variant="primary"
            size="lg"
            hero
            haptic="commit"
            loading={action.busy}
            // Only a genuinely un-actionable control is `disabled` — a denial has
            // to stay pressable or it can never explain itself.
            disabled={action.allowed && !action.ready}
            disabledReason={action.disabledReason}
            style={styles.grow}
            accessibilityHint={`Logs ${possessive(petName)} ${task.kind} for ${formatClock(task.at)}.`}
          />
          <Button
            label={KIND_SKIP_LABEL[task.kind]}
            onPress={() => {
              void skip();
            }}
            variant="ghost"
            size="md"
            haptic="tap"
            disabled={action.allowed && !action.ready}
            disabledReason={action.disabledReason}
          />
        </Row>
      )}
    </Surface>
  );
}

/* ------------------------------------------------------------------ styles */

const GRADIENT_START = { x: 0, y: 0 } as const;
const GRADIENT_END = { x: 0.9, y: 1 } as const;

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  grow: { flex: 1 },
});

export default UpNextCard;
