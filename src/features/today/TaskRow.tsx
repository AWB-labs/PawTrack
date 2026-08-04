/**
 * Petal — TaskRow.
 *
 * One line of the day. It is the most-tapped surface in the product, so it gets
 * three routes to the same outcome and each is tuned separately:
 *
 *   · **Swipe right to log it, left to skip it.** The fastest path — one-handed,
 *     with the dog already on the counter. `SwipeRow` arms a full swipe past
 *     62%, so a committed flick never needs a second tap.
 *   · **Tap the box.** The tick is *drawn* rather than faded (see `Checkbox`),
 *     the row then settles into its done treatment, and the success haptic lands
 *     with the stroke. Finishing the last outstanding thing of the day throws
 *     confetti — once, for the last one, which is what keeps it a reward.
 *   · **VoiceOver** reaches both actions through `SwipeRow`'s accessibility
 *     actions, and the checkbox is deliberately a *sibling* of the row's own
 *     touch target rather than a child of it, so it stays independently
 *     focusable instead of being swallowed by the row's label.
 *
 * Two states are designed rather than derived. **Overdue** is a tinted card with
 * a red identity bar and a "40m late" stamp in the time gutter — not red text on
 * an otherwise normal row, because the point is to be findable while scrolling.
 * And a viewer who *can't* log (a sitter on view-only access) sees the control
 * looking off but still answering: tapping it opens the denial sheet with the
 * real reason and the real dates, which is how they learn what to ask for.
 *
 * `useTaskCompletion` is exported because `UpNextCard` runs the same three
 * mutations in a different shape, and two copies of "which caches does a skipped
 * dose touch" is one copy too many.
 */

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
  type WithSpringConfig,
} from 'react-native-reanimated';

import { useAppointments, useUpdateAppointmentStatus } from '@/data/queries/useAppointments';
import { useLogFeeding, useUndoFeedingLog } from '@/data/queries/useFeeding';
import { useLogDose, useUndoDose } from '@/data/queries/useMedicine';
import type { Appointment, CareTask, Pet, PortionUnit, TaskKind } from '@/data/types';
import { formatClock, isSameLocalDay } from '@/lib/date';
import { possessive } from '@/lib/format';
import haptics from '@/lib/haptics';
import { DENIAL_COPY } from '@/rbac/permissions';
import { useNow, usePermission } from '@/rbac/usePermission';
import { spring, useTheme } from '@/theme';
import {
  Avatar,
  Checkbox,
  Column,
  Icon,
  Row,
  SwipeRow,
  Text,
  Touchable,
  confetti,
  toast,
  type IconName,
  type SwipeAction,
} from '@/ui';

/* -------------------------------------------------------------------- types */

export type TaskRowEmphasis = 'default' | 'quiet';

