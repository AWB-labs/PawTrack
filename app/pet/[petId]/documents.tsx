/**
 * The document library.
 *
 * Almost everything in here is a photograph of a piece of paper, so the screen
 * is a grid of pictures rather than a list of filenames — you recognise the
 * x-ray before you read the word "x-ray".
 *
 * Three things it gets right on purpose:
 *
 *   · **Opening a document is full-screen and pinchable.** The whole reason to
 *     keep an x-ray in an app is to be able to zoom into it in a consulting
 *     room. Double-tap zooms, pinch scales, and letting go under 1× springs
 *     back — anything less and people screenshot the screen instead.
 *   · **Export is a first-class action, not a hidden one.** A vet asks you to
 *     email the record; `expo-sharing` hands the real file to Mail, and a remote
 *     URL degrades to sharing the link rather than failing silently.
 *   · **Delete is owner-only and therefore absent for sitters.** `document.delete`
 *     can never be granted to a caregiver, so showing it greyed out would read
 *     as a threat rather than an explanation. Uploading, which *is* grantable,
 *     stays visible and explains itself.
 */

import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  clamp,
  FadeIn,
  FadeInDown,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type WithSpringConfig,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useDeleteDocument, useDocuments } from '@/data/queries/useHealth';
import type { DocumentKind, PetDocument } from '@/data/types';
import {
  describeDocument,
  DOCUMENT_KIND_META,
  DOCUMENT_KINDS,
  DocumentTile,
  documentPreviewUri,
  isImageDocument,
} from '@/features/health/DocumentTile';
import { usePetScope } from '@/features/pets/PetScope';
import { friendlyDateTime } from '@/lib/date';
import { openAppSettings, toHref } from '@/lib/deeplinks';
import { formatFileSize, plural, possessive } from '@/lib/format';
import haptics from '@/lib/haptics';
import { isDismissed, shareDocument } from '@/lib/share';
import { DENIAL_COPY, type DenialReason } from '@/rbac/permissions';
import { usePermission } from '@/rbac/usePermission';
import { darkPalette, spring, useTheme } from '@/theme';
import {
  Button,
  Chip,
  Column,
  ConfirmSheet,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  ListRow,
  Row,
  Screen,
  ScreenHeader,
  SectionHeader,
  Sheet,
  Text,
  toast,
  useSheet,
  type IconName,
} from '@/ui';
import { EmptyDocuments, PermissionLocked } from '@/ui/illustrations';
import { Skeleton, SkeletonGroup } from '@/ui/Skeleton';

/* -------------------------------------------------------------------- types */

type KindFilter = DocumentKind | 'all';

type PickedFile = {
  uri: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
};

/* ---------------------------------------------------------------- constants */

const STAGGER_CAP = 8;

/** Two across is the widest a 4:5 tile can be and still show its title. */
const COLUMNS = 2;

/** Zoom ceiling. Past 5× an 1800px scan is just pixels. */
const MAX_ZOOM = 5;

/** See the `@/ui` primitives: the theme's `springWith` helper doesn't type-check yet. */
const ZOOM_SPRING: WithSpringConfig = { ...spring.snappy, reduceMotion: ReduceMotion.System };

/* ------------------------------------------------------------------ helpers */

function denial(reason: DenialReason | null): { title: string; body: string } {
  return DENIAL_COPY[reason ?? 'not-granted'];
}

/** Best-effort MIME from a filename, for pickers that don't report one. */
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

/* ---------------------------------------------------------------- component */

