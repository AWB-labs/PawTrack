/**
 * Petal — AppointmentCard.
 *
 * One vet visit, at three sizes, and the home of every piece of appointment
 * vocabulary the rest of the feature borrows (`APPOINTMENT_TYPE_META`,
 * `APPOINTMENT_STATUS_META`, `describeCountdown`).
 *
 * The design decisions worth knowing:
 *
 *   · **The countdown is the headline, not the date.** "In 2 days" is what you
 *     opened the screen to learn; "Fri 12 Sep · 3:00pm" is the confirmation you
 *     read second. So the relative phrase gets the weight and the absolute stamp
 *     sits under it in the quiet ink.
 *   · **Status lives in the accent bar as well as the badge.** A column of cards
 *     is scannable down its left edge before a single word is read — cancelled
 *     goes grey, missed goes amber, confirmed goes green.
 *   · **The quick actions are the point of the card.** Ringing the clinic and
 *     getting directions are the two things people actually do with an
 *     appointment, and burying them behind a detail screen is why calendar
 *     entries lose to a sticky note. Each one only appears when the data to
 *     perform it exists.
 *   · **"We went" / "Didn't happen" appears on its own.** Once a scheduled visit
 *     is in the past the card grows the two buttons that resolve it, which is
 *     what feeds the write-up flow. It never appears early, and it disappears
 *     the moment the status is settled.
 */

import React, { useCallback, useEffect, useMemo } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import type {
  Appointment,
  AppointmentStatus,
  AppointmentType,
  ID,
  PetDocument,
  Vaccination,
} from '@/data/types';
import {
  formatClock,
  formatDay,
  formatDurationMinutes,
  isSameLocalDay,
  minutesUntil,
  relativeTime,
  toDate,
  type DateLike,
} from '@/lib/date';
import { callPhone, openMaps } from '@/lib/deeplinks';
import { formatPhone, possessive } from '@/lib/format';
import { useNow } from '@/rbac/usePermission';
import { useTheme, type Theme } from '@/theme';
import {
  Badge,
  Button,
  Card,
  Chip,
  Column,
  Divider,
  Icon,
  Row,
  Surface,
  Text,
  toast,
  Touchable,
  type BadgeTone,
  type IconName,
} from '@/ui';

import { addToCalendar } from './calendar';

/* -------------------------------------------------------------------- types */

export type AppointmentCardVariant = 'hero' | 'full' | 'compact';

export type AppointmentUrgency = 'imminent' | 'today' | 'soon' | 'future' | 'past';

export type AppointmentCountdown = {
  /** The headline — "In 2 days", "Tomorrow", "In 40 minutes", "3 days ago". */
  lead: string;
  /** The stamp underneath — "Fri 12 Sep · 3:00pm". */
  detail: string;
  urgency: AppointmentUrgency;
};

export type AppointmentCardProps = {
  appointment: Appointment;
  /** Used throughout the copy — this card never says "the pet". */
  petName: string;
  variant?: AppointmentCardVariant;
  /** Shared clock. Defaults to the app's 30s tick so countdowns stay honest. */
  now?: Date;

  onPress?: () => void;
  /** Renders the card dimmed but tappable — wire `onPress` to `explain()`. */
  pressDisabledReason?: string;

  /** Resolving a past visit. Omit to hide the "We went / Didn't happen" row. */
  onStatusChange?: (status: AppointmentStatus) => void;
  statusDisabledReason?: string;

  /** Already-fetched linked records, so the card never fetches on its own. */
  documents?: readonly PetDocument[];
  vaccinations?: readonly Vaccination[];
  onOpenDocument?: (documentId: ID) => void;
  onOpenVaccination?: (vaccinationId: ID) => void;

  /** Turn off the call / directions / calendar row — the hero on a screen that
   *  already offers them, for instance. */
  showQuickActions?: boolean;

  style?: StyleProp<ViewStyle>;
  testID?: string;
};

type TypeMeta = { label: string; icon: IconName; emoji: string };
type StatusMeta = { label: string; tone: BadgeTone; icon: IconName; settled: boolean };

