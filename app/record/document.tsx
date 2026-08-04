/**
 * File a document.
 *
 * The upload itself is the easy part; the value is in the two questions asked
 * either side of it — what is this, and what should it be called — because a
 * library of `IMG_4471.jpg` is a drawer, not a record.
 *
 * So the screen shows the file large, guesses the title from the filename and
 * the kind from what's in it, and asks you to confirm rather than to type. The
 * seven kinds are a row of glyphs with a line of plain English underneath each,
 * because "record vs other" is a real decision and a dropdown hides it.
 *
 * **Editing is a replacement, and that's on purpose.** The data layer has no
 * update for a filed document — a stored file is deliberately append-only — so
 * correcting one means writing the corrected copy and retiring the original.
 * That needs `document.delete`, which is owner-only and can never be granted, so
 * a sitter who follows an edit link gets the authored explanation rather than a
 * form that would half-work.
 */

import * as DocumentPicker from 'expo-document-picker';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { useDeleteDocument, useDocuments, useUploadDocument } from '@/data/queries/useHealth';
import { usePet } from '@/data/queries/usePets';
import type { DocumentKind } from '@/data/types';
import { DOCUMENT_KIND_META, DOCUMENT_KINDS } from '@/features/health/DocumentTile';
import { openAppSettings, toHref } from '@/lib/deeplinks';
import { formatFileSize, possessive } from '@/lib/format';
import haptics from '@/lib/haptics';
import { DENIAL_COPY, type DenialReason } from '@/rbac/permissions';
import { usePermission } from '@/rbac/usePermission';
import { useTheme } from '@/theme';
import {
  Button,
  Column,
  EmptyState,
  Icon,
  IconButton,
  Input,
  ListRow,
  Row,
  Screen,
  ScreenHeader,
  SectionHeader,
  Sheet,
  Surface,
  Text,
  toast,
  Touchable,
  useSheet,
} from '@/ui';
import { EmptyDocuments, PermissionLocked } from '@/ui/illustrations';
import { SkeletonGroup } from '@/ui/Skeleton';
import { ListRowSkeleton } from '@/ui/skeletons/ContentSkeletons';

/* -------------------------------------------------------------------- types */

type PickedFile = {
  uri: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
};

/* ---------------------------------------------------------------- constants */

const TITLE_MAX = 70;

/** A photographed page is one page; anything else we genuinely don't know. */
const IMAGE_PAGE_COUNT = 1;

/* ------------------------------------------------------------------ helpers */

function denial(reason: DenialReason | null): { title: string; body: string } {
  return DENIAL_COPY[reason ?? 'not-granted'];
}

function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

function guessMimeType(name: string, fallback: string): string {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  switch (extension) {
    case 'pdf':
      return 'application/pdf';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'heic':
    case 'heif':
      return 'image/heic';
    case 'webp':
      return 'image/webp';
    case 'txt':
      return 'text/plain';
    default:
      return fallback;
  }
}

/** `scan_invoice-2026.pdf` → `Scan invoice 2026`. A starting point, not a rule. */
function titleFromFilename(name: string): string {
  const withoutExtension = name.replace(/\.[^./\\]+$/, '');
  const cleaned = withoutExtension.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return 'Document';
  return `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}`;
}

/** Filenames are surprisingly honest about what's inside them. */
function guessKind(name: string, mimeType: string): DocumentKind {
  const haystack = name.toLowerCase();
  if (/invoice|receipt|bill/.test(haystack)) return 'invoice';
  if (/x-?ray|radiograph|scan|ultrasound/.test(haystack)) return 'xray';
  if (/prescription|\brx\b|dosage/.test(haystack)) return 'prescription';
  if (/insurance|policy|claim/.test(haystack)) return 'insurance';
  if (/record|history|result|report|certificate|vaccin/.test(haystack)) return 'record';
  return isImageMime(mimeType) ? 'photo' : 'record';
}

/* ------------------------------------------------------------------- route */

