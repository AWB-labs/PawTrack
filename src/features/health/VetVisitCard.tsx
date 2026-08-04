/**
 * Petal — VetVisitCard.
 *
 * What happened, what it cost, and what came home in the envelope.
 *
 * A vet visit is read at two very different moments — the evening after, when
 * you want the diagnosis, and eight months later, when you want the invoice for
 * a claim. So the card leads with the reason and the date, keeps diagnosis and
 * treatment as *labelled* facts rather than a paragraph (you scan for the word
 * "Treatment", not for the sentence), and pins the cost to the top-right where
 * money always lives.
 *
 * Two things worth noting:
 *
 *   · **Cost is stored in minor units and formatted per currency**, because a
 *     ¥4800 bill rendered as ¥48.00 is a hundredfold lie and this screen is what
 *     an insurer sees.
 *   · **A booked follow-up is a footer, not a line.** It's the only forward-
 *     looking fact on an otherwise historical card, so it gets its own rule and
 *     its own tone rather than blending into the write-up above it.
 */

import React, { useMemo } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import type { PetDocument, VetVisit, VetVisitType } from '@/data/types';
import { dueLabel, formatDay, formatClock } from '@/lib/date';
import { formatCurrency, formatWeight, plural } from '@/lib/format';
import { usePreferences } from '@/stores/preferences';
import { useTheme } from '@/theme';
import { Badge, Card, Column, Icon, Row, Text, type BadgeTone, type IconName } from '@/ui';
import { DocumentThumbnail } from './DocumentTile';
import { toneSkin } from './VaccinationCard';

/* -------------------------------------------------------------------- types */

export type VetVisitTypeMeta = {
  label: string;
  icon: IconName;
  tone: BadgeTone;
};