/* ---------------------------------------------------------------- constants */

export const APPOINTMENT_TYPES: readonly AppointmentType[] = [
  'checkup',
  'vaccination',
  'dental',
  'grooming',
  'surgery',
  'followUp',
  'other',
];

export const APPOINTMENT_TYPE_META: Record<AppointmentType, TypeMeta> = {
  checkup: { label: 'Check-up', icon: 'pulse-outline', emoji: '🩺' },
  vaccination: { label: 'Vaccination', icon: 'shield-checkmark-outline', emoji: '💉' },
  dental: { label: 'Dental', icon: 'sparkles-outline', emoji: '🦷' },
  grooming: { label: 'Grooming', icon: 'cut-outline', emoji: '✂️' },
  surgery: { label: 'Surgery', icon: 'bandage-outline', emoji: '🏥' },
  followUp: { label: 'Follow-up', icon: 'repeat-outline', emoji: '🔁' },
  other: { label: 'Other', icon: 'medkit-outline', emoji: '🐾' },
};

/** `settled` means the visit's outcome is known — no "did we go?" prompt. */
export const APPOINTMENT_STATUS_META: Record<AppointmentStatus, StatusMeta> = {
  scheduled: { label: 'Booked', tone: 'info', icon: 'calendar-outline', settled: false },
  confirmed: { label: 'Confirmed', tone: 'success', icon: 'checkmark-circle-outline', settled: false },
  completed: { label: 'Went', tone: 'neutral', icon: 'checkmark-done-outline', settled: true },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: 'close-circle-outline', settled: true },
  missed: { label: 'Missed', tone: 'warning', icon: 'alert-circle-outline', settled: true },
};

/** Inside this many minutes the visit stops being a plan and becomes a journey. */
const IMMINENT_MINUTES = 120;

/** Floor of the "leave now" breath. It dims; it never blinks out. */
const PULSE_FLOOR = 0.3;

/** Half an ambient cycle, so the dot breathes rather than flashes. */
const PULSE_DIVISOR = 2;

/* ------------------------------------------------------------------ helpers */

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The two lines every size of this card leads with. Split into a relative
 * headline and an absolute stamp so neither has to hedge: the headline can say
 * "Tomorrow" without also having to name the date, and the stamp can always be
 * unambiguous without ever reading like a receipt.
 */
export function describeCountdown(at: DateLike, now: Date = new Date()): AppointmentCountdown {
  const date = toDate(at);
  if (!date) {
    return { lead: 'No date yet', detail: 'Open the visit to set one', urgency: 'future' };
  }

  const minutes = minutesUntil(date, now) ?? 0;
  const detail = `${formatDay(date, now)} · ${formatClock(date)}`;
  const lead = capitalise(relativeTime(date, now));

  const urgency: AppointmentUrgency =
    minutes < 0
      ? 'past'
      : minutes <= IMMINENT_MINUTES
        ? 'imminent'
        : isSameLocalDay(date, now)
          ? 'today'
          : minutes <= 7 * 24 * 60
            ? 'soon'
            : 'future';

  return { lead, detail, urgency };
}

function urgencyInk(t: Theme, urgency: AppointmentUrgency, settled: boolean): string {
  if (settled) return t.color.textTertiary;
  switch (urgency) {
    case 'imminent':
      return t.color.accentText;
    case 'today':
      return t.color.accentText;
    case 'soon':
      return t.color.primaryText;
    case 'past':
      return t.color.onWarningSoft;
    default:
      return t.color.textSecondary;
  }
}

