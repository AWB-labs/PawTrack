/**
 * Petal — DocumentTile.
 *
 * A pet's paperwork is mostly *photographs of paperwork*, so the tile leads with
 * the image and lets the words come second. Three decisions follow from that:
 *
 *   · **The thumbnail is the tile.** A 4:5 crop with the title underneath reads
 *     like a filing cabinet you can actually see into; a list of grey rows with
 *     "PDF" icons does not. Anything we can't render an image for gets a tinted
 *     well with its kind's glyph, so a row of tiles still has rhythm.
 *   · **Kind is a corner badge, not a line of text.** You scan a grid for the
 *     x-ray, not for the word "x-ray", and a badge survives being 150pt wide.
 *   · **Long press is published to VoiceOver.** The options menu is otherwise a
 *     hidden feature — an `accessibilityAction` costs three lines and makes the
 *     same menu reachable from the rotor.
 *
 * `DocumentThumbnail` is exported because vaccination and vet-visit cards show
 * the same object at chip size; drawing it twice is how the two would drift.
 */

import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Image } from 'expo-image';

import type { DocumentKind, PetDocument } from '@/data/types';
import { friendlyDate } from '@/lib/date';
import { formatFileSize } from '@/lib/format';
import { useTheme, type Theme } from '@/theme';
import { Badge, Column, Icon, Row, Surface, Text, Touchable, type BadgeTone, type IconName } from '@/ui';

/* -------------------------------------------------------------------- types */

export type DocumentKindMeta = {
  /** Full name, for the picker and the detail sheet. */
  label: string;
  /** Badge-width name, for the tile corner and the filter row. */
  short: string;
  icon: IconName;
  tone: BadgeTone;
  /** One line explaining what belongs here, for the kind picker. */
  hint: string;
};

