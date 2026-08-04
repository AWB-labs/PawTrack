/**
 * Edit a pet — the same facts the wizard collected, now all at once.
 *
 * A wizard is right for a first meeting and wrong for a correction: when you've
 * opened this screen you already know which field is wrong, and eight steps
 * between you and it would be an insult. So this is one page — but grouped the
 * way a person thinks about their pet rather than the way the table is shaped:
 * who they are, what they're like, what a vet needs, and the number on the chip.
 *
 * Two behaviours the screen exists to get right:
 *
 *   · **Nothing is saved until you say so, and nothing is lost if you don't.**
 *     Every field edits a draft; leaving with unsaved changes asks first. A form
 *     that silently discards ten minutes of typing is a form people stop
 *     trusting with medical details.
 *   · **`pet.edit` is owner-only, and this screen says so properly.** A sitter
 *     who follows a stale link gets the authored explanation and a way back, not
 *     a blank page or a raw denial code.
 */

import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeInDown, LinearTransition } from 'react-native-reanimated';

import { useUpdatePet } from '@/data/queries/usePets';
import { SPECIES_META, type DateOnly, type Pet, type Sex } from '@/data/types';
import { BreedField } from '@/features/pets/BreedField';
import { usePetScope } from '@/features/pets/PetScope';
import { SpeciesPicker } from '@/features/pets/SpeciesPicker';
import { ageFromApproxMonths, ageFromBirthday, toDateOnly } from '@/lib/date';
import { toHref } from '@/lib/deeplinks';
import {
  fromDisplayWeight,
  possessive,
  toDisplayWeight,
  weightUnitLabel,
} from '@/lib/format';
import haptics from '@/lib/haptics';
import { usePermission } from '@/rbac/usePermission';
import { usePreferences } from '@/stores/preferences';
import { useTheme, type SpeciesKey } from '@/theme';
import {
  Button,
  Chip,
  Column,
  ConfirmSheet,
  DateField,
  EmptyState,
  IconButton,
  Input,
  Row,
  Screen,
  ScreenHeader,
  SectionHeader,
  SegmentedControl,
  Stepper,
  Surface,
  Text,
  TextArea,
  toast,
  useSheet,
  type IconName,
} from '@/ui';
import { PermissionLocked } from '@/ui/illustrations';
import { SkeletonGroup } from '@/ui/Skeleton';
import { ListRowSkeleton, ProfileHeaderSkeleton } from '@/ui/skeletons/ContentSkeletons';

/* -------------------------------------------------------------------- types */

type AgeMode = 'birthday' | 'approximate' | 'unknown';

type Draft = {
  name: string;
  species: SpeciesKey;
  breed: string;
  ageMode: AgeMode;
  birthday: DateOnly | null;
  approxYears: number;
  approxMonths: number;
  sex: Sex;
  neutered: boolean | null;
  colorMarkings: string;
  targetWeightText: string;
  allergies: string[];
  conditions: string[];
  microchipId: string;
  microchipRegistry: string;
  notes: string;
};

type NeuterValue = 'yes' | 'no' | 'unknown';

/* ---------------------------------------------------------------- constants */

const NAME_MAX = 32;
const MARKINGS_MAX = 60;
const MICROCHIP_MAX = 20;
const NOTES_MAX = 500;
const TAG_MAX = 28;
const MAX_YEARS = 40;
const MAX_WEIGHT_KG = 500;

const SEX_SEGMENTS: { value: Sex; label: string }[] = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'unknown', label: 'Not sure' },
];

const NEUTER_SEGMENTS: { value: NeuterValue; label: string }[] = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
  { value: 'unknown', label: 'Not sure' },
];

const AGE_SEGMENTS: { value: AgeMode; label: string }[] = [
  { value: 'birthday', label: 'Birthday' },
  { value: 'approximate', label: 'Roughly' },
  { value: 'unknown', label: 'No idea' },
];