export default function DocumentsScreen() {
  const t = useTheme();
  const router = useRouter();
  const scope = usePetScope();
  const petId = scope.petId;
  const pet = scope.pet;
  const { width } = useWindowDimensions();
  const { focus } = useLocalSearchParams<{ focus?: string }>();

  const canView = usePermission('document.view', petId);
  const canUpload = usePermission('document.upload', petId);
  const canDelete = usePermission('document.delete', petId);

  const documentsQuery = useDocuments(canView.allowed ? petId : null);
  const deleteDocument = useDeleteDocument(petId);

  const [filter, setFilter] = useState<KindFilter>('all');
  const [viewing, setViewing] = useState<PetDocument | null>(null);
  const [selected, setSelected] = useState<PetDocument | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [picking, setPicking] = useState(false);

  const sourceSheet = useSheet();
  const actionSheet = useSheet();
  const deleteSheet = useSheet();

  const documents = useMemo(() => documentsQuery.data ?? [], [documentsQuery.data]);

  /* ---- deep link straight to one file ----------------------------------- */

  // Consumed once: the param stays in the URL after the viewer closes, so
  // without the latch a background refetch would reopen it under the user.
  const focusConsumed = useRef(false);
  useEffect(() => {
    if (!focus || focusConsumed.current) return;
    const match = documents.find((document) => document.id === focus);
    if (!match) return;
    focusConsumed.current = true;
    setViewing(match);
  }, [documents, focus]);

  /* ---- filtering -------------------------------------------------------- */

  const counts = useMemo(() => {
    const map = new Map<DocumentKind, number>();
    for (const document of documents) {
      map.set(document.kind, (map.get(document.kind) ?? 0) + 1);
    }
    return map;
  }, [documents]);

  const visible = useMemo(
    () => (filter === 'all' ? documents : documents.filter((document) => document.kind === filter)),
    [documents, filter],
  );

  const cellWidth = (width - t.gutter * 2 - t.spacing.md * (COLUMNS - 1)) / COLUMNS;

  /* ---- actions ---------------------------------------------------------- */

  const explainWith = useMemo(() => ({ petName: pet?.name ?? null }), [pet?.name]);

  const goToUploadForm = useCallback(
    (file: PickedFile) => {
      // Hand-built rather than `URLSearchParams`: a picked file URI is full of
      // characters a route parser will happily mangle, and this is the one
      // place we need to be certain nothing is re-encoded twice.
      const query = [
        `petId=${encodeURIComponent(petId)}`,
        `uri=${encodeURIComponent(file.uri)}`,
        `name=${encodeURIComponent(file.name)}`,
        `mime=${encodeURIComponent(file.mimeType)}`,
        file.sizeBytes === null ? null : `size=${file.sizeBytes}`,
      ]
        .filter((part): part is string => part !== null)
        .join('&');
      router.push(toHref(`/record/document?${query}`));
    },
    [petId, router],
  );

  const warnAboutPermission = useCallback((what: 'camera' | 'photos') => {
    haptics.warn();
    toast.warning(
      what === 'camera' ? 'Petal can’t reach the camera yet' : 'Petal can’t see your photos yet',
      {
        id: 'documents-permission',
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

        const name = asset.fileName ?? (source === 'camera' ? 'Camera photo' : 'Photo');
        sourceSheet.close();
        goToUploadForm({
          uri: asset.uri,
          name,
          mimeType: asset.mimeType ?? guessMimeType(name, 'image/jpeg'),
          sizeBytes: asset.fileSize ?? null,
        });
      } finally {
        setPicking(false);
      }
    },
    [goToUploadForm, sourceSheet, warnAboutPermission],
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

      sourceSheet.close();
      goToUploadForm({
        uri: asset.uri,
        name: asset.name,
        mimeType: asset.mimeType ?? guessMimeType(asset.name, 'application/octet-stream'),
        sizeBytes: asset.size ?? null,
      });
    } finally {
      setPicking(false);
    }
  }, [goToUploadForm, sourceSheet]);

  const startUpload = useCallback(() => {
    if (canUpload.allowed) sourceSheet.open();
    else canUpload.explain(explainWith);
  }, [canUpload, explainWith, sourceSheet]);

  const exportDocument = useCallback(async (document: PetDocument) => {
    const outcome = await shareDocument({
      uri: document.uri,
      title: document.title,
      mimeType: document.mimeType,
    });
    if (outcome.ok || isDismissed(outcome)) return;
    toast.error('That file wouldn’t hand over', { description: outcome.message });
  }, []);

  const openActions = useCallback(
    (document: PetDocument) => {
      setSelected(document);
      actionSheet.open();
    },
    [actionSheet],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await documentsQuery.refetch();
    } finally {
      setRefreshing(false);
    }
  }, [documentsQuery]);

  const enter = useCallback(
    (index: number) =>
      t.reduceMotion
        ? FadeIn.duration(t.motion.duration.base).delay(
            Math.min(index, STAGGER_CAP) * t.motion.stagger.tight,
          )
        : FadeInDown.duration(t.motion.duration.slow)
            .delay(Math.min(index, STAGGER_CAP) * t.motion.stagger.base)
            .easing(t.motion.easing.decelerate),
    [t.motion, t.reduceMotion],
  );

  const uploadDisabledReason = canUpload.allowed ? undefined : denial(canUpload.reason).title;

  /* ---- chrome ----------------------------------------------------------- */

  const header = (
    <ScreenHeader
      title="Documents"
      subtitle={pet ? `${possessive(pet.name)} records, x-rays and paperwork` : undefined}
      actions={
        <IconButton
          icon="cloud-upload-outline"
          accessibilityLabel="Add a document"
          accessibilityHint={pet ? `Adds a file to ${possessive(pet.name)} library.` : undefined}
          variant="tonal"
          tone="primary"
          loading={picking}
          disabledReason={uploadDisabledReason}
          onPress={startUpload}
        />
      }
    />
  );

  /* ---- states ----------------------------------------------------------- */

  if (!canView.allowed) {
    return (
      <Screen header={header} center>
        <EmptyState
          tone="warning"
          illustration={<PermissionLocked size={t.spacing.colossal * 3} />}
          headline="Documents aren’t part of your access"
          body={denial(canView.reason).body}
          action={{
            label: 'Back to the profile',
            icon: 'arrow-back',
            onPress: () => router.replace(toHref(`/pet/${petId}`)),
          }}
          secondaryAction={{
            label: 'Why can’t I see these?',
            icon: 'help-circle-outline',
            onPress: () => canView.explain(explainWith),
          }}
        />
      </Screen>
    );
  }

  if (documentsQuery.isPending || !pet) {
    return (
      <Screen header={header} scroll>
        <SkeletonGroup label="Loading the document library" gap="md">
          <Row gap="md" wrap>
            {Array.from({ length: 4 }, (_, index) => (
              <View key={index} style={{ width: cellWidth, gap: t.spacing.sm }}>
                <Skeleton w="100%" h={cellWidth * 1.25} r="xl" />
                <Skeleton w="80%" h={t.type.subheadStrong.fontSize} r="xs" />
                <Skeleton w="52%" h={t.type.caption.fontSize} r="xs" dim />
              </View>
            ))}
          </Row>
        </SkeletonGroup>
      </Screen>
    );
  }

  if (documentsQuery.isError) {
    return (
      <Screen header={header} center>
        <ErrorState
          error={documentsQuery.error}
          title="We couldn’t open the library"
          body={`${possessive(pet.name)} files are safe where they are — the app just couldn't list them this time.`}
          onRetry={() => documentsQuery.refetch()}
        />
      </Screen>
    );
  }

  if (documents.length === 0) {
    return (
      <Screen header={header} center>
        <EmptyState
          illustration={<EmptyDocuments size={t.spacing.colossal * 3} />}
          headline={`Nothing filed for ${pet.name} yet`}
          body="Photograph the vaccination card, the last invoice, the insurance policy. Then it's on your phone at the vet's desk instead of in a drawer at home."
          action={{
            label: 'Add the first one',
            icon: 'cloud-upload-outline',
            onPress: startUpload,
            disabledReason: uploadDisabledReason,
            accessibilityHint: 'Opens the camera, your photos or your files.',
          }}
        />
        <SourceSheet
          controller={sourceSheet}
          busy={picking}
          onCamera={() => void pickImage('camera')}
          onLibrary={() => void pickImage('library')}
          onFiles={() => void pickFile()}
        />
      </Screen>
    );
  }

  /* ---- content ---------------------------------------------------------- */

  return (
    <Screen
      header={header}
      scroll
      refreshing={refreshing}
      onRefresh={() => {
        void refresh();
      }}
      contentContainerStyle={{ gap: t.spacing.lg, paddingBottom: t.spacing.xxl }}
      footer={
        <Button
          label="Add a document"
          onPress={startUpload}
          variant="primary"
          size="lg"
          fullWidth
          hero
          leftIcon="cloud-upload-outline"
          loading={picking}
          disabledReason={uploadDisabledReason}
          accessibilityHint="Opens the camera, your photos or your files."
        />
      }
    >
      <Animated.View entering={enter(0)}>
        <Row gap="sm" wrap accessibilityLabel="Filter by kind">
          <Chip
            label={`All ${documents.length}`}
            selected={filter === 'all'}
            size="sm"
            onPress={() => setFilter('all')}
            accessibilityLabel={`All documents, ${documents.length}`}
          />
          {DOCUMENT_KINDS.filter((kind) => (counts.get(kind) ?? 0) > 0).map((kind) => {
            const meta = DOCUMENT_KIND_META[kind];
            const count = counts.get(kind) ?? 0;
            return (
              <Chip
                key={kind}
                label={`${meta.short} ${count}`}
                icon={meta.icon}
                selected={filter === kind}
                size="sm"
                onPress={() => setFilter(kind)}
                accessibilityLabel={`${meta.label}, ${plural(count, 'file')}`}
              />
            );
          })}
        </Row>
      </Animated.View>

      <Animated.View entering={enter(1)}>
        <SectionHeader
          title={filter === 'all' ? 'Everything on file' : DOCUMENT_KIND_META[filter].label}
          subtitle={
            filter === 'all'
              ? 'Tap to open full screen. Long-press for options.'
              : DOCUMENT_KIND_META[filter].hint
          }
          count={visible.length}
          icon="folder-outline"
          iconColor="textTertiary"
          first
        />
      </Animated.View>

      {visible.length === 0 ? (
        <EmptyState
          variant="compact"
          frame
          icon={DOCUMENT_KIND_META[filter === 'all' ? 'other' : filter].icon}
          tone="neutral"
          headline="Nothing here yet"
          body={`No ${filter === 'all' ? 'documents' : DOCUMENT_KIND_META[filter].label.toLowerCase()} filed for ${pet.name}.`}
          action={{
            label: 'Add one',
            icon: 'add',
            onPress: startUpload,
            disabledReason: uploadDisabledReason,
          }}
        />
      ) : (
        <Row gap="md" wrap align="start">
          {visible.map((document, index) => (
            <Animated.View key={document.id} entering={enter(index + 2)} style={{ width: cellWidth }}>
              <DocumentTile
                document={document}
                onPress={() => setViewing(document)}
                onLongPress={() => openActions(document)}
              />
            </Animated.View>
          ))}
        </Row>
      )}

      {/* ---- source picker ------------------------------------------------ */}
      <SourceSheet
        controller={sourceSheet}
        busy={picking}
        onCamera={() => void pickImage('camera')}
        onLibrary={() => void pickImage('library')}
        onFiles={() => void pickFile()}
      />

      {/* ---- per-file actions --------------------------------------------- */}
      <Sheet controller={actionSheet} title={selected?.title ?? 'Document'} subtitle={selected ? describeDocument(selected) : undefined}>
        <Column gap="xxs">
          <ListRow
            icon="expand-outline"
            title="Open full screen"
            subtitle="Pinch and double-tap to zoom right in"
            onPress={() => {
              actionSheet.close();
              if (selected) setViewing(selected);
            }}
          />
          <ListRow
            icon="share-outline"
            iconTone="accent"
            title="Share or export"
            subtitle="Send it to your vet, your insurer, or your own files"
            onPress={() => {
              actionSheet.close();
              if (selected) void exportDocument(selected);
            }}
          />
          {/* `document.delete` is owner-only and can never be granted, so a
              sitter gets no row at all rather than a locked one. */}
          {canDelete.allowed ? (
            <ListRow
              icon="trash-outline"
              destructive
              title="Remove from the library"
              subtitle="The file goes for everyone you've shared this pet with"
              chevron={false}
              onPress={() => {
                actionSheet.close();
                deleteSheet.open();
              }}
            />
          ) : null}
        </Column>
      </Sheet>

      <ConfirmSheet
        controller={deleteSheet}
        title={selected ? `Remove “${selected.title}”?` : 'Remove this document?'}
        body={`It disappears from ${possessive(pet.name)} library for you and for everyone you've shared them with. Records that link to it will simply stop showing it.`}
        confirmLabel="Remove it"
        cancelLabel="Keep it"
        icon="trash-outline"
        onConfirm={async () => {
          if (!selected) return;
          await deleteDocument.mutateAsync(selected.id);
          toast.success('Document removed', { description: `“${selected.title}” is gone.` });
          setSelected(null);
        }}
      />

      {/* ---- full-screen viewer ------------------------------------------- */}
      <DocumentViewer
        document={viewing}
        onClose={() => setViewing(null)}
        onShare={(document) => void exportDocument(document)}
      />
    </Screen>
  );
}