export type DocumentTileProps = {
  document: PetDocument;
  onPress?: () => void;
  /** Opens the tile's action menu. Also published as an accessibility action. */
  onLongPress?: () => void;
  /** Looks disabled and explains itself on tap — the RBAC affordance. */
  disabledReason?: string;
  /** Height of the preview, relative to the tile width. */
  aspectRatio?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export type DocumentThumbnailProps = {
  document: PetDocument;
  /** Edge length in points. */
  size: number;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/**
 * Order matters: this drives the filter row and the kind picker, and it runs
 * from "what a vet asks for" to "everything else" rather than alphabetically.
 */
export const DOCUMENT_KINDS: readonly DocumentKind[] = [
  'record',
  'xray',
  'prescription',
  'invoice',
  'insurance',
  'photo',
  'other',
];

export const DOCUMENT_KIND_META: Record<DocumentKind, DocumentKindMeta> = {
  record: {
    label: 'Medical record',
    short: 'Record',
    icon: 'document-text-outline',
    tone: 'primary',
    hint: 'Vaccination cards, test results, discharge notes.',
  },
  xray: {
    label: 'X-ray or scan',
    short: 'X-ray',
    icon: 'scan-outline',
    tone: 'info',
    hint: 'Imaging your vet sent home with you.',
  },
  prescription: {
    label: 'Prescription',
    short: 'Rx',
    icon: 'medkit-outline',
    tone: 'success',
    hint: 'Repeat scripts and dosing instructions.',
  },
  invoice: {
    label: 'Invoice or receipt',
    short: 'Invoice',
    icon: 'receipt-outline',
    tone: 'warning',
    hint: 'What the visit cost — handy at claim time.',
  },
  insurance: {
    label: 'Insurance',
    short: 'Insurance',
    icon: 'shield-outline',
    tone: 'info',
    hint: 'Policies, renewals and claim forms.',
  },
  photo: {
    label: 'Photo',
    short: 'Photo',
    icon: 'image-outline',
    tone: 'accent',
    hint: 'A rash, a limp, a good day — anything worth showing the vet.',
  },
  other: {
    label: 'Something else',
    short: 'Other',
    icon: 'folder-open-outline',
    tone: 'neutral',
    hint: 'Passports, microchip paperwork, breeder notes.',
  },
};

/** Preview crop. Portrait, because most of these are photographed A4. */
const DEFAULT_ASPECT = 4 / 5;

/* ------------------------------------------------------------------ helpers */

export function isImageDocument(document: PetDocument): boolean {
  return document.mimeType.startsWith('image/');
}

/** The URI worth rendering as a picture, or null when there isn't one. */
export function documentPreviewUri(document: PetDocument): string | null {
  if (document.thumbnailUri) return document.thumbnailUri;
  return isImageDocument(document) ? document.uri : null;
}

/** "3 Oct · 1.8 MB · 2 pages" — whichever of those we actually know. */
export function describeDocument(document: PetDocument, now: Date = new Date()): string {
  return [
    friendlyDate(document.uploadedAt, now),
    document.sizeBytes === null ? null : formatFileSize(document.sizeBytes),
    document.pageCount !== null && document.pageCount > 1 ? `${document.pageCount} pages` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

function toneSkin(t: Theme, tone: BadgeTone): { fill: string; ink: string } {
  switch (tone) {
    case 'accent':
      return { fill: t.color.accentSoft, ink: t.color.onAccentSoft };
    case 'success':
      return { fill: t.color.successSoft, ink: t.color.onSuccessSoft };
    case 'warning':
      return { fill: t.color.warningSoft, ink: t.color.onWarningSoft };
    case 'danger':
      return { fill: t.color.dangerSoft, ink: t.color.onDangerSoft };
    case 'info':
      return { fill: t.color.infoSoft, ink: t.color.onInfoSoft };
    case 'neutral':
      return { fill: t.color.surfaceAlt, ink: t.color.textSecondary };
    case 'primary':
    default:
      return { fill: t.color.primarySoft, ink: t.color.onPrimarySoft };
  }
}

/* --------------------------------------------------------------- thumbnail */

/**
 * The same object at chip size, for "attached to this record" strips. Square
 * rather than 4:5 — in a row of four it's the shape that reads as a stack of
 * files rather than a row of postcards.
 */
export function DocumentThumbnail({ document, size, onPress, style, testID }: DocumentThumbnailProps) {
  const t = useTheme();
  const meta = DOCUMENT_KIND_META[document.kind];
  const skin = toneSkin(t, meta.tone);
  const preview = documentPreviewUri(document);
  const label = `${document.title}. ${meta.label}.`;

  const body = (
    <View
      style={[
        styles.clip,
        {
          width: size,
          height: size,
          borderRadius: t.radius.md,
          backgroundColor: preview ? t.color.surfaceAlt : skin.fill,
          borderWidth: t.borderWidth.hairline,
          borderColor: t.color.border,
        },
      ]}
    >
      {preview ? (
        <Image
          source={{ uri: preview }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={t.motion.duration.base}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          <Icon name={meta.icon} size={size > t.spacing.huge ? 'md' : 'sm'} color={skin.ink} />
        </View>
      )}
    </View>
  );

  if (!onPress) {
    return (
      <View accessible accessibilityRole="image" accessibilityLabel={label} style={style} testID={testID}>
        {body}
      </View>
    );
  }

  return (
    <Touchable
      accessibilityRole="imagebutton"
      accessibilityLabel={label}
      accessibilityHint="Opens this file."
      haptic="tap"
      onPress={onPress}
      pressScale="small"
      style={style}
      testID={testID}
    >
      {body}
    </Touchable>
  );
}

/* ---------------------------------------------------------------- component */

export function DocumentTile({
  document,
  onPress,
  onLongPress,
  disabledReason,
  aspectRatio = DEFAULT_ASPECT,
  style,
  testID,
}: DocumentTileProps) {
  const t = useTheme();
  const meta = DOCUMENT_KIND_META[document.kind];
  const skin = toneSkin(t, meta.tone);
  const preview = documentPreviewUri(document);
  const caption = describeDocument(document);

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={`${document.title}. ${meta.label}. ${caption}.`}
      accessibilityHint={disabledReason ?? 'Opens the full-size file.'}
      accessibilityActions={onLongPress ? A11Y_ACTIONS : undefined}
      onAccessibilityAction={onLongPress}
      disabledReason={disabledReason}
      haptic="tap"
      onPress={onPress}
      onLongPress={onLongPress}
      pressScale="large"
      style={style}
      testID={testID}
    >
      <Surface variant="surface" elevation={1} radius="xl" padding="none" style={styles.clip}>
        <View style={{ aspectRatio, backgroundColor: preview ? t.color.surfaceAlt : skin.fill }}>
          {preview ? (
            <Animated.View entering={FadeIn.duration(t.motion.duration.base)} style={StyleSheet.absoluteFill}>
              <Image
                source={{ uri: preview }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                transition={t.motion.duration.base}
                accessibilityIgnoresInvertColors
              />
            </Animated.View>
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.center]}>
              <Icon name={meta.icon} size="xxl" color={skin.ink} />
            </View>
          )}

          <View style={{ position: 'absolute', top: t.spacing.sm, left: t.spacing.sm }}>
            <Badge label={meta.short} tone={meta.tone} size="sm" solid={preview !== null} />
          </View>

          {document.pageCount !== null && document.pageCount > 1 ? (
            <View style={{ position: 'absolute', bottom: t.spacing.sm, right: t.spacing.sm }}>
              <Badge label={`${document.pageCount} pages`} tone="neutral" size="sm" solid />
            </View>
          ) : null}
        </View>

        <Column gap="hair" style={{ padding: t.spacing.md }}>
          <Text variant="subheadStrong" numberOfLines={2}>
            {document.title}
          </Text>
          <Row gap="xxs">
            <Icon name="time-outline" size="xs" color="textTertiary" />
            <Text variant="caption" color="textTertiary" numberOfLines={1} style={styles.grow}>
              {caption}
            </Text>
          </Row>
        </Column>
      </Surface>
    </Touchable>
  );
}

/* ----------------------------------------------------------------- statics */

const A11Y_ACTIONS = [{ name: 'longpress', label: 'More options' }] as const;

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  center: { alignItems: 'center', justifyContent: 'center' },
  grow: { flexShrink: 1 },
});

export default DocumentTile;
