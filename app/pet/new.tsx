/**
 * Add a pet — a wizard, not a form.
 *
 * A new pet needs eleven facts, and a single screen asking for eleven facts is
 * the moment most people put the phone down. So this asks *one question at a
 * time*, in the order a person would actually volunteer them: what kind of
 * animal, what they're called, what they look like, how old, the details, the
 * numbers, the chip — then a review before anything is written.
 *
 * Choices worth defending:
 *
 *   · **The rail is the only progress indicator.** It's the same `StepRail` the
 *     onboarding flow uses, so "a multi-step thing in Petal" has one look.
 *   · **Nothing is mandatory except a species and a name.** A rescue arrives
 *     with no birthday, no breed and no chip number; a wizard that refuses to
 *     continue without them is a wizard that gets abandoned. Every other step
 *     turns its "Continue" into "Skip for now" when it's empty.
 *   · **The weight is a *weigh-in*, not a profile field.** `createPet` doesn't
 *     take one — the pet's current weight is derived from its weight history —
 *     so the number typed here becomes the first entry on the chart.
 *   · **The finish is a screen, not a redirect.** Confetti fired on a screen
 *     that's already sliding away is confetti nobody saw.
 */

import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeInLeft, FadeInRight, LinearTransition } from 'react-native-reanimated';

import { useAddWeight } from '@/data/queries/useHealth';
import { useCreatePet } from '@/data/queries/usePets';
import { SPECIES_META, type DateOnly, type Pet, type Sex } from '@/data/types';
import { StepRail } from '@/features/onboarding/OnboardingScaffold';
import { BreedField } from '@/features/pets/BreedField';
import { SpeciesPicker } from '@/features/pets/SpeciesPicker';
import { ageFromApproxMonths, ageFromBirthday, formatDay, toDateOnly } from '@/lib/date';
import { toHref } from '@/lib/deeplinks';
import { fromDisplayWeight, possessive, weightUnitLabel } from '@/lib/format';
import haptics from '@/lib/haptics';
import { usePreferences } from '@/stores/preferences';
import { useTheme, type SpeciesKey } from '@/theme';
import {
  Button,
  Column,
  ConfirmSheet,
  DateField,
  IconButton,
  Input,
  ListRow,
  PhotoPicker,
  Row,
  Screen,
  ScreenHeader,
  SegmentedControl,
  Spacer,
  Stepper,
  Surface,
  Text,
  confetti,
  toast,
  useSheet,
} from '@/ui';
import { SuccessCheck } from '@/ui/illustrations';

/* -------------------------------------------------------------------- types */

const STEPS = [
  'species',
  'name',
  'photo',
  'age',
  'details',
  'weight',
  'microchip',
  'review',
] as const;

type StepId = (typeof STEPS)[number];

/** How the owner knows the pet's age. Rescues almost never pick the first one. */
type AgeMode = 'birthday' | 'approximate' | 'unknown';

type Draft = {
  species: SpeciesKey | null;
  name: string;
  photoUri: string | null;
  ageMode: AgeMode;
  birthday: DateOnly | null;
  approxYears: number;
  approxMonths: number;
  breed: string;
  sex: Sex;
  neutered: boolean | null;
  weightText: string;
  microchipId: string;
  microchipRegistry: string;
};

type StepCopy = { title: string; body: string };

/* ---------------------------------------------------------------- constants */

const EMPTY_DRAFT: Draft = {
  species: null,
  name: '',
  photoUri: null,
  ageMode: 'birthday',
  birthday: null,
  approxYears: 2,
  approxMonths: 0,
  breed: '',
  sex: 'unknown',
  neutered: null,
  weightText: '',
  microchipId: '',
  microchipRegistry: '',
};

const NAME_MAX = 32;
const MICROCHIP_MAX = 20;

/** A 90kg mastiff exists; a 900kg one is a typo. */
const MAX_WEIGHT_KG = 500;

const MAX_YEARS = 40;

/* ------------------------------------------------------------------ helpers */