export type VetVisitCardProps = {
  visit: VetVisit;
  /** Already resolved from `visit.documentIds` by the screen. */
  documents?: readonly PetDocument[];
  /** Injected so a list shares one clock. */
  now?: Date;
  onPress?: () => void;
  onLongPress?: () => void;
  onDocumentPress?: (document: PetDocument) => void;
  /** Looks disabled and explains itself on tap — the RBAC affordance. */
  disabledReason?: string;
  /** Drops the write-up and the attachments — for a rail or a summary row. */
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

export const VET_VISIT_TYPE_META: Record<VetVisitType, VetVisitTypeMeta> = {
  checkup: { label: 'Check-up', icon: 'checkmark-circle-outline', tone: 'primary' },
  illness: { label: 'Illness', icon: 'thermometer-outline', tone: 'warning' },
  injury: { label: 'Injury', icon: 'bandage-outline', tone: 'danger' },
  dental: { label: 'Dental', icon: 'happy-outline', tone: 'info' },
  surgery: { label: 'Surgery', icon: 'pulse-outline', tone: 'danger' },
  vaccination: { label: 'Vaccination', icon: 'shield-checkmark-outline', tone: 'success' },
  other: { label: 'Visit', icon: 'medkit-outline', tone: 'neutral' },
};

/** Order for the type picker — commonest first, not alphabetical. */
export const VET_VISIT_TYPES: readonly VetVisitType[] = [
  'checkup',
  'illness',
  'injury',
  'vaccination',
  'dental',
  'surgery',
  'other',
];

const DOCUMENT_STRIP_MAX = 4;

/* ---------------------------------------------------------------- component */

export function VetVisitCard({
  visit,
  documents = [],
  now,
  onPress,
  onLongPress,
  onDocumentPress,
  disabledReason,
  compact = false,
  style,
  testID,
}: VetVisitCardProps) {
  const t = useTheme();
  const unit = usePreferences((s) => s.weightUnit);
  const clock = useMemo(() => now ?? new Date(), [now]);

  const meta = VET_VISIT_TYPE_META[visit.type];
  const skin = toneSkin(t, meta.tone);

  const clinicLine = [visit.vetName, visit.clinic]
    .filter((part): part is string => Boolean(part))
    .join(' · ');

  const cost = visit.costMinor === null ? null : formatCurrency(visit.costMinor, visit.currency, { compactZeros: true });

  const strip = documents.slice(0, DOCUMENT_STRIP_MAX);
  const overflow = documents.length - strip.length;

  const summary = [
    `${meta.label}: ${visit.reason}`,
    `${formatDay(visit.at, clock)} at ${formatClock(visit.at)}`,
    clinicLine,
    visit.diagnosis ? `Diagnosis: ${visit.diagnosis}` : null,
    visit.treatment ? `Treatment: ${visit.treatment}` : null,
    cost ? `Cost ${cost}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join('. ');

  const well = t.spacing.xxxl + t.spacing.sm;

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
      accessibilityHint={disabledReason ?? (onPress ? 'Opens the full write-up.' : undefined)}
      style={style}
      testID={testID}
      footer={
        visit.followUpAt ? (
          <Row gap="sm">
            <Icon name="calendar-outline" size="sm" color="accentText" />
            <Text variant="subheadStrong" color="accentText" numberOfLines={1} style={{ flex: 1 }}>
              {`Follow-up ${dueLabel(visit.followUpAt, clock)}`}
            </Text>
          </Row>
        ) : undefined
      }
    >
      <Row gap="md" align="start">
        <View
          style={{
            width: well,
            height: well,
            borderRadius: t.radius.lg,
            backgroundColor: skin.soft,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name={meta.icon} size="md" color={skin.ink} />
        </View>

        <Column flex gap="xxs">
          <Text variant="headline" numberOfLines={2}>
            {visit.reason}
          </Text>
          <Row gap="xs" wrap>
            <Badge label={meta.label} tone={meta.tone} size="sm" />
            <Text variant="caption" color="textTertiary" numberOfLines={1}>
              {`${formatDay(visit.at, clock)} · ${formatClock(visit.at)}`}
            </Text>
          </Row>
          {clinicLine ? (
            <Text variant="footnote" color="textSecondary" numberOfLines={1}>
              {clinicLine}
            </Text>
          ) : null}
        </Column>

        {cost ? (
          <Column align="end" gap="hair">
            <Text variant="metricSmall" tabular numberOfLines={1}>
              {cost}
            </Text>
            <Text variant="caption" color="textTertiary">
              paid
            </Text>
          </Column>
        ) : null}
      </Row>

      {compact ? null : (
        <Column gap="sm">
          {visit.diagnosis ? <Finding label="Diagnosis" body={visit.diagnosis} tone="info" /> : null}
          {visit.treatment ? <Finding label="Treatment" body={visit.treatment} tone="primary" /> : null}
          {visit.notes ? <Finding label="Notes" body={visit.notes} tone="neutral" /> : null}

          {visit.weightKg !== null ? (
            <Row gap="xs">
              <Icon name="fitness-outline" size="xs" color="textTertiary" />
              <Text variant="caption" color="textTertiary" tabular>
                {`Weighed ${formatWeight(visit.weightKg, { unit })} at the clinic`}
              </Text>
            </Row>
          ) : null}
        </Column>
      )}

      {!compact && strip.length > 0 ? (
        <Row gap="sm" wrap accessibilityLabel={plural(documents.length, 'attachment')}>
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

/* ---------------------------------------------------------------- finding */

/**
 * A labelled fact from the write-up. The label is an overline rather than a
 * bold run inside the sentence because that's what makes it findable when you
 * are scrolling for one word eight months later.
 */
function Finding({ label, body, tone }: { label: string; body: string; tone: BadgeTone }) {
  const t = useTheme();
  const skin = toneSkin(t, tone);

  return (
    <View
      style={{
        gap: t.spacing.hair,
        paddingLeft: t.spacing.md,
        borderLeftWidth: t.borderWidth.thick,
        borderLeftColor: skin.fill,
      }}
    >
      <Text variant="overline" color="textTertiary">
        {label}
      </Text>
      <Text variant="footnote" color="text">
        {body}
      </Text>
    </View>
  );
}

export default VetVisitCard;