/* ------------------------------------------------------------------ helpers */

const toNeuterValue = (value: boolean | null): NeuterValue =>
  value === null ? 'unknown' : value ? 'yes' : 'no';

const fromNeuterValue = (value: NeuterValue): boolean | null =>
  value === 'unknown' ? null : value === 'yes';

function toDraft(pet: Pet, unit: 'kg' | 'lb'): Draft {
  const months = pet.approximateAgeMonths ?? 0;
  return {
    name: pet.name,
    species: pet.species,
    breed: pet.breed ?? '',
    ageMode: pet.birthday ? 'birthday' : pet.approximateAgeMonths !== null ? 'approximate' : 'unknown',
    birthday: pet.birthday,
    approxYears: Math.floor(months / 12),
    approxMonths: months % 12,
    sex: pet.sex,
    neutered: pet.neutered,
    colorMarkings: pet.colorMarkings ?? '',
    targetWeightText:
      pet.targetWeightKg === null
        ? ''
        : String(Number(toDisplayWeight(pet.targetWeightKg, unit).toFixed(2))),
    allergies: [...pet.allergies],
    conditions: [...pet.conditions],
    microchipId: pet.microchipId ?? '',
    microchipRegistry: pet.microchipRegistry ?? '',
    notes: pet.notes ?? '',
  };
}

const blank = (value: string): string | null => (value.trim().length > 0 ? value.trim() : null);

/* ------------------------------------------------------------------- route */

export default function EditPetScreen() {
  const t = useTheme();
  const router = useRouter();
  const scope = usePetScope();
  const { allowed, reason, explain } = usePermission('pet.edit', scope.petId);

  if (!scope.pet) {
    return (
      <Screen scroll>
        <SkeletonGroup label="Loading this profile" gap="xl">
          <ProfileHeaderSkeleton />
          <ListRowSkeleton count={5} avatar={false} />
        </SkeletonGroup>
      </Screen>
    );
  }

  if (!allowed) {
    return (
      <Screen center>
        <EmptyState
          tone="warning"
          illustration={<PermissionLocked size={t.spacing.colossal * 3} />}
          headline="Only the owner can edit this"
          body={`You can still see ${possessive(scope.pet.name)} details and log the care you were asked to do — the profile itself stays with them.`}
          action={{
            label: 'Back to the profile',
            icon: 'arrow-back',
            // Reachable from a stale link, so there may be no stack to pop.
            onPress: () => router.replace(toHref(`/pet/${scope.petId}`)),
          }}
          secondaryAction={{
            label: 'Why can’t I edit?',
            icon: 'help-circle-outline',
            onPress: () => explain({ petName: scope.pet?.name ?? null }),
          }}
          footer={
            reason ? (
              <Text variant="caption" color="textTertiary" align="center">
                Ask the owner if something here needs correcting.
              </Text>
            ) : null
          }
        />
      </Screen>
    );
  }

  return <EditPetForm pet={scope.pet} />;
}

/* -------------------------------------------------------------------- form */

/**
 * Split out so the draft can be seeded from a pet that is definitely loaded.
 * Initialising form state from data that may still be in flight is where "my
 * edits vanished" bugs come from.
 */