function stepCopy(step: StepId, name: string): StepCopy {
  const who = name.trim() || 'them';
  switch (step) {
    case 'species':
      return {
        title: 'Who are we adding?',
        body: 'Pick the closest match — it sets their colour and the questions we ask next.',
      };
    case 'name':
      return {
        title: 'What’s their name?',
        body: 'We’ll use it everywhere, so reminders sound like a person wrote them.',
      };
    case 'photo':
      return {
        title: `A picture of ${who}`,
        body: 'Their face makes the whole app easier to read at a glance. You can add one later.',
      };
    case 'age':
      return {
        title: `How old is ${who}?`,
        body: 'A birthday means we can wish them a happy one. A rough age is plenty if that’s all you have.',
      };
    case 'details':
      return {
        title: `A little more about ${who}`,
        body: 'Breed and sex help your vet, and help us tailor what we suggest.',
      };
    case 'weight':
      return {
        title: `What does ${who} weigh?`,
        body: 'This becomes the first point on their weight chart — the one your vet will ask about.',
      };
    case 'microchip':
      return {
        title: 'Microchip number',
        body: 'Worth having somewhere you can find it at 9pm on a Sunday. Skip it if you don’t have it to hand.',
      };
    case 'review':
    default:
      return {
        title: 'Does this look right?',
        body: 'Tap anything to change it. Nothing is saved until you’re happy.',
      };
  }
}

const SEX_SEGMENTS: { value: Sex; label: string }[] = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'unknown', label: 'Not sure' },
];

type NeuterValue = 'yes' | 'no' | 'unknown';

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

const toNeuterValue = (value: boolean | null): NeuterValue =>
  value === null ? 'unknown' : value ? 'yes' : 'no';

const fromNeuterValue = (value: NeuterValue): boolean | null =>
  value === 'unknown' ? null : value === 'yes';

/* ---------------------------------------------------------------- component */

