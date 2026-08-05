/**
 * Add or correct a vaccination.
 *
 * The hard part of this form isn't the fields, it's that most people are copying
 * off a paper card in bad handwriting. So the screen is built around getting
 * that transcription right:
 *
 *   · **The vaccine name is offered, not demanded.** A row of the shots that
 *     species actually gets fills the name *and* the core flag in one tap, which
 *     is also how the core/non-core distinction gets recorded correctly instead
 *     of guessed.
 *   · **The next-due date is arithmetic, not memory.** "+1 year" from the date
 *     you just typed is one tap, and the three offsets cover almost every
 *     schedule a practice uses.
 *   · **The form shows its own consequence.** A live status pill says what this
 *     record will look like on the list — "Overdue", "Due soon" — before you
 *     save it, so a mistyped year is caught here rather than by a red card.
 *
 * `vaccination.edit` is grantable to a caregiver, so the whole screen is
 * reachable by a sitter with vet-trip access and refuses politely to anyone else.
 */

import { addMonths, addYears } from 'date-fns';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeInDown, LinearTransition } from 'react-native-reanimated';

import { useDeleteVaccination, useSaveVaccination, useVaccinations } from '@/data/queries/useHealth';
import { usePet } from '@/data/queries/usePets';
import type { DateOnly } from '@/data/types';
import {
  VACCINATION_STATUS_META,
  vaccinationStatus,
} from '@/features/health/VaccinationCard';
import { fromDateOnly, dueLabel, toDateOnly } from '@/lib/date';
import { toHref } from '@/lib/deeplinks';
import { possessive } from '@/lib/format';
import haptics from '@/lib/haptics';
import { DENIAL_COPY, type DenialReason } from '@/rbac/permissions';
import { useNow, usePermission } from '@/rbac/usePermission';
import { useTheme, type SpeciesKey } from '@/theme';
import {
  Badge,
  Button,
  Chip,
  Column,
  ConfirmSheet,
  DateField,
  EmptyState,
  Icon,
  IconButton,
  Input,
  Row,
  Screen,
  ScreenHeader,
  SectionHeader,
  Surface,
  Switch,
  Text,
  TextArea,
  toast,
  useSheet,
} from '@/ui';
import { PermissionLocked } from '@/ui/illustrations';
import { SkeletonGroup } from '@/ui/Skeleton';
import { ListRowSkeleton } from '@/ui/skeletons/ContentSkeletons';

/* -------------------------------------------------------------------- types */

type Suggestion = { name: string; core: boolean };

type Draft = {
  name: string;
  core: boolean;
  administeredAt: DateOnly | null;
  dueAt: DateOnly | null;
  vetName: string;
  clinic: string;
  batchNumber: string;
  notes: string;
  documentIds: string[];
};

/* ---------------------------------------------------------------- constants */

const NAME_MAX = 48;
const FIELD_MAX = 60;
const BATCH_MAX = 32;
const NOTES_MAX = 300;

/**
 * The shots a practice actually gives, per species, with the core flag already
 * right. Not a registry — a shortlist, so the common case is one tap and the
 * uncommon case is still a free-text field.
 */
const SUGGESTIONS: Partial<Record<SpeciesKey, readonly Suggestion[]>> = {
  dog: [
    { name: 'DHPP (distemper, hepatitis, parvo, parainfluenza)', core: true },
    { name: 'Rabies', core: true },
    { name: 'Leptospirosis', core: false },
    { name: 'Kennel cough (Bordetella)', core: false },
    { name: 'Canine influenza', core: false },
  ],
  cat: [
    { name: 'FVRCP (cat flu & enteritis)', core: true },
    { name: 'Rabies', core: true },
    { name: 'Feline leukaemia (FeLV)', core: false },
    { name: 'Chlamydophila', core: false },
  ],
  rabbit: [
    { name: 'Myxomatosis', core: true },
    { name: 'RHD1 & RHD2', core: true },
  ],
  bird: [
    { name: 'Polyomavirus', core: false },
    { name: "Pacheco's disease", core: false },
  ],
};

/** The three schedules that cover nearly every booster interval in practice. */
const OFFSETS: readonly { label: string; months: number }[] = [
  { label: '+6 months', months: 6 },
  { label: '+1 year', months: 12 },
  { label: '+3 years', months: 36 },
];

const EMPTY_DRAFT: Draft = {
  name: '',
  core: true,
  administeredAt: null,
  dueAt: null,
  vetName: '',
  clinic: '',
  batchNumber: '',
  notes: '',
  documentIds: [],
};

/* ------------------------------------------------------------------ helpers */

function denial(reason: DenialReason | null): { title: string; body: string } {
  return DENIAL_COPY[reason ?? 'not-granted'];
}