export default function RecordDocumentScreen() {
  const t = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{
    petId?: string;
    id?: string;
    uri?: string;
    name?: string;
    mime?: string;
    size?: string;
  }>();

  const petId = params.petId ?? '';
  const documentId = params.id ?? null;

  const petQuery = usePet(petId);
  const pet = petQuery.data ?? null;
  const canUpload = usePermission('document.upload', petId);
  const canDelete = usePermission('document.delete', petId);
  const canViewDocuments = usePermission('document.view', petId);

  const documentsQuery = useDocuments(
    documentId && canViewDocuments.allowed ? petId : null,
  );
  const existing = useMemo(
    () => (documentId ? (documentsQuery.data?.find((row) => row.id === documentId) ?? null) : null),
    [documentId, documentsQuery.data],
  );

  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace(toHref(`/pet/${petId}/documents`));
  }, [petId, router]);

  const header = (
    <ScreenHeader
      title={documentId ? 'Correct a document' : 'Add a document'}
      large={false}
      showBack={false}
      leading={
        <IconButton
          icon="close"
          accessibilityLabel="Close"
          accessibilityHint="Closes without saving."
          variant="ghost"
          tone="neutral"
          onPress={close}
        />
      }
    />
  );

  if (!canUpload.allowed) {
    return (
      <Screen header={header} center>
        <EmptyState
          tone="warning"
          illustration={<PermissionLocked size={t.spacing.colossal * 3} />}
          headline="Adding files isn’t part of your access"
          body={denial(canUpload.reason).body}
          action={{ label: 'Back', icon: 'arrow-back', onPress: close }}
          secondaryAction={{
            label: 'Why can’t I do this?',
            icon: 'help-circle-outline',
            onPress: () => canUpload.explain({ petName: pet?.name ?? null }),
          }}
        />
      </Screen>
    );
  }

  // Correcting a filed document means writing a new one and retiring the old,
  // and retiring is owner-only. Say so properly rather than half-working.
  if (documentId && !canDelete.allowed) {
    return (
      <Screen header={header} center>
        <EmptyState
          tone="warning"
          illustration={<PermissionLocked size={t.spacing.colossal * 3} />}
          headline="Only the owner can change a filed document"
          body={`You can still add new files to ${possessive(pet?.name ?? 'this pet')} library — it's editing one that's already there that stays with them.`}
          action={{ label: 'Add a new file instead', icon: 'cloud-upload-outline', onPress: () => router.replace(toHref(`/record/document?petId=${petId}`)) }}
          secondaryAction={{ label: 'Back', icon: 'arrow-back', onPress: close }}
        />
      </Screen>
    );
  }

  if (documentId && documentsQuery.isPending) {
    return (
      <Screen header={header} scroll>
        <SkeletonGroup label="Loading this document" gap="xl">
          <ListRowSkeleton count={3} avatar={false} />
        </SkeletonGroup>
      </Screen>
    );
  }

  const handed: PickedFile | null = params.uri
    ? {
        uri: params.uri,
        name: params.name ?? 'Document',
        mimeType: params.mime ?? guessMimeType(params.name ?? '', 'application/octet-stream'),
        sizeBytes: params.size ? Number(params.size) : null,
      }
    : existing
      ? {
          uri: existing.uri,
          name: existing.title,
          mimeType: existing.mimeType,
          sizeBytes: existing.sizeBytes,
        }
      : null;

  return (
    <DocumentForm
      petId={petId}
      petName={pet?.name ?? null}
      replacingId={existing?.id ?? null}
      initialFile={handed}
      initialTitle={existing?.title ?? (handed ? titleFromFilename(handed.name) : '')}
      initialKind={existing?.kind ?? (handed ? guessKind(handed.name, handed.mimeType) : 'record')}
      onClose={close}
    />
  );
}

/* -------------------------------------------------------------------- form */

type DocumentFormProps = {
  petId: string;
  petName: string | null;
  /** Set when we're correcting a filed document — the old row to retire. */
  replacingId: string | null;
  initialFile: PickedFile | null;
  initialTitle: string;
  initialKind: DocumentKind;
  onClose: () => void;
};