/** The card's left-edge identity stripe, and the hero's header wash. */
function statusSkin(t: Theme, status: AppointmentStatus): { bar: string; soft: string; ink: string } {
  switch (status) {
    case 'confirmed':
      return { bar: t.color.success, soft: t.color.successSoft, ink: t.color.onSuccessSoft };
    case 'completed':
      return { bar: t.color.borderStrong, soft: t.color.surfaceAlt, ink: t.color.textSecondary };
    case 'cancelled':
      return { bar: t.color.border, soft: t.color.surfaceAlt, ink: t.color.textTertiary };
    case 'missed':
      return { bar: t.color.warning, soft: t.color.warningSoft, ink: t.color.onWarningSoft };
    case 'scheduled':
    default:
      return { bar: t.color.info, soft: t.color.infoSoft, ink: t.color.onInfoSoft };
  }
}

function clinicLine(appointment: Appointment): string | null {
  const parts = [appointment.clinic, appointment.vetName].filter(
    (part): part is string => typeof part === 'string' && part.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(' · ') : null;
}

/* ---------------------------------------------------------------- component */

export function AppointmentCard({
  appointment,
  petName,
  variant = 'full',
  now: nowProp,
  onPress,
  pressDisabledReason,
  onStatusChange,
  statusDisabledReason,
  documents,
  vaccinations,
  onOpenDocument,
  onOpenVaccination,
  showQuickActions = true,
  style,
  testID,
}: AppointmentCardProps) {
  const t = useTheme();
  const clock = useNow();
  const now = nowProp ?? clock;

  const type = APPOINTMENT_TYPE_META[appointment.type];
  const status = APPOINTMENT_STATUS_META[appointment.status];
  const skin = statusSkin(t, appointment.status);
  const countdown = useMemo(
    () => describeCountdown(appointment.at, now),
    [appointment.at, now],
  );

  const clinic = clinicLine(appointment);
  const phone = appointment.clinicPhone?.trim() ?? '';
  const address = appointment.clinicAddress?.trim() ?? '';

  /** A past-but-unresolved visit is the only thing that asks a question. */
  const needsOutcome =
    countdown.urgency === 'past' && !status.settled && onStatusChange !== undefined;

  const linkedDocuments = useMemo(
    () => (documents ?? []).filter((row) => appointment.linkedDocumentIds.includes(row.id)),
    [appointment.linkedDocumentIds, documents],
  );
  const linkedVaccinations = useMemo(
    () => (vaccinations ?? []).filter((row) => appointment.linkedVaccinationIds.includes(row.id)),
    [appointment.linkedVaccinationIds, vaccinations],
  );
  const hasLinks = linkedDocuments.length > 0 || linkedVaccinations.length > 0;

  /* ---- quick actions ---------------------------------------------------- */

  const handleCall = useCallback(() => {
    void (async () => {
      if (await callPhone(phone)) return;
      toast.error('That number wouldn’t dial', {
        description: `${appointment.clinic ?? 'The clinic'} is listed as ${formatPhone(phone)} — worth checking it's complete.`,
      });
    })();
  }, [appointment.clinic, phone]);

  const handleDirections = useCallback(() => {
    void (async () => {
      if (await openMaps(address, appointment.clinic ?? undefined)) return;
      toast.error('No maps app answered', {
        description: 'You can copy the address from the visit and paste it wherever you navigate.',
      });
    })();
  }, [address, appointment.clinic]);

  const handleCalendar = useCallback(() => {
    void (async () => {
      const outcome = await addToCalendar({ appointment, petName, typeLabel: type.label });
      if (outcome.ok) {
        toast.success(
          outcome.via === 'calendar'
            ? `${possessive(petName)} visit is heading to your calendar`
            : 'Ready to share — pick where it should land',
          { description: `${appointment.reason} · ${countdown.detail}` },
        );
        return;
      }
      if (outcome.reason === 'dismissed') return;
      toast.error('That didn’t reach your calendar', { description: outcome.message });
    })();
  }, [appointment, countdown.detail, petName, type.label]);

  const quickActions = useMemo(() => {
    if (!showQuickActions || appointment.status === 'cancelled') return [];
    const actions: { id: string; icon: IconName; label: string; hint: string; onPress: () => void }[] = [];
    if (phone) {
      actions.push({
        id: 'call',
        icon: 'call-outline',
        label: 'Call clinic',
        hint: `Dials ${formatPhone(phone)}.`,
        onPress: handleCall,
      });
    }
    if (address) {
      actions.push({
        id: 'directions',
        icon: 'navigate-outline',
        label: 'Directions',
        hint: `Opens ${address} in your maps app.`,
        onPress: handleDirections,
      });
    }
    if (countdown.urgency !== 'past') {
      actions.push({
        id: 'calendar',
        icon: 'calendar-outline',
        label: 'Add to calendar',
        hint: 'Creates a calendar entry with the clinic and reminders filled in.',
        onPress: handleCalendar,
      });
    }
    return actions;
  }, [
    address,
    appointment.status,
    countdown.urgency,
    handleCalendar,
    handleCall,
    handleDirections,
    phone,
    showQuickActions,
  ]);

  /* ---- shared blocks ---------------------------------------------------- */

  const label = `${type.label} for ${petName}. ${appointment.reason}. ${countdown.lead}, ${countdown.detail}. ${status.label}.`;

  const countdownBlock = (
    <CountdownBlock
      countdown={countdown}
      settled={status.settled}
      size={variant === 'hero' ? 'large' : 'small'}
      duration={appointment.durationMin}
    />
  );

  const actionsRow =
    quickActions.length > 0 ? (
      <Row gap="sm" wrap>
        {quickActions.map((action) => (
          <QuickAction
            key={action.id}
            icon={action.icon}
            label={action.label}
            hint={action.hint}
            onPress={action.onPress}
            emphasised={variant === 'hero'}
          />
        ))}
      </Row>
    ) : null;

  const linksRow = hasLinks ? (
    <Row gap="xs" wrap>
      {linkedVaccinations.map((row) => (
        <Chip
          key={row.id}
          label={row.name}
          icon="shield-checkmark-outline"
          size="sm"
          showCheck={false}
          onPress={onOpenVaccination ? () => onOpenVaccination(row.id) : undefined}
          accessibilityLabel={`Linked vaccination: ${row.name}`}
          accessibilityHint={onOpenVaccination ? 'Opens the vaccination record.' : undefined}
        />
      ))}
      {linkedDocuments.map((row) => (
        <Chip
          key={row.id}
          label={row.title}
          icon="document-text-outline"
          size="sm"
          showCheck={false}
          onPress={onOpenDocument ? () => onOpenDocument(row.id) : undefined}
          accessibilityLabel={`Linked document: ${row.title}`}
          accessibilityHint={onOpenDocument ? 'Opens the document.' : undefined}
        />
      ))}
    </Row>
  ) : null;

  const outcomeRow = needsOutcome ? (
    <Column gap="sm">
      <Text variant="footnote" color="textSecondary">
        {`Did ${petName} make it to this one?`}
      </Text>
      <Row gap="sm" wrap>
        <Button
          label="We went"
          leftIcon="checkmark"
          variant="tonal"
          size="sm"
          haptic="commit"
          disabledReason={statusDisabledReason}
          onPress={() => onStatusChange?.('completed')}
          accessibilityHint={`Marks ${possessive(petName)} ${type.label.toLowerCase()} as done and offers to write it up.`}
        />
        <Button
          label="Didn’t happen"
          variant="ghost"
          size="sm"
          disabledReason={statusDisabledReason}
          onPress={() => onStatusChange?.('missed')}
          accessibilityHint="Records the visit as missed."
        />
      </Row>
    </Column>
  ) : null;

  /* ---- hero ------------------------------------------------------------- */

  if (variant === 'hero') {
    return (
      <Surface
        variant="surface"
        elevation={2}
        radius="xxl"
        padding="none"
        style={[{ overflow: 'hidden' }, style]}
        testID={testID}
      >
        <View
          style={{
            backgroundColor: skin.soft,
            paddingHorizontal: t.spacing.lg,
            paddingTop: t.spacing.base,
            paddingBottom: t.spacing.lg,
            gap: t.spacing.xs,
          }}
        >
          <Row justify="between" gap="sm">
            <Text variant="overline" color={skin.ink}>
              Next visit
            </Text>
            <Badge label={status.label} tone={status.tone} size="sm" />
          </Row>
          {countdownBlock}
        </View>

        <Column gap="base" style={{ padding: t.spacing.lg }}>
          <Row gap="md" align="start">
            <TypeWell type={type} tone={skin} />
            <Column flex gap="hair">
              <Text variant="title3" numberOfLines={2}>
                {appointment.reason}
              </Text>
              <Text variant="footnote" color="textSecondary" numberOfLines={2}>
                {clinic ?? `${type.label} · ${formatDurationMinutes(appointment.durationMin)}`}
              </Text>
            </Column>
          </Row>

          {actionsRow}
          {linksRow}
          {outcomeRow}

          {onPress ? (
            <Touchable
              accessibilityRole="button"
              accessibilityLabel="Open this visit"
              accessibilityHint={`Opens ${possessive(petName)} ${type.label.toLowerCase()} to edit it.`}
              disabledReason={pressDisabledReason}
              haptic="tap"
              onPress={onPress}
              pressScale="small"
              style={{ alignSelf: 'flex-start' }}
            >
              <Row gap="hair">
                <Text variant="buttonSmall" color="primaryText">
                  Visit details
                </Text>
                <Icon name="chevron-forward" size="xs" color="primaryText" />
              </Row>
            </Touchable>
          ) : null}
        </Column>
      </Surface>
    );
  }

  /* ---- compact ---------------------------------------------------------- */

  if (variant === 'compact') {
    return (
      <Card
        accent={skin.bar}
        onPress={onPress}
        disabledReason={pressDisabledReason}
        accessibilityLabel={label}
        elevation={0}
        radius="lg"
        padding="md"
        gap="xs"
        style={style}
        testID={testID}
      >
        <Row gap="md">
          <TypeWell type={type} tone={skin} size="sm" />
          <Column flex gap="hair">
            <Text variant="subheadStrong" numberOfLines={1}>
              {appointment.reason}
            </Text>
            <Text variant="caption" color="textTertiary" numberOfLines={1}>
              {countdown.detail}
            </Text>
          </Column>
          <Text
            variant="captionStrong"
            color={urgencyInk(t, countdown.urgency, status.settled)}
            numberOfLines={1}
          >
            {countdown.lead}
          </Text>
        </Row>
      </Card>
    );
  }

  /* ---- full ------------------------------------------------------------- */

  return (
    <Card
      accent={skin.bar}
      onPress={onPress}
      disabledReason={pressDisabledReason}
      accessibilityLabel={label}
      accessibilityHint={onPress ? 'Opens the visit to edit it.' : undefined}
      elevation={1}
      radius="xl"
      padding="base"
      gap="md"
      style={style}
      testID={testID}
    >
      <Row gap="md" align="start">
        <TypeWell type={type} tone={skin} />
        <Column flex gap="hair">
          <Text variant="headline" numberOfLines={2}>
            {appointment.reason}
          </Text>
          <Text variant="caption" color="textTertiary" numberOfLines={1}>
            {`${type.label} · ${formatDurationMinutes(appointment.durationMin)}`}
          </Text>
        </Column>
        <Badge label={status.label} tone={status.tone} size="sm" />
      </Row>

      {countdownBlock}

      {clinic ? (
        <Row gap="sm" align="start">
          <Icon name="business-outline" size="sm" color="textTertiary" />
          <Column flex gap="hair">
            <Text variant="subhead" color="textSecondary" numberOfLines={2}>
              {clinic}
            </Text>
            {address ? (
              <Text variant="caption" color="textTertiary" numberOfLines={1}>
                {address}
              </Text>
            ) : null}
          </Column>
        </Row>
      ) : null}

      {actionsRow}

      {linksRow ? (
        <Column gap="sm">
          <Divider />
          <Row gap="xs" align="center">
            <Icon name="link-outline" size="xs" color="textTertiary" />
            <Text variant="caption" color="textTertiary">
              Attached to this visit
            </Text>
          </Row>
          {linksRow}
        </Column>
      ) : null}

      {outcomeRow ? (
        <Column gap="sm">
          <Divider />
          {outcomeRow}
        </Column>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------- countdown */

type CountdownBlockProps = {
  countdown: AppointmentCountdown;
  settled: boolean;
  size: 'large' | 'small';
  duration: number;
};

/**
 * The relative phrase, with a breathing dot beside it once the visit is close
 * enough to need leaving for. The dot is decorative, so reduced motion holds it
 * at full strength rather than removing the signal entirely.
 */
function CountdownBlock({ countdown, settled, size, duration }: CountdownBlockProps) {
  const t = useTheme();
  const ink = urgencyInk(t, countdown.urgency, settled);
  const live = countdown.urgency === 'imminent' && !settled;

  const pulse = useSharedValue(1);
  const reduceMotion = t.reduceMotion;

  useEffect(() => {
    if (!live || reduceMotion) {
      cancelAnimation(pulse);
      pulse.value = 1;
      return;
    }
    pulse.value = withRepeat(
      withTiming(PULSE_FLOOR, {
        duration: t.motion.duration.ambient / PULSE_DIVISOR,
        easing: t.motion.easing.smooth,
        // This loop is already gated on `reduceMotion` above; handing it
        // ReduceMotion.System as well would zero the duration and spin.
        reduceMotion: ReduceMotion.Never,
      }),
      -1,
      true,
    );
    return () => cancelAnimation(pulse);
  }, [live, pulse, reduceMotion, t.motion]);

  const dotStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));
  const dot = t.spacing.sm;

  return (
    <Column gap="hair">
      <Row gap="sm">
        {live ? (
          <Animated.View
            style={[
              { width: dot, height: dot, borderRadius: dot / 2, backgroundColor: ink },
              dotStyle,
            ]}
          />
        ) : null}
        <Text variant={size === 'large' ? 'title1' : 'headline'} color={ink} numberOfLines={1}>
          {countdown.lead}
        </Text>
      </Row>
      <Text variant={size === 'large' ? 'callout' : 'footnote'} color="textSecondary" tabular numberOfLines={1}>
        {size === 'large'
          ? `${countdown.detail} · ${formatDurationMinutes(duration)}`
          : countdown.detail}
      </Text>
    </Column>
  );
}

/* ------------------------------------------------------------- type well */

function TypeWell({
  type,
  tone,
  size = 'md',
}: {
  type: TypeMeta;
  tone: { soft: string; ink: string };
  size?: 'sm' | 'md';
}) {
  const t = useTheme();
  const box = size === 'sm' ? t.spacing.xxl : t.spacing.xxxl;

  return (
    <View
      style={{
        width: box,
        height: box,
        borderRadius: t.radius.md,
        backgroundColor: tone.soft,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon name={type.icon} size={size === 'sm' ? 'sm' : 'md'} color={tone.ink} />
    </View>
  );
}

/* ---------------------------------------------------------- quick action */

function QuickAction({
  icon,
  label,
  hint,
  onPress,
  emphasised,
}: {
  icon: IconName;
  label: string;
  hint: string;
  onPress: () => void;
  emphasised: boolean;
}) {
  const t = useTheme();

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      haptic="tap"
      onPress={onPress}
      pressScale="small"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.spacing.xs,
        paddingVertical: t.spacing.sm,
        paddingHorizontal: t.spacing.md,
        borderRadius: t.radius.pill,
        backgroundColor: emphasised ? t.color.primarySoft : t.color.surfaceAlt,
        borderWidth: t.borderWidth.hairline,
        borderColor: emphasised ? t.color.primarySoftBorder : t.color.border,
      }}
    >
      <Icon name={icon} size="sm" color={emphasised ? 'onPrimarySoft' : 'primaryText'} />
      <Text variant="buttonSmall" color={emphasised ? 'onPrimarySoft' : 'primaryText'} numberOfLines={1}>
        {label}
      </Text>
    </Touchable>
  );
}

export default AppointmentCard;