function EditPetForm({ pet }: { pet: Pet }) {
  const t = useTheme();
  const router = useRouter();
  const unit = usePreferences((s) => s.weightUnit);

  const updatePet = useUpdatePet(pet.id);
  const discardSheet = useSheet();

  const initial = useMemo(() => toDraft(pet, unit), [pet, unit]);
  const [draft, setDraft] = useState<Draft>(initial);
  const [nameTouched, setNameTouched] = useState(false);

  const patch = useCallback(
    (next: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...next })),
    [],
  );

  /**
   * Both objects are produced by the same factory, so their key order matches
   * and a string compare is a sound (and very cheap) deep equality here.
   */
  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(initial),
    [draft, initial],
  );

  /* ---- validation ------------------------------------------------------- */

  const trimmedName = draft.name.trim();
  const nameError =
    nameTouched && trimmedName.length === 0
      ? 'A pet needs a name — it’s how the whole app talks about them.'
      : undefined;

  const targetWeightKg = useMemo(() => {
    const raw = draft.targetWeightText.trim().replace(',', '.');
    if (raw.length === 0) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return Number.NaN;
    const kg = fromDisplayWeight(parsed, unit);
    return kg > MAX_WEIGHT_KG ? Number.NaN : kg;
  }, [draft.targetWeightText, unit]);

  const targetWeightError =
    targetWeightKg !== null && Number.isNaN(targetWeightKg)
      ? `That doesn’t look like a weight in ${weightUnitLabel(unit)}.`
      : undefined;

  const valid = trimmedName.length > 0 && targetWeightError === undefined;

  const approximateAgeMonths =
    draft.ageMode === 'approximate' ? draft.approxYears * 12 + draft.approxMonths : null;

  const agePreview = useMemo(() => {
    if (draft.ageMode === 'birthday' && draft.birthday) return ageFromBirthday(draft.birthday);
    if (draft.ageMode === 'approximate') return ageFromApproxMonths(approximateAgeMonths);
    return null;
  }, [approximateAgeMonths, draft.ageMode, draft.birthday]);

  /* ---- actions ---------------------------------------------------------- */

  const save = useCallback(() => {
    if (trimmedName.length === 0) {
      setNameTouched(true);
      haptics.warn();
      return;
    }
    if (!valid) {
      haptics.warn();
      return;
    }

    updatePet.mutate(
      {
        name: trimmedName,
        species: draft.species,
        breed: blank(draft.breed),
        birthday: draft.ageMode === 'birthday' ? draft.birthday : null,
        approximateAgeMonths,
        sex: draft.sex,
        neutered: draft.neutered,
        colorMarkings: blank(draft.colorMarkings),
        targetWeightKg: targetWeightKg !== null && !Number.isNaN(targetWeightKg) ? targetWeightKg : null,
        allergies: draft.allergies,
        conditions: draft.conditions,
        microchipId: blank(draft.microchipId),
        microchipRegistry: blank(draft.microchipRegistry),
        notes: blank(draft.notes),
      },
      {
        onSuccess: (saved) => {
          haptics.success();
          toast.success(`${possessive(saved.name)} profile is updated`, {
            description: 'Everywhere in Petal, straight away.',
          });
          router.back();
        },
      },
    );
  }, [
    approximateAgeMonths,
    draft,
    router,
    targetWeightKg,
    trimmedName,
    updatePet,
    valid,
  ]);

  const close = useCallback(() => {
    if (dirty) {
      discardSheet.open();
      return;
    }
    router.back();
  }, [discardSheet, dirty, router]);

  const revert = useCallback(() => {
    haptics.tap();
    setDraft(initial);
    setNameTouched(false);
  }, [initial]);

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
      title={`Edit ${pet.name}`}
      large={false}
      showBack={false}
      leading={
        <IconButton
          icon="close"
          accessibilityLabel="Close"
          accessibilityHint={dirty ? 'Asks before discarding your changes.' : 'Closes this form.'}
          variant="ghost"
          tone="neutral"
          onPress={close}
        />
      }
      actions={
        <Button
          label="Save"
          onPress={save}
          variant="primary"
          size="sm"
          disabled={!dirty || !valid}
          loading={updatePet.isPending}
          haptic="none"
          accessibilityHint={
            dirty ? `Saves your changes to ${possessive(pet.name)} profile.` : 'Nothing has changed yet.'
          }
        />
      }
    />
  );

  /* ---- content ---------------------------------------------------------- */

  return (
    <Screen
      header={header}
      scroll
      contentContainerStyle={{ gap: t.spacing.xl, paddingBottom: t.spacing.xxxl }}
    >
      <Animated.View entering={enter(0)} style={{ gap: t.spacing.md }}>
        <SectionHeader
          title="Who they are"
          subtitle="The name and species drive their colour and everything Petal says about them."
          icon="paw-outline"
          iconColor="primaryText"
          first
        />
        <Surface variant="surface" elevation={1} radius="xl" padding="base" style={{ gap: t.spacing.lg }}>
          <Input
            label="Name"
            value={draft.name}
            onChangeText={(name) => patch({ name })}
            onBlur={() => setNameTouched(true)}
            error={nameError}
            leadingIcon="paw-outline"
            maxLength={NAME_MAX}
            autoCapitalize="words"
            autoCorrect={false}
            clearable
          />

          <Column gap="sm">
            <Text variant="subheadStrong" color="textSecondary">
              Kind of pet
            </Text>
            <SpeciesPicker
              value={draft.species}
              onChange={(species) => patch({ species })}
              columns={4}
              accessibilityLabel="Kind of pet"
            />
            <Text variant="caption" color="textTertiary">
              {`${SPECIES_META[draft.species].emoji}  Sets ${possessive(pet.name)} identity colour and the breeds we suggest.`}
            </Text>
          </Column>
        </Surface>
      </Animated.View>

      <Animated.View entering={enter(1)} style={{ gap: t.spacing.md }}>
        <SectionHeader
          title="What they’re like"
          subtitle="Everything a vet or a sitter asks in the first minute."
          icon="ribbon-outline"
          iconColor="accentText"
        />
        <Surface variant="surface" elevation={1} radius="xl" padding="base" style={{ gap: t.spacing.lg }}>
          <BreedField
            species={draft.species}
            value={draft.breed}
            onChange={(breed) => patch({ breed })}
            helper="Crossbreeds and best guesses welcome."
          />

          <Column gap="sm">
            <Text variant="subheadStrong" color="textSecondary">
              Age
            </Text>
            <SegmentedControl
              segments={AGE_SEGMENTS}
              value={draft.ageMode}
              onChange={(ageMode) => patch({ ageMode })}
              size="sm"
              accessibilityLabel="How their age is recorded"
            />

            <Animated.View layout={LinearTransition.duration(t.motion.duration.base)}>
              {draft.ageMode === 'birthday' ? (
                <DateField
                  label="Date of birth"
                  value={draft.birthday}
                  onChange={(birthday) => patch({ birthday })}
                  maxDate={toDateOnly(new Date())}
                  placeholder="Pick their birthday"
                  clearable
                />
              ) : draft.ageMode === 'approximate' ? (
                <Row gap="base" align="start">
                  <Column flex gap="xs">
                    <Text variant="caption" color="textTertiary">
                      Years
                    </Text>
                    <Stepper
                      value={draft.approxYears}
                      onChange={(approxYears) => patch({ approxYears })}
                      min={0}
                      max={MAX_YEARS}
                      size="sm"
                      accessibilityLabel="Approximate age in years"
                    />
                  </Column>
                  <Column flex gap="xs">
                    <Text variant="caption" color="textTertiary">
                      Months
                    </Text>
                    <Stepper
                      value={draft.approxMonths}
                      onChange={(approxMonths) => patch({ approxMonths })}
                      min={0}
                      max={11}
                      size="sm"
                      accessibilityLabel="Approximate age in months"
                    />
                  </Column>
                </Row>
              ) : (
                <Text variant="footnote" color="textTertiary">
                  {`We’ll leave ${possessive(pet.name)} age blank until you know it.`}
                </Text>
              )}
            </Animated.View>

            {agePreview ? (
              <Text variant="caption" color="primaryText">
                {`Shown as ${agePreview}.`}
              </Text>
            ) : null}
          </Column>

          <Column gap="sm">
            <Text variant="subheadStrong" color="textSecondary">
              Sex
            </Text>
            <SegmentedControl
              segments={SEX_SEGMENTS}
              value={draft.sex}
              onChange={(sex) => patch({ sex })}
              size="sm"
              accessibilityLabel="Sex"
            />
          </Column>

          <Column gap="sm">
            <Text variant="subheadStrong" color="textSecondary">
              Neutered or spayed
            </Text>
            <SegmentedControl
              segments={NEUTER_SEGMENTS}
              value={toNeuterValue(draft.neutered)}
              onChange={(value) => patch({ neutered: fromNeuterValue(value) })}
              size="sm"
              accessibilityLabel="Neutered or spayed"
            />
          </Column>

          <Input
            label="Colour & markings"
            value={draft.colorMarkings}
            onChangeText={(colorMarkings) => patch({ colorMarkings })}
            placeholder="Black with a white chest patch"
            helper="The description you’d give if they went missing."
            leadingIcon="color-palette-outline"
            maxLength={MARKINGS_MAX}
            clearable
          />
        </Surface>
      </Animated.View>

      <Animated.View entering={enter(2)} style={{ gap: t.spacing.md }}>
        <SectionHeader
          title="Health"
          subtitle="Allergies and conditions surface as warnings on every care screen."
          icon="heart-outline"
          iconColor="primaryText"
        />
        <Surface variant="surface" elevation={1} radius="xl" padding="base" style={{ gap: t.spacing.lg }}>
          <Input
            label={`Target weight (${weightUnitLabel(unit)})`}
            value={draft.targetWeightText}
            onChangeText={(targetWeightText) => patch({ targetWeightText })}
            error={targetWeightError}
            placeholder={unit === 'lb' ? '18.0' : '8.0'}
            helper="Your vet’s goal, if they’ve set one. It draws the guide band on the chart."
            leadingIcon="flag-outline"
            keyboardType="decimal-pad"
            clearable
          />

          <TagField
            label="Allergies"
            helper="Foods, medicines, anything they react to."
            placeholder="Chicken"
            icon="warning-outline"
            tone="accent"
            values={draft.allergies}
            onChange={(allergies) => patch({ allergies })}
          />

          <TagField
            label="Conditions"
            helper="Ongoing things a sitter or a locum vet should know."
            placeholder="Arthritis"
            icon="pulse-outline"
            tone="primary"
            values={draft.conditions}
            onChange={(conditions) => patch({ conditions })}
          />

          <TextArea
            label="Notes"
            value={draft.notes}
            onChangeText={(notes) => patch({ notes })}
            placeholder="Hates the postman. Loves the sofa. Will pretend not to have been fed."
            helper="Anything that doesn’t fit a field. Sitters see this."
            maxLength={NOTES_MAX}
            minRows={3}
            maxRows={7}
          />
        </Surface>
      </Animated.View>

      <Animated.View entering={enter(3)} style={{ gap: t.spacing.md }}>
        <SectionHeader
          title="Identification"
          subtitle="The numbers you’ll want at 9pm on a Sunday."
          icon="hardware-chip-outline"
          iconColor="textTertiary"
        />
        <Surface variant="surface" elevation={1} radius="xl" padding="base" style={{ gap: t.spacing.lg }}>
          <Input
            label="Microchip number"
            value={draft.microchipId}
            onChangeText={(microchipId) => patch({ microchipId })}
            placeholder="985 1410 0012 3456"
            leadingIcon="hardware-chip-outline"
            keyboardType="number-pad"
            maxLength={MICROCHIP_MAX}
            clearable
          />
          <Input
            label="Registry"
            value={draft.microchipRegistry}
            onChangeText={(microchipRegistry) => patch({ microchipRegistry })}
            placeholder="Petlog, AVID, HomeAgain…"
            helper="Whoever holds the record, so you know who to ring."
            leadingIcon="business-outline"
            autoCapitalize="words"
            autoCorrect={false}
            clearable
          />
        </Surface>
      </Animated.View>

      <Animated.View entering={enter(4)} style={{ gap: t.spacing.md }}>
        <Button
          label="Save changes"
          onPress={save}
          variant="primary"
          size="lg"
          hero
          fullWidth
          disabled={!dirty || !valid}
          loading={updatePet.isPending}
          haptic="none"
          accessibilityHint={`Saves your changes to ${possessive(pet.name)} profile.`}
        />
        {dirty ? (
          <Button
            label="Undo my changes"
            onPress={revert}
            variant="ghost"
            size="md"
            fullWidth
            leftIcon="arrow-undo-outline"
            accessibilityHint="Puts every field back the way it was."
          />
        ) : null}

        <Text variant="caption" color="textTertiary" align="center">
          {`Deleting ${pet.name} lives on their profile, under Manage.`}
        </Text>
      </Animated.View>

      <ConfirmSheet
        controller={discardSheet}
        title="Discard your changes?"
        body={`Your edits to ${possessive(pet.name)} profile haven’t been saved yet. Leaving now puts everything back the way it was.`}
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        icon="close-circle-outline"
        onConfirm={() => router.back()}
      />
    </Screen>
  );
}