const blank = (value: string): string | null => (value.trim().length > 0 ? value.trim() : null);

/* ------------------------------------------------------------------- route */

export default function RecordVaccinationScreen() {
  const t = useTheme();
  const router = useRouter();
  const { petId, id } = useLocalSearchParams<{ petId?: string; id?: string }>();
  const resolvedPetId = petId ?? '';

  const petQuery = usePet(resolvedPetId);
  const pet = petQuery.data ?? null;
  const canEdit = usePermission('vaccination.edit', resolvedPetId);
  const vaccinationsQuery = useVaccinations(canEdit.allowed ? resolvedPetId : null);

  const existing = useMemo(
    () => (id ? (vaccinationsQuery.data?.find((row) => row.id === id) ?? null) : null),
    [id, vaccinationsQuery.data],
  );

  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace(toHref(`/pet/${resolvedPetId}/vaccinations`));
  }, [resolvedPetId, router]);

  const header = (
    <ScreenHeader
      title={id ? 'Edit vaccination' : 'Add a vaccination'}
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

  if (!canEdit.allowed) {
    return (
      <Screen header={header} center>
        <EmptyState
          tone="warning"
          illustration={<PermissionLocked size={t.spacing.colossal * 3} />}
          headline="Vaccination records stay with the owner"
          body={denial(canEdit.reason).body}
          action={{ label: 'Back', icon: 'arrow-back', onPress: close }}
          secondaryAction={{
            label: 'Why can’t I do this?',
            icon: 'help-circle-outline',
            onPress: () => canEdit.explain({ petName: pet?.name ?? null }),
          }}
        />
      </Screen>
    );
  }

  // The draft is seeded from the row, so it must not be built before it lands.
  if (id && vaccinationsQuery.isPending) {
    return (
      <Screen header={header} scroll>
        <SkeletonGroup label="Loading this record" gap="xl">
          <ListRowSkeleton count={4} avatar={false} />
        </SkeletonGroup>
      </Screen>
    );
  }

  return (
    <VaccinationForm
      petId={resolvedPetId}
      petName={pet?.name ?? null}
      species={pet?.species ?? 'other'}
      existingId={existing?.id ?? null}
      initial={
        existing
          ? {
              name: existing.name,
              core: existing.core,
              administeredAt: existing.administeredAt,
              dueAt: existing.dueAt,
              vetName: existing.vetName ?? '',
              clinic: existing.clinic ?? '',
              batchNumber: existing.batchNumber ?? '',
              notes: existing.notes ?? '',
              documentIds: [...existing.documentIds],
            }
          : EMPTY_DRAFT
      }
      onClose={close}
    />
  );
}

/* -------------------------------------------------------------------- form */

type VaccinationFormProps = {
  petId: string;
  petName: string | null;
  species: SpeciesKey;
  existingId: string | null;
  initial: Draft;
  onClose: () => void;
};