function DocumentForm({
  petId,
  petName,
  replacingId,
  initialFile,
  initialTitle,
  initialKind,
  onClose,
}: DocumentFormProps) {
  const t = useTheme();

  const upload = useUploadDocument(petId);
  const removeOld = useDeleteDocument(petId);
  const sourceSheet = useSheet();

  const [file, setFile] = useState<PickedFile | null>(initialFile);
  const [title, setTitle] = useState(initialTitle);
  const [kind, setKind] = useState<DocumentKind>(initialKind);
  const [titleTouched, setTitleTouched] = useState(false);
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);

  const name = petName ?? 'your pet';
  const trimmedTitle = title.trim();
  const titleError =
    titleTouched && trimmedTitle.length === 0
      ? 'Give it a name you’d recognise in a hurry.'
      : undefined;

  const dirty =
    replacingId === null ||
    trimmedTitle !== initialTitle.trim() ||
    kind !== initialKind ||
    file?.uri !== initialFile?.uri;

  const valid = file !== null && trimmedTitle.length > 0;

  /* ---- picking ---------------------------------------------------------- */

  const warnAboutPermission = useCallback((what: 'camera' | 'photos') => {
    haptics.warn();
    toast.warning(
      what === 'camera' ? 'Petal can’t reach the camera yet' : 'Petal can’t see your photos yet',
      {
        id: 'record-document-permission',
        description: 'Your phone is holding it back. Turn it on in Settings and we’ll be ready.',
        action: {
          label: 'Open Settings',
          onPress: () => {
            void openAppSettings();
          },
        },
      },
    );
  }, []);

  const accept = useCallback(
    (picked: PickedFile) => {
      setFile(picked);
      // A title the user has already edited is theirs; only fill a blank one.
      if (!titleTouched && trimmedTitle.length === 0) {
        setTitle(titleFromFilename(picked.name));
        setKind(guessKind(picked.name, picked.mimeType));
      }
      sourceSheet.close();
      haptics.success();
    },
    [sourceSheet, titleTouched, trimmedTitle.length],
  );

  const pickImage = useCallback(
    async (source: 'camera' | 'library') => {
      setPicking(true);
      try {
        const permission =
          source === 'camera'
            ? await ImagePicker.requestCameraPermissionsAsync()
            : await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) {
          warnAboutPermission(source === 'camera' ? 'camera' : 'photos');
          return;
        }

        const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.85 };
        const result =
          source === 'camera'
            ? await ImagePicker.launchCameraAsync(options)
            : await ImagePicker.launchImageLibraryAsync(options);
        if (result.canceled) return;
        const asset = result.assets[0];
        if (!asset) return;

        const filename = asset.fileName ?? (source === 'camera' ? 'Camera photo' : 'Photo');
        accept({
          uri: asset.uri,
          name: filename,
          mimeType: asset.mimeType ?? guessMimeType(filename, 'image/jpeg'),
          sizeBytes: asset.fileSize ?? null,
        });
      } finally {
        setPicking(false);
      }
    },
    [accept, warnAboutPermission],
  );

  const pickFile = useCallback(async () => {
    setPicking(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        multiple: false,
        // Without the copy the URI can expire before the upload finishes.
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;

      accept({
        uri: asset.uri,
        name: asset.name,
        mimeType: asset.mimeType ?? guessMimeType(asset.name, 'application/octet-stream'),
        sizeBytes: asset.size ?? null,
      });
    } finally {
      setPicking(false);
    }
  }, [accept]);

  /* ---- saving ----------------------------------------------------------- */

  const save = useCallback(async () => {
    if (trimmedTitle.length === 0) {
      setTitleTouched(true);
      haptics.warn();
      return;
    }
    if (!valid || !file || saving) {
      haptics.warn();
      return;
    }

    setSaving(true);
    try {
      const image = isImageMime(file.mimeType);
      await upload.mutateAsync({
        title: trimmedTitle,
        kind,
        mimeType: file.mimeType,
        uri: file.uri,
        thumbnailUri: image ? file.uri : null,
        sizeBytes: file.sizeBytes,
        pageCount: image ? IMAGE_PAGE_COUNT : null,
      });

      // Written first, retired second: a failure between the two leaves a
      // duplicate, which is recoverable. The other order loses the file.
      if (replacingId) await removeOld.mutateAsync(replacingId);

      haptics.success();
      toast.success(replacingId ? 'Document corrected' : `“${trimmedTitle}” is filed`, {
        description: `In ${possessive(name)} library, ready at the vet's desk.`,
      });
      onClose();
    } catch {
      // The mutation hooks already raise the explanatory toast; this only stops
      // an unhandled rejection escaping a fire-and-forget press handler.
    } finally {
      setSaving(false);
    }
  }, [file, kind, name, onClose, removeOld, replacingId, saving, trimmedTitle, upload, valid]);

  /* ---- chrome ----------------------------------------------------------- */

  const header = (
    <ScreenHeader
      title={replacingId ? 'Correct a document' : 'Add a document'}
      large={false}
      showBack={false}
      leading={
        <IconButton
          icon="close"
          accessibilityLabel="Close"
          accessibilityHint="Closes without saving."
          variant="ghost"
          tone="neutral"
          onPress={onClose}
        />
      }
      actions={
        <Button
          label="Save"
          onPress={() => void save()}
          variant="primary"
          size="sm"
          disabled={!valid || !dirty}
          loading={saving}
          haptic="none"
          accessibilityHint={valid ? 'Files this document.' : 'Pick a file and name it first.'}
        />
      }
    />
  );

  /* ---- nothing picked yet ----------------------------------------------- */

  if (!file) {
    return (
      <Screen header={header} center>
        <EmptyState
          illustration={<EmptyDocuments size={t.spacing.colossal * 2.6} />}
          headline="What are we filing?"
          body="Photograph it, pick one you already took, or choose a file your vet emailed over. We'll ask what it is next."
          actions={
            <Column gap="sm" style={{ alignSelf: 'stretch' }}>
              <Button
                label="Take a photo"
                onPress={() => void pickImage('camera')}
                variant="primary"
                size="lg"
                fullWidth
                hero
                leftIcon="camera-outline"
                loading={picking}
              />
              <Button
                label="Choose from photos"
                onPress={() => void pickImage('library')}
                variant="secondary"
                size="md"
                fullWidth
                leftIcon="images-outline"
                disabled={picking}
              />
              <Button
                label="Pick a file"
                onPress={() => void pickFile()}
                variant="ghost"
                size="md"
                fullWidth
                leftIcon="folder-open-outline"
                disabled={picking}
              />
            </Column>
          }
        />
      </Screen>
    );
  }

  /* ---- the form --------------------------------------------------------- */

  const image = isImageMime(file.mimeType);
  const kindMeta = DOCUMENT_KIND_META[kind];

  return (
    <Screen
      header={header}
      scroll
      contentContainerStyle={{ gap: t.spacing.xl, paddingBottom: t.spacing.xl }}
      footer={
        <Button
          label={replacingId ? 'Save the correction' : `File it under ${kindMeta.short}`}
          onPress={() => void save()}
          variant="primary"
          size="lg"
          fullWidth
          hero
          leftIcon="checkmark"
          disabled={!valid || !dirty}
          loading={saving}
          haptic="none"
        />
      }
    >
      {/* ---- the file ------------------------------------------------------ */}
      <Animated.View entering={FadeIn.duration(t.motion.duration.base)} style={{ gap: t.spacing.md }}>
        <Surface variant="surface" elevation={1} radius="xxl" padding="none" style={styles.clip}>
          <View style={{ aspectRatio: 4 / 3, backgroundColor: t.color.surfaceAlt }}>
            {image ? (
              <Image
                source={{ uri: file.uri }}
                style={StyleSheet.absoluteFill}
                contentFit="contain"
                transition={t.motion.duration.base}
                accessibilityIgnoresInvertColors
                accessibilityLabel="The file you picked"
              />
            ) : (
              <Column flex align="center" justify="center" gap="sm">
                <Icon name={kindMeta.icon} size="xxl" color="textTertiary" />
                <Text variant="footnote" color="textTertiary" numberOfLines={2} align="center">
                  {file.name}
                </Text>
              </Column>
            )}
          </View>

          <Row gap="md" style={{ padding: t.spacing.base }}>
            <Column flex gap="hair">
              <Text variant="caption" color="textTertiary" numberOfLines={1}>
                {file.name}
              </Text>
              <Text variant="caption" color="textFaint" numberOfLines={1}>
                {`${file.mimeType} · ${formatFileSize(file.sizeBytes)}`}
              </Text>
            </Column>
            <Touchable
              accessibilityRole="button"
              accessibilityLabel="Replace this file"
              accessibilityHint="Opens the camera, your photos or your files."
              haptic="tap"
              onPress={() => sourceSheet.open()}
              pressScale="small"
            >
              <Row gap="xxs">
                <Icon name="swap-horizontal" size="xs" color="primaryText" />
                <Text variant="buttonSmall" color="primaryText">
                  Replace
                </Text>
              </Row>
            </Touchable>
          </Row>
        </Surface>
      </Animated.View>

      {/* ---- name ---------------------------------------------------------- */}
      <Animated.View
        entering={FadeInDown.duration(t.motion.duration.slow).delay(t.motion.stagger.base)}
        style={{ gap: t.spacing.md }}
      >
        <SectionHeader
          title="What should we call it?"
          subtitle="The name you'd search for at eight on a Sunday evening."
          icon="text-outline"
          iconColor="primaryText"
          first
        />
        <Surface variant="surface" elevation={1} radius="xl" padding="base">
          <Input
            label="Title"
            value={title}
            onChangeText={setTitle}
            onBlur={() => setTitleTouched(true)}
            error={titleError}
            placeholder="Riverbank Vet invoice — hip assessment"
            leadingIcon="pricetag-outline"
            maxLength={TITLE_MAX}
            autoCapitalize="sentences"
            required
            clearable
          />
        </Surface>
      </Animated.View>

      {/* ---- kind ---------------------------------------------------------- */}
      <Animated.View
        entering={FadeInDown.duration(t.motion.duration.slow).delay(t.motion.stagger.base * 2)}
        style={{ gap: t.spacing.md }}
      >
        <SectionHeader
          title="What kind of thing is it?"
          subtitle="This is what the filter row on the library sorts by."
          icon="albums-outline"
          iconColor="accentText"
        />
        <Surface variant="surface" elevation={1} radius="xl" padding="md" style={{ gap: t.spacing.xxs }}>
          {DOCUMENT_KINDS.map((option) => (
            <KindRow
              key={option}
              kind={option}
              selected={kind === option}
              onPress={() => {
                haptics.select();
                setKind(option);
              }}
            />
          ))}
        </Surface>
      </Animated.View>

      <Animated.View entering={FadeInDown.duration(t.motion.duration.slow).delay(t.motion.stagger.base * 3)}>
        <Row gap="sm" align="start">
          <Icon name="lock-closed-outline" size="sm" color="textTertiary" />
          <Text variant="caption" color="textTertiary" style={{ flex: 1 }}>
            {`Filed against ${name} only. Anyone you've shared them with can see it, and only you can remove it.`}
          </Text>
        </Row>
      </Animated.View>

      {/* ---- replace sheet -------------------------------------------------- */}
      <Sheet
        controller={sourceSheet}
        title="Swap the file"
        subtitle="The title and kind you’ve set will stay as they are."
      >
        <Column gap="xxs">
          <ListRow
            icon="camera-outline"
            title="Take a photo"
            subtitle="Best for a card, a letter or a printed result"
            disabled={picking}
            onPress={() => void pickImage('camera')}
          />
          <ListRow
            icon="images-outline"
            title="Choose from photos"
            subtitle="One you already took at the clinic"
            disabled={picking}
            onPress={() => void pickImage('library')}
          />
          <ListRow
            icon="folder-open-outline"
            title="Pick a file"
            subtitle="A PDF your vet or insurer emailed over"
            disabled={picking}
            onPress={() => void pickFile()}
          />
        </Column>
      </Sheet>
    </Screen>
  );
}