/* ------------------------------------------------------------ source sheet */

type SourceSheetProps = {
  controller: ReturnType<typeof useSheet>;
  busy: boolean;
  onCamera: () => void;
  onLibrary: () => void;
  onFiles: () => void;
};

/**
 * Three ways in, in the order people reach for them: the thing in front of you,
 * the thing you photographed earlier, the thing someone emailed you.
 */
function SourceSheet({ controller, busy, onCamera, onLibrary, onFiles }: SourceSheetProps) {
  return (
    <Sheet
      controller={controller}
      title="Add a document"
      subtitle="Anything worth keeping — we’ll ask what it is next."
    >
      <Column gap="xxs">
        <SourceRow
          icon="camera-outline"
          title="Take a photo"
          subtitle="Best for a card, a letter or a printed result"
          busy={busy}
          onPress={onCamera}
        />
        <SourceRow
          icon="images-outline"
          title="Choose from photos"
          subtitle="One you already took at the clinic"
          busy={busy}
          onPress={onLibrary}
        />
        <SourceRow
          icon="folder-open-outline"
          title="Pick a file"
          subtitle="A PDF your vet or insurer emailed over"
          busy={busy}
          onPress={onFiles}
        />
      </Column>
    </Sheet>
  );
}

function SourceRow({
  icon,
  title,
  subtitle,
  busy,
  onPress,
}: {
  icon: IconName;
  title: string;
  subtitle: string;
  busy: boolean;
  onPress: () => void;
}) {
  return (
    <ListRow
      icon={icon}
      title={title}
      subtitle={subtitle}
      disabled={busy}
      onPress={onPress}
      accessibilityHint={subtitle}
    />
  );
}