export type TaskRowProps = {
  task: CareTask;
  /** Resolved from the pet index. Undefined only while the household loads. */
  pet: Pet | undefined;
  /** Position within its section — drives the entrance stagger. */
  index?: number;
  /** True when finishing this one finishes the whole day. */
  celebrateOnComplete?: boolean;
  /** `quiet` is the "later today" treatment: no card, no chrome, half the ink. */
  emphasis?: TaskRowEmphasis;
  onPress?: (task: CareTask) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export type TaskCompletion = {
  /** The viewer holds the capability this task needs. */
  allowed: boolean;
  /** Owner-only: hide the control entirely rather than teasing it. */
  hidden: boolean;
  /** Short hint for the disabled affordance. Never shown as body copy. */
  disabledReason: string | undefined;
  /** Opens the themed denial sheet. A no-op while allowed. */
  explain: () => void;
  /** A write is in flight. */
  busy: boolean;
  /** False while an appointment's record is still being resolved. */
  ready: boolean;
  /** Resolves to whether the write landed — the caller decides about confetti. */
  complete: () => Promise<boolean>;
  skip: () => Promise<boolean>;
};

/* ---------------------------------------------------------------- constants */

/** See `@/ui/Touchable` — the theme's `springWith` helper doesn't type-check yet. */
const REWARD: WithSpringConfig = { ...spring.bouncy, reduceMotion: ReduceMotion.System };

/** Past this the cascade reads as lag rather than choreography. */
const STAGGER_CAP = 8;

/** The row swells a hair as it settles, so "done" is felt and not only seen. */
const SETTLE_POP = 1.015;

/** Pack size below which the toast bothers mentioning what's left. */
const REFILL_WHISPER = 3;

const KIND_ICON: Record<TaskKind, IconName> = {
  feeding: 'restaurant',
  medicine: 'medkit',
  appointment: 'calendar',
};

/** What "done" is actually called, per kind. "Complete a meal" is nobody's phrase. */
export const KIND_DONE_LABEL: Record<TaskKind, string> = {
  feeding: 'Fed',
  medicine: 'Given',
  appointment: 'We went',
};

export const KIND_SKIP_LABEL: Record<TaskKind, string> = {
  feeding: 'Skipped',
  medicine: 'Not given',
  appointment: 'We didn’t',
};

/** The long form, for controls with room for a verb. */
export const KIND_DONE_ACTION: Record<TaskKind, string> = {
  feeding: 'Mark as fed',
  medicine: 'Mark as given',
  appointment: 'We went',
};

const PORTION_UNITS: readonly PortionUnit[] = ['g', 'ml', 'cup', 'scoop', 'can', 'piece'];

const MINUTES_PER_HOUR = 60;

/* ------------------------------------------------------------------ helpers */

type MetaValue = string | number | boolean | null | undefined;

const metaString = (value: MetaValue): string | null => (typeof value === 'string' ? value : null);
const metaNumber = (value: MetaValue): number | null => (typeof value === 'number' ? value : null);

function metaUnit(value: MetaValue): PortionUnit {
  return PORTION_UNITS.find((unit) => unit === value) ?? 'g';
}

/** "40m late", "2h late" — a stamp, not a sentence. */
export function latenessLabel(at: string, now: Date): string | null {
  const slot = Date.parse(at);
  if (Number.isNaN(slot)) return null;
  const minutes = Math.round((now.getTime() - slot) / 60_000);
  if (minutes < 1) return null;
  if (minutes < MINUTES_PER_HOUR) return `${minutes}m late`;
  return `${Math.round(minutes / MINUTES_PER_HOUR)}h late`;
}

/* ------------------------------------------------------------- completion */

/**
 * The three mutations a care task can trigger, behind one shape.
 *
 * Appointments are the odd one out: the status mutation round-trips the whole
 * record, which a `CareTask` deliberately doesn't carry. We resolve it from the
 * pet's own (already cached) appointment list rather than widening the task
 * stream — and report `ready: false` for the beat before it lands, so the
 * control stays honest instead of optimistic about data it hasn't got.
 */
export function useTaskCompletion(task: CareTask, petName: string): TaskCompletion {
  const { allowed, reason, explain } = usePermission(task.requires, task.petId);

  const logFeeding = useLogFeeding(task.petId);
  const undoFeeding = useUndoFeedingLog(task.petId);
  const logDose = useLogDose(task.petId);
  const undoDose = useUndoDose(task.petId);
  const setAppointmentStatus = useUpdateAppointmentStatus(task.petId);

  const isAppointment = task.kind === 'appointment';
  const appointmentsQuery = useAppointments(isAppointment ? task.petId : null);

  const appointment = useMemo<Appointment | null>(() => {
    if (!isAppointment) return null;
    return (appointmentsQuery.data ?? []).find((row) => row.id === task.sourceId) ?? null;
  }, [appointmentsQuery.data, isAppointment, task.sourceId]);

  const mealLabel = metaString(task.meta.label)?.toLowerCase() ?? 'meal';

  const run = useCallback(
    async (skipped: boolean): Promise<boolean> => {
      try {
        if (task.kind === 'feeding') {
          const scheduleId = metaString(task.meta.scheduleId) ?? task.sourceId;
          // Today's slot records the moment it actually happened — "when did she
          // eat" is a real question. A back-filled day keeps its own slot time.
          const at = isSameLocalDay(task.at, new Date()) ? new Date().toISOString() : task.at;

          const log = await logFeeding.mutateAsync({
            scheduleId,
            at,
            foodName: metaString(task.meta.foodName) ?? task.title,
            portion: metaNumber(task.meta.portion) ?? 1,
            unit: metaUnit(task.meta.unit),
            skipped,
          });

          const undo = () => undoFeeding.mutate({ logId: log.id, scheduleId, at: task.at });
          if (skipped) {
            toast.show({ tone: 'info', message: `Noted — ${petName} skipped ${mealLabel}.`, undo });
          } else {
            toast.undo(`${possessive(petName)} ${mealLabel} is logged 🐾`, undo);
          }
          return true;
        }

        if (task.kind === 'medicine') {
          const status = skipped ? 'skipped' : 'given';
          const log = await logDose.mutateAsync({
            medicineId: task.sourceId,
            scheduledFor: task.at,
            status,
            dosage: metaString(task.meta.dosage),
          });

          const undo = () =>
            undoDose.mutate({
              logId: log.id,
              medicineId: task.sourceId,
              scheduledFor: task.at,
              status,
            });

          if (skipped) {
            toast.show({ tone: 'info', message: `Dose skipped for ${petName}.`, undo });
          } else {
            const left = metaNumber(task.meta.remainingDoses);
            toast.undo(`${possessive(petName)} dose is logged.`, undo, {
              description:
                left !== null && left > 0 && left <= REFILL_WHISPER
                  ? `${left - 1} left in the pack after this one.`
                  : undefined,
            });
          }
          return true;
        }

        if (!appointment) return false;
        const previous = appointment.status;
        await setAppointmentStatus.mutateAsync({
          appointment,
          status: skipped ? 'missed' : 'completed',
        });
        toast.show({
          tone: skipped ? 'info' : 'success',
          message: skipped
            ? 'Marked as missed — you can rebook whenever suits.'
            : `${possessive(petName)} appointment is written up.`,
          undo: () => setAppointmentStatus.mutate({ appointment, status: previous }),
        });
        return true;
      } catch {
        // The mutation's own `onError` has already raised the failure toast and
        // rolled the cache back; the caller only needs to know not to celebrate.
        return false;
      }
    },
    [
      appointment,
      logDose,
      logFeeding,
      mealLabel,
      petName,
      setAppointmentStatus,
      task,
      undoDose,
      undoFeeding,
    ],
  );

  const complete = useCallback(() => run(false), [run]);
  const skip = useCallback(() => run(true), [run]);

  const petId = task.petId;
  const explainHere = useCallback(() => explain({ petId }), [explain, petId]);

  return useMemo(
    () => ({
      allowed,
      hidden: !allowed && reason === 'owner-only',
      disabledReason: allowed || reason === null ? undefined : DENIAL_COPY[reason].title,
      explain: explainHere,
      busy: logFeeding.isPending || logDose.isPending || setAppointmentStatus.isPending,
      ready: !isAppointment || appointment !== null,
      complete,
      skip,
    }),
    [
      allowed,
      appointment,
      complete,
      explainHere,
      isAppointment,
      logDose.isPending,
      logFeeding.isPending,
      reason,
      setAppointmentStatus.isPending,
      skip,
    ],
  );
}

/* ---------------------------------------------------------------- component */

export function TaskRow({
  task,
  pet,
  index = 0,
  celebrateOnComplete = false,
  emphasis = 'default',
  onPress,
  style,
  testID,
}: TaskRowProps) {
  const t = useTheme();
  const now = useNow();

  const petName = pet?.name ?? 'your pet';
  const action = useTaskCompletion(task, petName);

  const done = task.state === 'done';
  const skipped = task.state === 'skipped';
  const settled = done || skipped;
  const overdue = task.state === 'overdue';
  const quiet = emphasis === 'quiet';

  const identity = pet ? t.speciesColor(pet.species) : null;
  const barColor = overdue ? t.color.danger : (identity?.base ?? t.color.border);
  const ground = quiet ? t.color.bg : t.color.surface;
  const pad = quiet ? t.spacing.sm : t.spacing.md;

  /* ---- settling ---------------------------------------------------------- */

  const settle = useSharedValue(settled ? 1 : 0);
  const pop = useSharedValue(1);
  const wasSettled = useRef(settled);

  useEffect(() => {
    settle.value = withTiming(settled ? 1 : 0, t.motion.timing(t.motion.duration.base, 'smooth'));
    if (settled && !wasSettled.current) {
      pop.value = withSequence(
        withTiming(SETTLE_POP, t.motion.timing(t.motion.duration.instant, 'decelerate')),
        withSpring(1, REWARD),
      );
    }
    wasSettled.current = settled;
  }, [pop, settle, settled, t.motion]);

  const muted = t.opacity.muted;
  const settleStyle = useAnimatedStyle(() => ({
    opacity: 1 - settle.value * (1 - muted),
    transform: [{ scale: pop.value }],
  }));

  /* ---- acting ------------------------------------------------------------ */

  const finish = useCallback(
    async (withHaptic: boolean) => {
      const landed = await action.complete();
      if (!landed) return;
      // SwipeRow already fires its own success tick, so the swipe path stays quiet.
      if (withHaptic) haptics.success();
      // One burst, for the one that finishes the day.
      if (celebrateOnComplete) confetti.fire({ power: 1.15 });
    },
    [action, celebrateOnComplete],
  );

  const handleTick = useCallback(() => {
    if (!action.allowed) {
      action.explain();
      return;
    }
    // A logged row is terminal here; the toast's Undo is the way back.
    if (done || !action.ready) return;
    void finish(true);
  }, [action, done, finish]);

  /* ---- swipe actions ----------------------------------------------------- */

  const swipeLeft = useMemo<SwipeAction[]>(
    () => [
      {
        key: 'complete',
        label: KIND_DONE_LABEL[task.kind],
        icon: 'checkmark',
        tone: 'success',
        fullSwipe: true,
        disabledReason: action.disabledReason,
        onPress: () => (action.allowed ? void finish(false) : action.explain()),
      },
    ],
    [action, finish, task.kind],
  );

  const swipeRight = useMemo<SwipeAction[]>(
    () => [
      {
        key: 'skip',
        label: KIND_SKIP_LABEL[task.kind],
        icon: 'close',
        tone: 'warning',
        fullSwipe: true,
        disabledReason: action.disabledReason,
        onPress: () => (action.allowed ? void action.skip() : action.explain()),
      },
    ],
    [action, task.kind],
  );

  /* ---- entrance ---------------------------------------------------------- */

  const entering = useMemo(() => {
    const step = Math.min(index, STAGGER_CAP);
    return t.reduceMotion
      ? FadeIn.duration(t.motion.duration.base).delay(step * t.motion.stagger.tight)
      : FadeInDown.duration(t.motion.duration.slow)
          .delay(step * t.motion.stagger.base)
          .easing(t.motion.easing.decelerate);
  }, [index, t.motion, t.reduceMotion]);

  /* ---- copy -------------------------------------------------------------- */

  const late = overdue ? latenessLabel(task.at, now) : null;
  const stamp = done ? 'done' : skipped ? 'skipped' : late;
  const subtitle =
    settled && task.completedAt ? `Logged at ${formatClock(task.completedAt)}` : task.subtitle;

  const announce = `${task.title}, ${formatClock(task.at)}. ${
    done ? 'Logged.' : skipped ? 'Skipped.' : (late ?? 'Still to do.')
  }`;

  /* ---- render ------------------------------------------------------------ */

  const badge = t.spacing.lg;

  return (
    <Animated.View entering={entering} style={style} testID={testID}>
      <Animated.View style={settleStyle}>
        <Row gap="md" align="start">
          <Column style={{ width: t.spacing.huge, paddingTop: pad }}>
            <Text
              variant="subheadStrong"
              color={overdue ? 'danger' : settled ? 'textTertiary' : 'text'}
              tabular
              numberOfLines={1}
            >
              {formatClock(task.at)}
            </Text>
            {stamp ? (
              <Text variant="caption" color={overdue ? 'danger' : 'textTertiary'} numberOfLines={1}>
                {stamp}
              </Text>
            ) : null}
          </Column>

          <SwipeRow
            left={swipeLeft}
            right={swipeRight}
            enabled={!settled && !action.hidden}
            background={ground}
            radius="lg"
            style={styles.grow}
          >
            <View
              style={[
                styles.card,
                {
                  borderRadius: t.radius.lg,
                  backgroundColor: overdue ? t.color.dangerSoft : ground,
                  borderWidth: quiet ? 0 : t.borderWidth.hairline,
                  borderColor: overdue ? t.color.danger : t.color.border,
                },
              ]}
            >
              {quiet ? null : (
                <View style={{ width: t.spacing.xxs, alignSelf: 'stretch', backgroundColor: barColor }} />
              )}

              <Touchable
                accessibilityRole={onPress ? 'button' : 'text'}
                accessibilityLabel={announce}
                accessibilityHint={
                  onPress ? `Opens ${possessive(petName)} full record.` : undefined
                }
                haptic="tap"
                onPress={onPress ? () => onPress(task) : undefined}
                // The target is only part of the card, so a 2% shrink would look
                // like the contents coming loose. It dims and barely moves.
                dim
                pressScale="subtle"
                style={[styles.grow, { padding: pad }]}
              >
                <Row gap="md">
                  <View>
                    <Avatar
                      uri={pet?.photoUrl}
                      name={pet?.name}
                      species={pet?.species}
                      size={quiet ? 'sm' : 'md'}
                    />
                    {/* The kind rides the pet, so "who" lands before "what"
                        without costing a second column. */}
                    <View
                      style={[
                        styles.badge,
                        {
                          right: -t.borderWidth.thick,
                          bottom: -t.borderWidth.thick,
                          width: badge,
                          height: badge,
                          borderRadius: badge / 2,
                          backgroundColor: overdue ? t.color.danger : (identity?.base ?? t.color.primary),
                          borderWidth: t.borderWidth.thick,
                          borderColor: ground,
                        },
                      ]}
                    >
                      <Icon
                        name={KIND_ICON[task.kind]}
                        size="xs"
                        color={overdue ? t.color.onDanger : ground}
                      />
                    </View>
                  </View>

                  <Column flex gap="hair">
                    <Text
                      variant="headline"
                      color={settled ? 'textSecondary' : 'text'}
                      numberOfLines={quiet ? 1 : 2}
                      style={done ? styles.struck : undefined}
                    >
                      {task.title}
                    </Text>
                    <Text
                      variant="footnote"
                      color={overdue ? 'onDangerSoft' : 'textTertiary'}
                      numberOfLines={1}
                    >
                      {subtitle}
                    </Text>
                  </Column>
                </Row>
              </Touchable>

              {/* A sibling, not a child: nested inside the row's own touch target
                  it would stop being focusable for VoiceOver. */}
              {action.hidden ? null : (
                <View style={[styles.control, { paddingRight: pad }]}>
                  {skipped ? (
                    <Icon
                      name="close-circle"
                      size="lg"
                      color="textTertiary"
                      accessibilityLabel={`${task.title} was skipped`}
                    />
                  ) : (
                    <Checkbox
                      checked={done}
                      onChange={handleTick}
                      size="md"
                      tone={task.kind === 'feeding' ? 'accent' : 'primary'}
                      disabledReason={action.disabledReason}
                      accessibilityLabel={
                        done
                          ? `${task.title} is logged`
                          : `${KIND_DONE_LABEL[task.kind]} — ${task.title}`
                      }
                      accessibilityHint={done ? 'Already logged.' : undefined}
                    />
                  )}
                </View>
              )}
            </View>
          </SwipeRow>
        </Row>
      </Animated.View>
    </Animated.View>
  );
}

/* ------------------------------------------------------------------ styles */

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'stretch', overflow: 'hidden' },
  grow: { flex: 1 },
  control: { justifyContent: 'center' },
  badge: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  // Not a colour or a size — the one text treatment that says "this is behind us".
  struck: { textDecorationLine: 'line-through' },
});

export default TaskRow;