/* ---------------------------------------------------------------- kind row */

/**
 * One filing option. The hint under each label is doing the real work — the
 * difference between "record" and "other" is only obvious once someone tells
 * you what belongs in each.
 */
function KindRow({
  kind,
  selected,
  onPress,
}: {
  kind: DocumentKind;
  selected: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const meta = DOCUMENT_KIND_META[kind];
  const well = t.spacing.xxxl;

  const skin = (() => {
    switch (meta.tone) {
      case 'accent':
        return { fill: t.color.accentSoft, ink: t.color.onAccentSoft };
      case 'success':
        return { fill: t.color.successSoft, ink: t.color.onSuccessSoft };
      case 'warning':
        return { fill: t.color.warningSoft, ink: t.color.onWarningSoft };
      case 'info':
        return { fill: t.color.infoSoft, ink: t.color.onInfoSoft };
      case 'neutral':
        return { fill: t.color.surfaceAlt, ink: t.color.textSecondary };
      default:
        return { fill: t.color.primarySoft, ink: t.color.onPrimarySoft };
    }
  })();

  return (
    <Touchable
      accessibilityRole="radio"
      accessibilityLabel={`${meta.label}. ${meta.hint}`}
      accessibilityState={{ selected, checked: selected }}
      haptic="none"
      onPress={onPress}
      pressScale="large"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.spacing.md,
        padding: t.spacing.md,
        borderRadius: t.radius.lg,
        backgroundColor: selected ? t.color.primarySoft : 'transparent',
      }}
    >
      <View
        style={{
          width: well,
          height: well,
          borderRadius: t.radius.md,
          backgroundColor: skin.fill,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name={meta.icon} size="md" color={skin.ink} />
      </View>

      <Column flex gap="hair">
        <Text variant="bodyStrong" color={selected ? 'onPrimarySoft' : 'text'}>
          {meta.label}
        </Text>
        <Text variant="caption" color="textTertiary" numberOfLines={2}>
          {meta.hint}
        </Text>
      </Column>

      {selected ? (
        <Animated.View entering={FadeIn.duration(t.motion.duration.fast)}>
          <Icon name="checkmark-circle" size="md" color="primary" />
        </Animated.View>
      ) : (
        <Icon name="ellipse-outline" size="md" color="border" />
      )}
    </Touchable>
  );
}

/* ----------------------------------------------------------------- statics */

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
});