function VaccinationForm({
  petId,
  petName,
  species,
  existingId,
  initial,
  onClose,
}: VaccinationFormProps) {
  const t = useTheme();
  const router = useRouter();
  const now = useNow();

  const save = useSaveVaccination(petId);
  const remove = useDeleteVaccination(petId);

  const deleteSheet = useSheet();

  const [draft, setDraft] = useState<Draft>(initial);
  const [nameTouched, setNameTouched] = useState(false);

  const patch = useCallback((next: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...next })), []);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial]);

  /* ---- validation ------------------------------------------------------- */

  const trimmedName = draft.name.trim();
  const nameError =
    nameTouched && trimmedName.length === 0
      ? 'A record needs a name — it’s what the reminder will say.'
      : undefined;

  const orderError =
    draft.administeredAt && draft.dueAt && draft.dueAt < draft.administeredAt
      ? 'The next dose can’t be due before this one was given.'
      : undefined;

  const valid = trimmedName.length > 0 && orderError === undefined;

  /* ---- derived ---------------------------------------------------------- */

  const suggestions = SUGGESTIONS[species] ?? [];

  const preview = vaccinationStatus(
    { administeredAt: draft.administeredAt, dueAt: draft.dueAt },
    now,
  );
  const previewMeta = VACCINATION_STATUS_META[preview];

  /* ---- actions ---------------------------------------------------------- */

  const applySuggestion = useCallback(
    (suggestion: Suggestion) => {
      haptics.select();
      patch({ name: suggestion.name, core: suggestion.core });
      setNameTouched(true);
    },
    [patch],
  );

  const applyOffset = useCallback(
    (months: number) => {
      const base = fromDateOnly(draft.administeredAt ?? toDateOnly(now)) ?? now;
      haptics.select();
      patch({
        dueAt: toDateOnly(months % 12 === 0 ? addYears(base, months / 12) : addMonths(base, months)),
      });
    },
    [draft.administeredAt, now, patch],
  );

  const submit = useCallback(() => {
    if (trimmedName.length === 0) {
      setNameTouched(true);
      haptics.warn();
      return;
    }
    if (!valid) {
      haptics.warn();
      return;
    }

    save.mutate(
      {
        id: existingId ?? undefined,
        name: trimmedName,
        core: draft.core,
        administeredAt: draft.administeredAt,
        dueAt: draft.dueAt,
        vetName: blank(draft.vetName),
        clinic: blank(draft.clinic),
        batchNumber: blank(draft.batchNumber),
        notes: blank(draft.notes),
        documentIds: draft.documentIds,
      },
      {
        onSuccess: (saved) => {
          haptics.success();
          toast.success(existingId ? `${saved.name} updated` : `${saved.name} is on file`, {
            description: saved.dueAt
              ? `Next one ${dueLabel(saved.dueAt, now)} — we’ll remind you.`
              : `Added to ${possessive(petName ?? 'your pet')} record.`,
          });
          onClose();
        },
      },
    );
  }, [draft, existingId, now, onClose, petName, save, trimmedName, valid]);

  const enter = useCallback(
    (index: number) =>
      t.reduceMotion
        ? FadeIn.duration(t.motion.duration.base).delay(index * t.motion.stagger.tight)
        : FadeInDown.duration(t.motion.duration.slow)
            .delay(index * t.motion.stagger.base)
            .easing(t.motion.easing.decelerate),
    [t.motion, t.reduceMotion],
  );

  /* ---- chrome ----------------------------------------------------------- */

  const header = (
    <ScreenHeader
      title={existingId ? 'Edit vaccination' : 'Add a vaccination'}
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
          onPress={submit}
          variant="primary"
          size="sm"
          disabled={!dirty || !valid}
          loading={save.isPending}
          haptic="none"
          accessibilityHint={dirty ? 'Saves this record.' : 'Nothing has changed yet.'}
        />
      }
    />
  );

  const name = petName ?? 'your pet';

  return (
    <Screen
      header={header}
      scroll
      contentContainerStyle={{ gap: t.spacing.xl, paddingBottom: t.spacing.xl }}
      footer={
        <Button
          label={existingId ? 'Save the changes' : `Add it to ${possessive(name)} record`}
          onPress={submit}
          variant="primary"
          size="lg"
          fullWidth
          hero
          leftIcon="checkmark"
          disabled={!dirty || !valid}
          loading={save.isPending}
          haptic="none"
        />
      }
    >
      {/* ---- what ---------------------------------------------------------- */}
      <Animated.View entering={enter(0)} style={{ gap: t.spacing.md }}>
        <SectionHeader
          title="Which vaccine?"
          subtitle={`Tap one ${species === 'other' ? 'or type it in' : 'to fill it in'} — we’ll set core or non-core for you.`}
          icon="shield-checkmark-outline"
          iconColor="primaryText"
          first
        />

        {suggestions.length > 0 ? (
          <Row gap="sm" wrap>
            {suggestions.map((suggestion) => (
              <Chip
                key={suggestion.name}
                label={suggestion.name.split(' (')[0] ?? suggestion.name}
                size="sm"
                selected={draft.name === suggestion.name}
                onPress={() => applySuggestion(suggestion)}
                accessibilityLabel={suggestion.name}
                accessibilityHint={suggestion.core ? 'A core vaccine.' : 'A non-core vaccine.'}
              />
            ))}
          </Row>
        ) : null}

        <Surface variant="surface" elevation={1} radius="xl" padding="base" style={{ gap: t.spacing.lg }}>
          <Input
            label="Vaccine name"
            value={draft.name}
            onChangeText={(value) => patch({ name: value })}
            onBlur={() => setNameTouched(true)}
            error={nameError}
            placeholder="Rabies"
            leadingIcon="medical-outline"
            maxLength={NAME_MAX}
            autoCapitalize="words"
            required
            clearable
          />

          <Switch
            value={draft.core}
            onValueChange={(value) => patch({ core: value })}
            label="Core vaccine"
            description="Core shots are the ones every vet expects to see — kennels and groomers ask for them by name."
          />
        </Surface>
      </Animated.View>

      {/* ---- when ---------------------------------------------------------- */}
      <Animated.View entering={enter(1)} style={{ gap: t.spacing.md }}>
        <SectionHeader
          title="The dates"
          subtitle="Leave the first blank if this one is booked but not given yet."
          icon="calendar-outline"
          iconColor="accentText"
        />

        <Surface variant="surface" elevation={1} radius="xl" padding="base" style={{ gap: t.spacing.lg }}>
          <DateField
            label="Given on"
            value={draft.administeredAt}
            onChange={(value) => patch({ administeredAt: value })}
            maxDate={toDateOnly(now)}
            title="When was it given?"
            placeholder="Not given yet"
            clearable
          />

          <Column gap="sm">
            <DateField
              label="Next one due"
              value={draft.dueAt}
              onChange={(value) => patch({ dueAt: value })}
              error={orderError}
              title="When is the next one due?"
              placeholder="No booster needed"
              helper="We’ll start nudging you a month before."
              clearable
            />
            <Row gap="sm" wrap>
              {OFFSETS.map((offset) => (
                <Chip
                  key={offset.label}
                  label={offset.label}
                  size="sm"
                  showCheck={false}
                  icon="add-circle-outline"
                  onPress={() => applyOffset(offset.months)}
                  accessibilityLabel={`Due ${offset.label.replace('+', '')} after the date given`}
                />
              ))}
            </Row>
          </Column>

          <Animated.View layout={LinearTransition.duration(t.motion.duration.base)}>
            <Row
              gap="sm"
              style={{
                padding: t.spacing.md,
                borderRadius: t.radius.lg,
                backgroundColor: t.color.surfaceAlt,
              }}
            >
              <Icon name="eye-outline" size="sm" color="textTertiary" />
              <Text variant="footnote" color="textSecondary" style={{ flex: 1 }}>
                On the list this will read as
              </Text>
              <Badge label={previewMeta.label} tone={previewMeta.tone} size="sm" dot />
            </Row>
          </Animated.View>
        </Surface>
      </Animated.View>

      {/* ---- who ----------------------------------------------------------- */}
      <Animated.View entering={enter(2)} style={{ gap: t.spacing.md }}>
        <SectionHeader
          title="Who gave it"
          subtitle="The details a locum vet or a boarding kennel will ask you to read out."
          icon="medkit-outline"
          iconColor="textTertiary"
        />

        <Surface variant="surface" elevation={1} radius="xl" padding="base" style={{ gap: t.spacing.lg }}>
          <Input
            label="Vet"
            value={draft.vetName}
            onChangeText={(value) => patch({ vetName: value })}
            placeholder="Dr Amara Chen"
            leadingIcon="person-outline"
            maxLength={FIELD_MAX}
            autoCapitalize="words"
            clearable
          />
          <Input
            label="Clinic"
            value={draft.clinic}
            onChangeText={(value) => patch({ clinic: value })}
            placeholder="Riverbank Veterinary"
            leadingIcon="business-outline"
            maxLength={FIELD_MAX}
            autoCapitalize="words"
            clearable
          />
          <Input
            label="Batch number"
            value={draft.batchNumber}
            onChangeText={(value) => patch({ batchNumber: value })}
            placeholder="RB-4417"
            helper="Straight off the sticker on the card. It matters if there’s ever a recall."
            leadingIcon="barcode-outline"
            maxLength={BATCH_MAX}
            autoCapitalize="characters"
            autoCorrect={false}
            clearable
          />
        </Surface>
      </Animated.View>

      {/* ---- notes --------------------------------------------------------- */}
      <Animated.View entering={enter(3)} style={{ gap: t.spacing.md }}>
        <SectionHeader
          title="Anything else"
          subtitle="A reaction, a half dose, a note from the nurse."
          icon="chatbubble-ellipses-outline"
          iconColor="textTertiary"
        />
        <Surface variant="surface" elevation={1} radius="xl" padding="base">
          <TextArea
            label="Notes"
            value={draft.notes}
            onChangeText={(value) => patch({ notes: value })}
            placeholder="Slightly sore leg for a day afterwards — nothing serious."
            maxLength={NOTES_MAX}
            minRows={3}
            maxRows={6}
          />
        </Surface>
      </Animated.View>

      {existingId ? (
        <Animated.View entering={enter(4)}>
          <Button
            label="Remove this record"
            onPress={() => deleteSheet.open()}
            variant="ghost"
            size="md"
            fullWidth
            leftIcon="trash-outline"
            accessibilityHint="Asks before deleting."
          />
        </Animated.View>
      ) : null}

      <ConfirmSheet
        controller={deleteSheet}
        title="Remove this vaccination?"
        body={`It disappears from ${possessive(name)} record, and so does the reminder for the next one. The files you attached stay in the library.`}
        confirmLabel="Remove it"
        cancelLabel="Keep it"
        icon="trash-outline"
        onConfirm={async () => {
          if (!existingId) return;
          await remove.mutateAsync(existingId);
          toast.success('Vaccination removed');
          onClose();
        }}
      />
    </Screen>
  );
}
