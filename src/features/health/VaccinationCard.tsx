/**
 * Petal — VaccinationCard.
 *
 * The one card in the app where colour is doing clinical work. A rabies shot
 * three weeks overdue and a rabies shot due in 2028 are the same row of data and
 * completely different facts, so the whole card changes character: the identity
 * bar, the status disc, the pill and the countdown all move together, and an
 * overdue card's disc breathes so the eye finds it in a stack.
 *
 * Details that earn their keep:
 *
 *   · **The countdown is a number, not a sentence.** "23 / days over" is read at
 *     a glance from across a kitchen; "23 days overdue" has to be read. The
 *     sentence is still there underneath for anyone who wants it, and it is what
 *     VoiceOver announces.
 *   · **Core vs non-core is a badge, always.** It's the first thing a locum vet
 *     asks and the last thing an owner remembers, so it never hides behind a tap.
 *   · **Batch numbers get tabular figures.** They are copied by hand off this
 *     screen onto a form; proportional digits make that harder than it sounds.
 */

import { differenceInCalendarDays } from 'date-fns';
import React, { useEffect, useMemo } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import type { PetDocument, Vaccination, VaccinationStatus } from '@/data/types';
import { dueLabel, formatDay, toDate } from '@/lib/date';
import { plural } from '@/lib/format';
import { useTheme, type Theme } from '@/theme';
import { Badge, Card, Column, Icon, Row, Text, type BadgeTone, type IconName } from '@/ui';
import { DocumentThumbnail } from './DocumentTile';

/* -------------------------------------------------------------------- types */

export type VaccinationStatusMeta = {
  label: string;
  icon: IconName;
  tone: BadgeTone;
  /** Used when the card has to explain itself in a sentence. */
  blurb: string;
};