/* ---------------------------------------------------------------- viewer */

type DocumentViewerProps = {
  document: PetDocument | null;
  onClose: () => void;
  onShare: (document: PetDocument) => void;
};

/**
 * Full-screen, on its own black ground, with the chrome floating over it.
 *
 * The gesture stack is deliberately small: pinch to scale, drag to move, double
 * tap to snap between fit and 2.5×. Releasing under 1× springs back to fit,
 * which is what makes over-pinching feel elastic rather than broken.
 */
function DocumentViewer({ document, onClose, onShare }: DocumentViewerProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);

  const reset = useCallback(() => {
    scale.value = 1;
    savedScale.value = 1;
    tx.value = 0;
    ty.value = 0;
    savedX.value = 0;
    savedY.value = 0;
  }, [savedScale, savedX, savedY, scale, tx, ty]);

  useEffect(() => {
    if (document) reset();
  }, [document, reset]);

  const gesture = useMemo(() => {
    const settle = () => {
      'worklet';
      if (scale.value <= 1) {
        scale.value = withSpring(1, ZOOM_SPRING);
        tx.value = withSpring(0, ZOOM_SPRING);
        ty.value = withSpring(0, ZOOM_SPRING);
        savedScale.value = 1;
        savedX.value = 0;
        savedY.value = 0;
        return;
      }
      savedScale.value = scale.value;
      savedX.value = tx.value;
      savedY.value = ty.value;
    };

    const pinch = Gesture.Pinch()
      .onUpdate((event) => {
        scale.value = clamp(savedScale.value * event.scale, 0.6, MAX_ZOOM);
      })
      .onEnd(settle);

    const pan = Gesture.Pan()
      .minPointers(1)
      .onUpdate((event) => {
        // Panning a fitted page would just slide it off the screen.
        if (savedScale.value <= 1) return;
        const limitX = (width * (savedScale.value - 1)) / 2;
        const limitY = (height * (savedScale.value - 1)) / 2;
        tx.value = clamp(savedX.value + event.translationX, -limitX, limitX);
        ty.value = clamp(savedY.value + event.translationY, -limitY, limitY);
      })
      .onEnd(settle);

    const doubleTap = Gesture.Tap()
      .numberOfTaps(2)
      .onEnd(() => {
        const zoomed = scale.value > 1.05;
        const next = zoomed ? 1 : 2.5;
        scale.value = withSpring(next, ZOOM_SPRING);
        savedScale.value = next;
        if (zoomed) {
          tx.value = withSpring(0, ZOOM_SPRING);
          ty.value = withSpring(0, ZOOM_SPRING);
          savedX.value = 0;
          savedY.value = 0;
        }
      });

    // Race, not Simultaneous: a double tap and a drag are different intentions,
    // and letting both fire means every zoom-in also nudges the page sideways.
    return Gesture.Race(doubleTap, Gesture.Simultaneous(pinch, pan));
  }, [height, savedScale, savedX, savedY, scale, tx, ty, width]);

  const imageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  const preview = document ? documentPreviewUri(document) : null;
  const showImage = document !== null && isImageDocument(document) && preview !== null;

  return (
    <Modal
      visible={document !== null}
      transparent={false}
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <GestureHandlerRootView style={styles.flex}>
        {/* Media viewers are dark in both schemes — a white surround changes how
            a radiograph reads. The ground is still a token, just a fixed one. */}
        <View style={[styles.flex, { backgroundColor: darkPalette.bgSunken }]}>
          {document === null ? null : (
            <>
              {showImage ? (
                <GestureDetector gesture={gesture}>
                  <Animated.View style={styles.flex}>
                    <Animated.View style={[styles.flex, imageStyle]}>
                      <Image
                        source={{ uri: document.uri }}
                        style={StyleSheet.absoluteFill}
                        contentFit="contain"
                        transition={t.motion.duration.base}
                        accessibilityIgnoresInvertColors
                        accessibilityLabel={document.title}
                      />
                    </Animated.View>
                  </Animated.View>
                </GestureDetector>
              ) : (
                <Column flex align="center" justify="center" gap="base" style={{ padding: t.gutter }}>
                  <View
                    style={{
                      width: t.spacing.colossal,
                      height: t.spacing.colossal,
                      borderRadius: t.radius.xxl,
                      backgroundColor: darkPalette.surfaceAlt,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Icon
                      name={DOCUMENT_KIND_META[document.kind].icon}
                      size="xxl"
                      color={darkPalette.textSecondary}
                    />
                  </View>
                  <Text variant="title2" color={darkPalette.text} align="center">
                    {document.title}
                  </Text>
                  <Text variant="footnote" color={darkPalette.textSecondary} align="center">
                    {`${DOCUMENT_KIND_META[document.kind].label} · ${formatFileSize(document.sizeBytes)}`}
                  </Text>
                  <Text variant="footnote" color={darkPalette.textSecondary} align="center">
                    Petal can’t preview this kind of file, but your phone can — open it in another app.
                  </Text>
                </Column>
              )}

              {/* ---- floating chrome ---------------------------------------- */}
              <Animated.View
                entering={FadeIn.duration(t.motion.duration.base)}
                pointerEvents="box-none"
                style={[styles.topBar, { paddingTop: insets.top + t.spacing.sm, paddingHorizontal: t.spacing.md }]}
              >
                <Row justify="between" gap="sm">
                  <IconButton
                    icon="close"
                    accessibilityLabel="Close"
                    accessibilityHint="Goes back to the library."
                    variant="glass"
                    tone="neutral"
                    onPress={onClose}
                  />
                  <IconButton
                    icon="share-outline"
                    accessibilityLabel="Share or export"
                    accessibilityHint="Hands this file to another app."
                    variant="glass"
                    tone="neutral"
                    onPress={() => onShare(document)}
                  />
                </Row>
              </Animated.View>

              <Animated.View
                entering={FadeIn.duration(t.motion.duration.base).delay(t.motion.stagger.base)}
                pointerEvents="none"
                style={[
                  styles.bottomBar,
                  { paddingBottom: insets.bottom + t.spacing.base, paddingHorizontal: t.gutter },
                ]}
              >
                <Column gap="hair">
                  <Text variant="headline" color={darkPalette.text} numberOfLines={2}>
                    {document.title}
                  </Text>
                  <Text variant="caption" color={darkPalette.textSecondary} numberOfLines={1}>
                    {`${DOCUMENT_KIND_META[document.kind].label} · added ${friendlyDateTime(document.uploadedAt)}`}
                  </Text>
                  {showImage ? (
                    <Text variant="caption" color={darkPalette.textTertiary}>
                      Pinch or double-tap to zoom
                    </Text>
                  ) : null}
                </Column>
              </Animated.View>
            </>
          )}
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

/* ----------------------------------------------------------------- statics */

const styles = StyleSheet.create({
  flex: { flex: 1 },
  topBar: { position: 'absolute', top: 0, left: 0, right: 0 },
  bottomBar: { position: 'absolute', bottom: 0, left: 0, right: 0 },
});