/* ---------------------------------------------------------------- tag field */

type TagFieldProps = {
  label: string;
  helper: string;
  placeholder: string;
  icon: IconName;
  tone: 'primary' | 'accent';
  values: string[];
  onChange: (next: string[]) => void;
};

/**
 * A free-text list. Allergies and conditions are open sets — no registry of
 * everything a cat can react to exists — so this stays an input that *collects*
 * rather than a picker that constrains.
 */
function TagField({ label, helper, placeholder, icon, tone, values, onChange }: TagFieldProps) {
  const t = useTheme();
  const [entry, setEntry] = useState('');

  const trimmed = entry.trim();
  const duplicate = values.some((value) => value.toLowerCase() === trimmed.toLowerCase());

  const add = useCallback(() => {
    if (trimmed.length === 0 || duplicate) {
      haptics.warn();
      return;
    }
    haptics.commit();
    onChange([...values, trimmed]);
    setEntry('');
  }, [duplicate, onChange, trimmed, values]);

  const remove = useCallback(
    (value: string) => {
      haptics.tap();
      onChange(values.filter((row) => row !== value));
    },
    [onChange, values],
  );

  return (
    <Column gap="sm">
      <Input
        label={label}
        value={entry}
        onChangeText={setEntry}
        placeholder={placeholder}
        helper={duplicate && trimmed.length > 0 ? `${trimmed} is already on the list.` : helper}
        error={undefined}
        leadingIcon={icon}
        maxLength={TAG_MAX}
        autoCapitalize="sentences"
        returnKeyType="done"
        onSubmitEditing={add}
        trailing={
          <IconButton
            icon="add"
            accessibilityLabel={`Add to ${label.toLowerCase()}`}
            accessibilityHint={
              trimmed.length === 0 ? 'Type something first.' : `Adds ${trimmed} to the list.`
            }
            variant="tonal"
            tone={tone === 'accent' ? 'accent' : 'primary'}
            size="sm"
            disabled={trimmed.length === 0 || duplicate}
            onPress={add}
          />
        }
      />

      {values.length > 0 ? (
        <Animated.View layout={LinearTransition.duration(t.motion.duration.base)}>
          <Row gap="xs" wrap accessibilityLabel={`${label}: ${values.join(', ')}`}>
            {values.map((value) => (
              <Chip
                key={value}
                label={value}
                tone={tone}
                size="sm"
                selected
                showCheck={false}
                onRemove={() => remove(value)}
                accessibilityLabel={value}
                accessibilityHint="Use the cross to take this off the list."
              />
            ))}
          </Row>
        </Animated.View>
      ) : (
        <View style={{ paddingLeft: t.spacing.xxs }}>
          <Text variant="caption" color="textTertiary">
            Nothing on the list yet.
          </Text>
        </View>
      )}
    </Column>
  );
}