export type VaccinationCardProps = {
  vaccination: Vaccination;
  /** Already resolved from `vaccination.documentIds` by the screen. */
  documents?: readonly PetDocument[];
  /** Warms the accessibility summary — "Buddy's rabies booster". */
  petName?: string;
  /** Injected so a list shares one clock and can't disagree with itself. */
  now?: Date;
  onPress?: () => void;
  onLongPress?: () => void;
  onDocumentPress?: (document: PetDocument) => void;
  /** Looks disabled and explains itself on tap — the RBAC affordance. */
  disabledReason?: string;
  /** Drops the detail block and the attachments — for summary lists. */
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/** Inside this window a booster stops being "later" and starts being a chore. */
export const DUE_SOON_DAYS = 30;

/** Past this the countdown stops helping and the date itself is more useful. */
const COUNTDOWN_HORIZON_DAYS = 90;

export const VACCINATION_STATUS_META: Record<VaccinationStatus, VaccinationStatusMeta> = {
  upToDate: {
    label: 'Up to date',
    icon: 'shield-checkmark',
    tone: 'success',
    blurb: 'Nothing to do — the next one is a way off yet.',
  },
  dueSoon: {
    label: 'Due soon',
    icon: 'time',
    tone: 'warning',
    blurb: 'Worth booking in on your next free morning.',
  },
  overdue: {
    label: 'Overdue',
    icon: 'alert-circle',
    tone: 'danger',
    blurb: 'This one has slipped past its date.',
  },
  scheduled: {
    label: 'Scheduled',
    icon: 'calendar',
    tone: 'info',
    blurb: 'Booked in, not given yet.',
  },
  unknown: {
    label: 'No dates',
    icon: 'help-circle',
    tone: 'neutral',
    blurb: 'Add the dates and we’ll keep an eye on the next one.',
  },
};

const DOCUMENT_STRIP_MAX = 4;

/* ------------------------------------------------------------------ helpers */

/**
 * The single source of truth for "what colour is this record".
 *
 * `scheduled` deliberately beats `dueSoon`: a dose that has never been given is
 * a different conversation from a booster coming round again, even when both
 * land next Tuesday.
 */
export function vaccinationStatus(
  vaccination: Pick<Vaccination, 'administeredAt' | 'dueAt'>,
  now: Date = new Date(),
): VaccinationStatus {
  const due = toDate(vaccination.dueAt);
  const given = toDate(vaccination.administeredAt);

  if (!due) return given ? 'upToDate' : 'unknown';

  const days = differenceInCalendarDays(due, now);
  if (days < 0) return 'overdue';
  if (!given) return 'scheduled';
  return days <= DUE_SOON_DAYS ? 'dueSoon' : 'upToDate';
}

/** Calendar days until the next dose. Negative once it has slipped. */
export function daysUntilDue(
  vaccination: Pick<Vaccination, 'dueAt'>,
  now: Date = new Date(),
): number | null {
  const due = toDate(vaccination.dueAt);
  return due ? differenceInCalendarDays(due, now) : null;
}

export function toneSkin(t: Theme, tone: BadgeTone): { fill: string; soft: string; ink: string } {
  switch (tone) {
    case 'accent':
      return { fill: t.color.accent, soft: t.color.accentSoft, ink: t.color.onAccentSoft };
    case 'success':
      return { fill: t.color.success, soft: t.color.successSoft, ink: t.color.onSuccessSoft };
    case 'warning':
      return { fill: t.color.warning, soft: t.color.warningSoft, ink: t.color.onWarningSoft };
    case 'danger':
      return { fill: t.color.danger, soft: t.color.dangerSoft, ink: t.color.onDangerSoft };
    case 'info':
      return { fill: t.color.info, soft: t.color.infoSoft, ink: t.color.onInfoSoft };
    case 'neutral':
      return { fill: t.color.textTertiary, soft: t.color.surfaceAlt, ink: t.color.textSecondary };
    case 'primary':
    default:
      return { fill: t.color.primary, soft: t.color.primarySoft, ink: t.color.onPrimarySoft };
  }
}

function sentenceCase(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
}

/* --------------------------------------------------------------- component */

export function VaccinationCard({
  vaccination,
  documents = [],
  petName,
  now,
  onPress,
  onLongPress,
  onDocumentPress,
  disabledReason,
  compact = false,
  style,
  testID,
}: VaccinationCardProps) {
  const t = useTheme();
  const clock = useMemo(() => now ?? new Date(), [now]);

  const status = vaccinationStatus(vaccination, clock);
  const meta = VACCINATION_STATUS_META[status];
  const skin = toneSkin(t, meta.tone);
  const days = daysUntilDue(vaccination, clock);

  const urgent = status === 'overdue';
  const reduce = t.reduceMotion;

  /* ---- the overdue heartbeat ------------------------------------------- */

  const pulse = useSharedValue(0);
  useEffect(() => {
    if (!urgent || reduce) {
      cancelAnimation(pulse);
      pulse.value = 0;
      return;
    }
    pulse.value = withRepeat(
      withTiming(1, t.motion.timing(t.motion.duration.ambient / 2, 'smooth')),
      -1,
      true,
    );
    return () => cancelAnimation(pulse);
  }, [pulse, reduce, t.motion, urgent]);

  const haloStyle = useAnimatedStyle(() => ({
    opacity: 0.34 - pulse.value * 0.26,
    transform: [{ scale: 1 + pulse.value * 0.34 }],
  }));

  /* ---- copy ------------------------------------------------------------- */

  const dueSentence = vaccination.dueAt ? sentenceCase(dueLabel(vaccination.dueAt, clock)) : null;
  const givenSentence = vaccination.administeredAt
    ? `Given ${formatDay(vaccination.administeredAt, clock)}`
    : 'Not given yet';

  const clinicLine = [vaccination.vetName, vaccination.clinic]
    .filter((part): part is string => Boolean(part))
    .join(' · ');

  const countdown =
    days !== null && Math.abs(days) <= COUNTDOWN_HORIZON_DAYS
      ? {
          value: Math.abs(days),
          unit: days < 0 ? 'days over' : days === 0 ? 'today' : 'days left',
        }
      : null;

  const summary = [
    petName ? `${petName}: ${vaccination.name}` : vaccination.name,
    vaccination.core ? 'core vaccine' : 'non-core vaccine',
    meta.label,
    dueSentence,
    givenSentence,
  ]
    .filter((part): part is string => Boolean(part))
    .join('. ');

  const strip = documents.slice(0, DOCUMENT_STRIP_MAX);
  const overflow = documents.length - strip.length;
  const disc = t.spacing.huge;

  /* ---- render ----------------------------------------------------------- */

  return (
    <Card
      accent={skin.fill}
      radius="xl"
      padding="base"
      gap="md"
      elevation={1}
      onPress={onPress}
      onLongPress={onLongPress}
      disabledReason={disabledReason}
      accessibilityLabel={summary}
      accessibilityHint={disabledReason ?? (onPress ? 'Opens this record.' : undefined)}
      style={style}
      testID={testID}
    >
      <Row gap="md" align="start">
        <View style={{ width: disc, height: disc, alignItems: 'center', justifyContent: 'center' }}>
          {urgent ? (
            <Animated.View
              pointerEvents="none"
              style={[
                {
                  position: 'absolute',
                  width: disc,
                  height: disc,
                  borderRadius: disc / 2,
                  backgroundColor: skin.fill,
                },
                haloStyle,
              ]}
            />
          ) : null}
          <View
            style={{
              width: disc,
              height: disc,
              borderRadius: disc / 2,
              backgroundColor: skin.soft,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name={meta.icon} size="lg" color={skin.ink} />
          </View>
        </View>

        <Column flex gap="xs">
          <Row gap="xs" wrap align="center">
            <Text variant="title3" numberOfLines={2} style={{ flexShrink: 1 }}>
              {vaccination.name}
            </Text>
            <Badge
              label={vaccination.core ? 'Core' : 'Non-core'}
              tone={vaccination.core ? 'primary' : 'neutral'}
              size="sm"
              accessibilityLabel={vaccination.core ? 'Core vaccine' : 'Non-core vaccine'}
            />
          </Row>

          <Row gap="xs" wrap>
            <Badge label={meta.label} tone={meta.tone} size="md" dot />
            {dueSentence ? (
              <Text variant="footnote" color="textSecondary" numberOfLines={1} style={{ flexShrink: 1 }}>
                {dueSentence}
              </Text>
            ) : null}
          </Row>
        </Column>

        {countdown ? (
          <Column align="center" gap="hair" style={{ minWidth: t.spacing.huge }}>
            <Text variant="metricSmall" color={skin.ink} tabular numberOfLines={1}>
              {countdown.unit === 'today' ? '0' : String(countdown.value)}
            </Text>
            <Text variant="caption" color="textTertiary" align="center" numberOfLines={1}>
              {countdown.unit === 'today' ? 'today' : countdown.unit}
            </Text>
          </Column>
        ) : null}
      </Row>

      {compact ? null : (
        <Column gap="xs">
          <DetailLine icon="checkmark-done-outline" text={givenSentence} />
          {clinicLine ? <DetailLine icon="medkit-outline" text={clinicLine} /> : null}
          {vaccination.batchNumber ? (
            <DetailLine icon="barcode-outline" text={`Batch ${vaccination.batchNumber}`} tabular />
          ) : null}
          {vaccination.notes ? (
            <DetailLine icon="chatbubble-ellipses-outline" text={vaccination.notes} lines={3} />
          ) : null}
        </Column>
      )}

      {!compact && strip.length > 0 ? (
        <Row gap="sm" wrap accessibilityLabel={`${plural(documents.length, 'attachment')}`}>
          {strip.map((document) => (
            <DocumentThumbnail
              key={document.id}
              document={document}
              size={t.spacing.huge}
              onPress={onDocumentPress ? () => onDocumentPress(document) : undefined}
            />
          ))}
          {overflow > 0 ? (
            <View
              style={{
                width: t.spacing.huge,
                height: t.spacing.huge,
                borderRadius: t.radius.md,
                backgroundColor: t.color.surfaceAlt,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text variant="captionStrong" color="textSecondary" tabular>
                {`+${overflow}`}
              </Text>
            </View>
          ) : null}
        </Row>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------- detail line */

function DetailLine({
  icon,
  text,
  tabular = false,
  lines = 2,
}: {
  icon: IconName;
  text: string;
  tabular?: boolean;
  lines?: number;
}) {
  const t = useTheme();
  return (
    <Row gap="sm" align="start">
      {/* Nudged down so the glyph sits on the text's x-height, not its cap. */}
      <View style={{ paddingTop: t.spacing.hair }}>
        <Icon name={icon} size="xs" color="textTertiary" />
      </View>
      <Text variant="footnote" color="textSecondary" tabular={tabular} numberOfLines={lines} style={{ flex: 1 }}>
        {text}
      </Text>
    </Row>
  );
}

export default VaccinationCard;