export default function NewPetScreen() {
  const t = useTheme();
  const router = useRouter();
  const unit = usePreferences((s) => s.weightUnit);

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [nameTouched, setNameTouched] = useState(false);
  const [created, setCreated] = useState<Pet | null>(null);
  /** Set when a review row sent you back, so Continue returns you to the review. */
  const [fromReview, setFromReview] = useState(false);

  const createPet = useCreatePet();
  const addWeight = useAddWeight(created?.id ?? '');
  const leaveSheet = useSheet();

  const celebrated = useRef(false);

  const step = STEPS[index] ?? 'species';
  const copy = stepCopy(step, draft.name);
  const isLast = index === STEPS.length - 1;

  const patch = useCallback((next: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...next })), []);

  /* ---- derived ---------------------------------------------------------- */

  const trimmedName = draft.name.trim();
  const nameError = nameTouched && trimmedName.length === 0
    ? 'Give them a name and we’ll use it everywhere.'
    : undefined;

  const weightKg = useMemo(() => {
    const raw = draft.weightText.trim().replace(',', '.');
    if (raw.length === 0) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return Number.NaN;
    const kg = fromDisplayWeight(parsed, unit);
    return kg > MAX_WEIGHT_KG ? Number.NaN : kg;
  }, [draft.weightText, unit]);

  const weightError =
    weightKg !== null && Number.isNaN(weightKg)
      ? `That doesn’t look like a weight in ${weightUnitLabel(unit)}. Try something like 4.2.`
      : undefined;

  const approximateAgeMonths =
    draft.ageMode === 'approximate' ? draft.approxYears * 12 + draft.approxMonths : null;

  const ageSummary = useMemo(() => {
    if (draft.ageMode === 'birthday' && draft.birthday) {
      return ageFromBirthday(draft.birthday) ?? formatDay(draft.birthday);
    }
    if (draft.ageMode === 'approximate') return ageFromApproxMonths(approximateAgeMonths);
    return null;
  }, [approximateAgeMonths, draft.ageMode, draft.birthday]);

  /**
   * Both objects come from the same literal shape, so their key order matches
   * and a string compare is a sound (and very cheap) deep equality here. Every
   * field counts: someone who only set "neutered" has still done work.
   */
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(EMPTY_DRAFT), [draft]);

  const canContinue =
    step === 'species'
      ? draft.species !== null
      : step === 'name'
        ? trimmedName.length > 0
        : step === 'weight'
          ? weightError === undefined
          : true;

  /** Empty-but-optional steps say so on the button rather than in a side link. */
  const continueLabel = isLast
    ? `Add ${trimmedName || 'this pet'}`
    : fromReview
      ? 'Back to review'
      : step === 'photo' && draft.photoUri === null
        ? 'Skip for now'
        : step === 'microchip' && draft.microchipId.trim().length === 0
          ? 'Skip for now'
          : step === 'weight' && draft.weightText.trim().length === 0
            ? 'Skip for now'
            : 'Continue';

  /* ---- navigation ------------------------------------------------------- */

  const goTo = useCallback((target: number, dir: 1 | -1) => {
    setDirection(dir);
    setIndex(target);
  }, []);

  /** A correction from the review list should land you straight back on it. */
  const editFromReview = useCallback(
    (target: number) => {
      setFromReview(true);
      goTo(target, -1);
    },
    [goTo],
  );

  const reviewIndex = STEPS.indexOf('review');

  const submit = useCallback(() => {
    if (!draft.species) return;
    createPet.mutate(
      {
        name: trimmedName,
        species: draft.species,
        breed: draft.breed.trim() || null,
        birthday: draft.ageMode === 'birthday' ? draft.birthday : null,
        approximateAgeMonths,
        sex: draft.sex,
        neutered: draft.neutered,
        colorMarkings: null,
        photoUrl: draft.photoUri,
        microchipId: draft.microchipId.trim() || null,
        microchipRegistry: draft.microchipRegistry.trim() || null,
        targetWeightKg: null,
        notes: null,
        allergies: [],
        conditions: [],
      },
      { onSuccess: (pet) => setCreated(pet) },
    );
  }, [approximateAgeMonths, createPet, draft, trimmedName]);

  const next = useCallback(() => {
    if (step === 'name' && trimmedName.length === 0) {
      setNameTouched(true);
      haptics.warn();
      return;
    }
    if (!canContinue) {
      haptics.warn();
      return;
    }
    if (isLast) {
      submit();
      return;
    }
    if (fromReview) {
      setFromReview(false);
      goTo(reviewIndex, 1);
      return;
    }
    goTo(index + 1, 1);
  }, [canContinue, fromReview, goTo, index, isLast, reviewIndex, step, submit, trimmedName]);

  const back = useCallback(() => {
    if (index === 0) return;
    setFromReview(false);
    goTo(index - 1, -1);
  }, [goTo, index]);

  const close = useCallback(() => {
    if (dirty) {
      leaveSheet.open();
      return;
    }
    router.back();
  }, [dirty, leaveSheet, router]);

  const restart = useCallback(() => {
    celebrated.current = false;
    setDraft(EMPTY_DRAFT);
    setNameTouched(false);
    setCreated(null);
    setFromReview(false);
    setDirection(1);
    setIndex(0);
  }, []);

  /* ---- the finish ------------------------------------------------------- */

  useEffect(() => {
    if (!created || celebrated.current) return;
    celebrated.current = true;

    // The number typed on the weight step is a real weigh-in, so it goes to the
    // weight history rather than onto the pet record.
    if (weightKg !== null && !Number.isNaN(weightKg)) {
      addWeight.mutate({ kg: weightKg, note: 'First weigh-in' });
    }

    haptics.celebrate();
    confetti.fire({ power: 1.15 });
    toast.success(`${created.name} is in 🐾`, {
      description: 'Their meals, medicine and paperwork all live here now.',
    });
  }, [addWeight, created, weightKg]);

  /* ---- celebration ------------------------------------------------------ */

  if (created) {
    return (
      <Screen center>
        <Column gap="xl" align="center" style={{ alignSelf: 'stretch' }}>
          <Animated.View
            entering={
              t.reduceMotion
                ? FadeIn.duration(t.motion.duration.base)
                : FadeInRight.duration(t.motion.duration.slower).easing(t.motion.easing.decelerate)
            }
            style={{ alignItems: 'center', gap: t.spacing.base }}
          >
            <SuccessCheck size={t.spacing.colossal * 3} />
            <Text variant="display" align="center" accessibilityRole="header">
              {`Welcome, ${created.name}`}
            </Text>
            <Text
              variant="callout"
              color="textSecondary"
              align="center"
              style={{ maxWidth: t.spacing.colossal * 4 }}
            >
              {`${possessive(created.name)} profile is ready. Add a feeding time or a medicine next, and Petal will start reminding you.`}
            </Text>
          </Animated.View>

          <Column gap="sm" style={{ alignSelf: 'stretch' }}>
            <Button
              label={`See ${possessive(created.name)} profile`}
              onPress={() => router.replace(toHref(`/pet/${created.id}`))}
              variant="primary"
              size="lg"
              hero
              fullWidth
              haptic="commit"
            />
            <Button label="Add another pet" onPress={restart} variant="ghost" size="md" fullWidth />
          </Column>
        </Column>
      </Screen>
    );
  }

  /* ---- steps ------------------------------------------------------------ */

  const stepBody = (() => {
    switch (step) {
      case 'species':
        return (
          <SpeciesPicker
            value={draft.species}
            onChange={(species) => {
              const first = draft.species === null;
              patch({ species });
              // The answer *is* the tap here, so waiting for Continue would be
              // one gesture too many — but only on the way through. Coming back
              // to change it, you go where you came from.
              if (fromReview) {
                setFromReview(false);
                goTo(reviewIndex, 1);
              } else if (first) {
                goTo(index + 1, 1);
              }
            }}
            accessibilityLabel="What kind of pet is this?"
          />
        );

      case 'name':
        return (
          <Column gap="md">
            <Input
              label="Name"
              value={draft.name}
              onChangeText={(name) => patch({ name })}
              onBlur={() => setNameTouched(true)}
              error={nameError}
              placeholder={draft.species === 'cat' ? 'Mochi' : 'Buddy'}
              helper="Nicknames are welcome — this is what you actually call them."
              leadingIcon="paw-outline"
              maxLength={NAME_MAX}
              autoFocus
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={next}
              clearable
            />
            {draft.species ? (
              <Text variant="footnote" color="textTertiary">
                {`${SPECIES_META[draft.species].emoji}  A ${SPECIES_META[draft.species].label.toLowerCase()}, going by…`}
              </Text>
            ) : null}
          </Column>
        );

      case 'photo':
        return (
          <Column align="center" gap="base">
            <PhotoPicker
              value={draft.photoUri}
              onChange={(photoUri) => patch({ photoUri })}
              size={t.spacing.colossal * 2}
              label={`${possessive(trimmedName || 'your pet')} photo`}
              placeholderText="Add a photo"
              helper="A clear, head-on shot works best — it becomes their avatar everywhere."
            />
          </Column>
        );

      case 'age':
        return (
          <Column gap="lg">
            <SegmentedControl
              segments={AGE_SEGMENTS}
              value={draft.ageMode}
              onChange={(ageMode) => patch({ ageMode })}
              accessibilityLabel="How do you know their age?"
            />

            {draft.ageMode === 'birthday' ? (
              <DateField
                label="Date of birth"
                value={draft.birthday}
                onChange={(birthday) => patch({ birthday })}
                maxDate={toDateOnly(new Date())}
                placeholder="Pick their birthday"
                helper="We’ll count the years for you — and say happy birthday."
                clearable
              />
            ) : draft.ageMode === 'approximate' ? (
              <Column gap="md">
                <Row gap="base" align="start">
                  <Column flex gap="xs">
                    <Text variant="subheadStrong" color="textSecondary">
                      Years
                    </Text>
                    <Stepper
                      value={draft.approxYears}
                      onChange={(approxYears) => patch({ approxYears })}
                      min={0}
                      max={MAX_YEARS}
                      accessibilityLabel="Approximate age in years"
                    />
                  </Column>
                  <Column flex gap="xs">
                    <Text variant="subheadStrong" color="textSecondary">
                      Months
                    </Text>
                    <Stepper
                      value={draft.approxMonths}
                      onChange={(approxMonths) => patch({ approxMonths })}
                      min={0}
                      max={11}
                      accessibilityLabel="Approximate age in months"
                    />
                  </Column>
                </Row>
                <Text variant="footnote" color="textTertiary">
                  {ageSummary
                    ? `We’ll show ${trimmedName || 'them'} as ${ageSummary}.`
                    : 'A best guess is fine — you can sharpen it later.'}
                </Text>
              </Column>
            ) : (
              <Surface variant="surfaceAlt" radius="lg" padding="base" border>
                <Text variant="callout" color="textSecondary">
                  {`That’s completely fine. Plenty of rescues arrive with no paperwork — we’ll leave ${possessive(trimmedName || 'their')} age blank until a vet gives you one.`}
                </Text>
              </Surface>
            )}
          </Column>
        );

      case 'details':
        return (
          <Column gap="lg">
            {draft.species ? (
              <BreedField
                species={draft.species}
                value={draft.breed}
                onChange={(breed) => patch({ breed })}
                helper="Crossbreeds and best guesses welcome — type anything."
              />
            ) : null}

            <Column gap="sm">
              <Text variant="subheadStrong" color="textSecondary">
                Sex
              </Text>
              <SegmentedControl
                segments={SEX_SEGMENTS}
                value={draft.sex}
                onChange={(sex) => patch({ sex })}
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
                accessibilityLabel="Neutered or spayed"
              />
              <Text variant="footnote" color="textTertiary">
                Vets ask this at almost every visit, so it’s worth a tap now.
              </Text>
            </Column>
          </Column>
        );

      case 'weight':
        return (
          <Column gap="md">
            <Input
              label={`Weight in ${weightUnitLabel(unit)}`}
              value={draft.weightText}
              onChangeText={(weightText) => patch({ weightText })}
              error={weightError}
              placeholder={unit === 'lb' ? '18.5' : '8.4'}
              helper="Roughly is fine. You can change your units in Settings."
              leadingIcon="fitness-outline"
              keyboardType="decimal-pad"
              returnKeyType="done"
              onSubmitEditing={next}
              clearable
            />
            <Surface variant="surfaceAlt" radius="lg" padding="base" border>
              <Text variant="footnote" color="textSecondary">
                {`Weighing ${trimmedName || 'them'} every few months is the cheapest early-warning system there is — Petal charts it and flags the drifts.`}
              </Text>
            </Surface>
          </Column>
        );

      case 'microchip':
        return (
          <Column gap="md">
            <Input
              label="Chip number"
              value={draft.microchipId}
              onChangeText={(microchipId) => patch({ microchipId })}
              placeholder="985 1410 0012 3456"
              helper="15 digits on most chips. We only ever store it on this pet."
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
          </Column>
        );

      case 'review':
      default:
        return (
          <Surface variant="surface" elevation={1} radius="xxl" padding="sm">
            <ListRow
              title="Kind of pet"
              value={draft.species ? SPECIES_META[draft.species].label : 'Not set'}
              leading={
                <Text variant="title2" maxFontSizeMultiplier={1.1}>
                  {draft.species ? SPECIES_META[draft.species].emoji : '🐾'}
                </Text>
              }
              onPress={() => editFromReview(STEPS.indexOf('species'))}
              accessibilityHint="Goes back to change the kind of pet."
              divider
            />
            <ListRow
              title="Name"
              value={trimmedName || 'Not set'}
              icon="paw-outline"
              onPress={() => editFromReview(STEPS.indexOf('name'))}
              accessibilityHint="Goes back to change the name."
              divider
            />
            <ListRow
              title="Photo"
              value={draft.photoUri ? 'Added' : 'None yet'}
              icon="camera-outline"
              iconTone="accent"
              onPress={() => editFromReview(STEPS.indexOf('photo'))}
              accessibilityHint="Goes back to change the photo."
              divider
            />
            <ListRow
              title="Age"
              value={ageSummary ?? 'Unknown'}
              valueCaption={
                draft.ageMode === 'birthday' && draft.birthday ? formatDay(draft.birthday) : undefined
              }
              icon="gift-outline"
              iconTone="accent"
              onPress={() => editFromReview(STEPS.indexOf('age'))}
              accessibilityHint="Goes back to change the age."
              divider
            />
            <ListRow
              title="Breed & details"
              value={draft.breed.trim() || 'Not set'}
              valueCaption={
                SEX_SEGMENTS.find((segment) => segment.value === draft.sex)?.label ?? undefined
              }
              icon="ribbon-outline"
              iconTone="info"
              onPress={() => editFromReview(STEPS.indexOf('details'))}
              accessibilityHint="Goes back to change breed, sex and neutering."
              divider
            />
            <ListRow
              title="Weight"
              value={
                draft.weightText.trim().length > 0
                  ? `${draft.weightText.trim()} ${weightUnitLabel(unit)}`
                  : 'Not weighed yet'
              }
              icon="fitness-outline"
              iconTone="success"
              onPress={() => editFromReview(STEPS.indexOf('weight'))}
              accessibilityHint="Goes back to change the weight."
              divider
            />
            <ListRow
              title="Microchip"
              value={draft.microchipId.trim() || 'Not added'}
              valueCaption={draft.microchipRegistry.trim() || undefined}
              icon="hardware-chip-outline"
              iconTone="neutral"
              onPress={() => editFromReview(STEPS.indexOf('microchip'))}
              accessibilityHint="Goes back to change the microchip details."
            />
          </Surface>
        );
    }
  })();

  /* ---- chrome ----------------------------------------------------------- */

  const header = (
    <ScreenHeader
      title="Add a pet"
      large={false}
      showBack={false}
      leading={
        <IconButton
          icon="close"
          accessibilityLabel="Close"
          accessibilityHint="Leaves without adding this pet."
          variant="ghost"
          tone="neutral"
          onPress={close}
        />
      }
    />
  );

  const entering = t.reduceMotion
    ? FadeIn.duration(t.motion.duration.base)
    : (direction === 1 ? FadeInRight : FadeInLeft)
        .duration(t.motion.duration.base)
        .easing(t.motion.easing.decelerate);

  return (
    <Screen
      header={header}
      scroll
      contentContainerStyle={{ gap: t.spacing.xl, paddingBottom: t.spacing.lg }}
    >
      <StepRail step={index + 1} total={STEPS.length} />

      <Animated.View
        key={step}
        entering={entering}
        layout={LinearTransition.duration(t.motion.duration.base)}
        style={{ gap: t.spacing.lg }}
      >
        <Column gap="sm">
          <Text variant="overline" color="primaryText">
            {`Step ${index + 1} of ${STEPS.length}`}
          </Text>
          <Text variant="display" accessibilityRole="header">
            {copy.title}
          </Text>
          <Text variant="callout" color="textSecondary">
            {copy.body}
          </Text>
        </Column>

        {stepBody}
      </Animated.View>

      <Spacer />

      <Row gap="sm" style={{ paddingBottom: t.spacing.sm }}>
        {index > 0 ? (
          <Button
            label="Back"
            onPress={back}
            variant="secondary"
            size="lg"
            leftIcon="chevron-back"
            accessibilityHint="Goes back one step."
          />
        ) : null}
        <View style={{ flex: 1 }}>
          <Button
            label={continueLabel}
            onPress={next}
            variant="primary"
            size="lg"
            hero
            fullWidth
            loading={createPet.isPending}
            haptic="commit"
            rightIcon={isLast ? 'sparkles' : fromReview ? 'checkmark' : 'chevron-forward'}
          />
        </View>
      </Row>

      <ConfirmSheet
        controller={leaveSheet}
        title="Leave without adding?"
        body={
          trimmedName
            ? `We haven’t saved anything about ${trimmedName} yet, so this would start over.`
            : 'We haven’t saved anything yet, so this would start over.'
        }
        confirmLabel="Discard"
        cancelLabel="Keep going"
        icon="close-circle-outline"
        onConfirm={() => router.back()}
      />
    </Screen>
  );
}
