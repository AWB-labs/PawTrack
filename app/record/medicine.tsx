/**
 * Create or edit a prescription.
 *
 * The hardest part of a medicine form is that *frequency* and *dose times* are
 * two different facts that look like one. "Twice a day" doesn't say 8 and 8; the
 * vet said twice, the household decides when. So the frequency picker seeds the
 * times and then gets out of the way — you can move them, add one, drop one, and
 * the frequency stays what the vet wrote.
 *
 * Everything else follows the same rule as the feeding editor: the card at the
 * top is the *real* `MedicineCard`, updating as you type, so you are editing an
 * object rather than answering a questionnaire.
 *
 * `medicine.edit` is owner-only and can never be granted to a caregiver, so a
 * sitter who lands here by deep link gets the honest "this stays with the owner"
 * panel rather than a form full of dead controls.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';

import { useDeleteMedicine, useMedicines, useSaveMedicine } from '@/data/queries/useMedicine';
import { usePet } from '@/data/queries/usePets';
import type { DateOnly, Medicine, MedicineForm, MedicineFrequency, TimeOfDay } from '@/data/types';
import {
  MEDICINE_FORM_META,
  MEDICINE_FREQUENCY_META,
  MedicineCard,
} from '@/features/medicine/MedicineCard';
import { compareTimeOfDay, formatTimeOfDay, friendlyDate, toDateOnly } from '@/lib/date';
import { toHref } from '@/lib/deeplinks';
import { joinWithAnd, plural, possessive } from '@/lib/format';
import haptics from '@/lib/haptics';
import { DENIAL_COPY, type DenialReason } from '@/rbac/permissions';
import { usePermission } from '@/rbac/usePermission';
import { useTheme } from '@/theme';
import {
  Button,
  Chip,
  Column,
  ConfirmSheet,
  DateField,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  Input,
  Row,
  Screen,
  ScreenHeader,
  SectionHeader,
  Select,
  Stepper,
  Surface,
  Switch,
  Text,
  TextArea,
  TimeField,
  toast,
  Touchable,
  useSheet,
  type SelectOption,
} from '@/ui';
import { PermissionLocked } from '@/ui/illustrations';
import { SkeletonGroup } from '@/ui/Skeleton';
import { ListRowSkeleton } from '@/ui/skeletons/ContentSkeletons';

/* ---------------------------------------------------------------- constants */

const FORMS = Object.keys(MEDICINE_FORM_META) as MedicineForm[];

const FREQUENCY_HINT: Record<MedicineFrequency, string> = {
  daily: 'One dose a day',
  twiceDaily: 'Two doses — usually morning and evening',
  threeTimesDaily: 'Three doses spread across the day',
  everyOtherDay: 'One dose, alternate days',
  weekly: 'One dose a week, on the day it started',
  monthly: 'One dose a month, on the date it started',
  asNeeded: 'No schedule — you log it when you give it',
};

const FREQUENCY_OPTIONS: SelectOption<MedicineFrequency>[] = (
  Object.keys(MEDICINE_FREQUENCY_META) as MedicineFrequency[]
).map((key) => ({
  value: key,
  label: MEDICINE_FREQUENCY_META[key].label,
  description: FREQUENCY_HINT[key],
}));

/** Sensible household defaults. The vet says how often; this says when. */
const DEFAULT_TIMES: Record<MedicineFrequency, TimeOfDay[]> = {
  daily: ['08:00'],
  twiceDaily: ['08:00', '20:00'],
  threeTimesDaily: ['08:00', '14:00', '20:00'],
  everyOtherDay: ['08:00'],
  weekly: ['09:00'],
  monthly: ['09:00'],
  asNeeded: [],
};

const DOSAGE_SUGGESTIONS = ['½ tablet', '1 tablet', '2 tablets', '1 ml', '5 mg'] as const;

const MAX_NAME = 48;
const MAX_DOSAGE = 32;
const MAX_INSTRUCTIONS = 300;

/** Enough for a year of a daily tablet. */
const MAX_PACK = 365;

const DEFAULT_PACK = 30;

/* ------------------------------------------------------------------ helpers */

function denial(reason: DenialReason | null): { title: string; body: string } {
  return DENIAL_COPY[reason ?? 'owner-only'];
}

/* -------------------------------------------------------------- form picker */

type FormPickerProps = {
  value: MedicineForm;
  onChange: (form: MedicineForm) => void;
};

/** Eight tiles. A glyph plus a word beats a dropdown you have to open to read. */
function FormPicker({ value, onChange }: FormPickerProps) {
  const t = useTheme();
  const tile = t.spacing.giant + t.spacing.sm;

  return (
    <Row gap="sm" wrap>
      {FORMS.map((form) => {
        const meta = MEDICINE_FORM_META[form];
        const on = form === value;
        return (
          <Touchable
            key={form}
            accessibilityRole="radio"
            accessibilityLabel={meta.label}
            accessibilityState={{ checked: on }}
            haptic="select"
            onPress={() => onChange(form)}
            pressScale="small"
            style={{ width: tile }}
          >
            <Surface
              variant={on ? 'surface' : 'surfaceAlt'}
              elevation={on ? 1 : 0}
              radius="lg"
              padding="sm"
              border={!on}
              style={[
                { alignItems: 'center', gap: t.spacing.xxs },
                on ? { borderWidth: t.borderWidth.thick, borderColor: t.color.primary } : null,
              ]}
            >
              <Icon name={meta.icon} size="lg" color={on ? 'primaryText' : 'textSecondary'} />
              <Text
                variant="caption"
                color={on ? 'onPrimarySoft' : 'textTertiary'}
                numberOfLines={1}
                align="center"
              >
                {meta.label}
              </Text>
            </Surface>
          </Touchable>
        );
      })}
    </Row>
  );
}

/* ---------------------------------------------------------------- component */

export default function MedicineFormScreen() {
  const t = useTheme();
  const router = useRouter();
  const { petId = '', id } = useLocalSearchParams<{ petId?: string; id?: string }>();

  const petQuery = usePet(petId);
  const pet = petQuery.data ?? null;
  const petName = pet?.name ?? 'your pet';

  const permission = usePermission('medicine.edit', petId);
  const medicinesQuery = useMedicines(permission.allowed ? petId : null);
  const saveMedicine = useSaveMedicine(petId);
  const deleteMedicine = useDeleteMedicine(petId);
  const deleteSheet = useSheet();

  const existing = useMemo(
    () => (id ? (medicinesQuery.data ?? []).find((row) => row.id === id) : undefined),
    [id, medicinesQuery.data],
  );

  /* ---- draft ------------------------------------------------------------ */

  const [name, setName] = useState('');
  const [form, setForm] = useState<MedicineForm>('tablet');
  const [dosage, setDosage] = useState('');
  const [frequency, setFrequency] = useState<MedicineFrequency>('daily');
  const [times, setTimes] = useState<TimeOfDay[]>([...DEFAULT_TIMES.daily]);
  const [startsAt, setStartsAt] = useState<DateOnly>(toDateOnly(new Date()));
  const [endsAt, setEndsAt] = useState<DateOnly | null>(null);
  const [trackPack, setTrackPack] = useState(true);
  const [pack, setPack] = useState(DEFAULT_PACK);
  const [refillAt, setRefillAt] = useState<DateOnly | null>(null);
  const [withFood, setWithFood] = useState(false);
  const [remindersOn, setRemindersOn] = useState(true);
  const [active, setActive] = useState(true);
  const [prescribedBy, setPrescribedBy] = useState('');
  const [instructions, setInstructions] = useState('');
  const [errors, setErrors] = useState<{ name?: string; dosage?: string }>({});

  /** Seed once — a later refetch must not stamp on what is being typed. */
  const seeded = useRef(false);
  useEffect(() => {
    if (!existing || seeded.current) return;
    seeded.current = true;
    setName(existing.name);
    setForm(existing.form);
    setDosage(existing.dosage);
    setFrequency(existing.frequency);
    setTimes([...existing.timesOfDay]);
    setStartsAt(existing.startsAt);
    setEndsAt(existing.endsAt);
    setTrackPack(existing.remainingDoses !== null);
    setPack(existing.remainingDoses ?? DEFAULT_PACK);
    setRefillAt(existing.refillAt);
    setWithFood(existing.withFood);
    setRemindersOn(existing.remindersOn);
    setActive(existing.active);
    setPrescribedBy(existing.prescribedBy ?? '');
    setInstructions(existing.instructions ?? '');
  }, [existing]);

  const draft = useMemo<Medicine>(
    () => ({
      id: existing?.id ?? 'draft',
      petId,
      name: name.trim() || 'This medicine',
      form,
      dosage: dosage.trim() || 'one dose',
      frequency,
      timesOfDay: times,
      startsAt,
      endsAt,
      remainingDoses: trackPack ? pack : null,
      refillAt,
      prescribedBy: prescribedBy.trim() || null,
      instructions: instructions.trim() || null,
      withFood,
      remindersOn,
      active,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    }),
    [
      active,
      dosage,
      endsAt,
      existing,
      form,
      frequency,
      instructions,
      name,
      pack,
      petId,
      prescribedBy,
      refillAt,
      remindersOn,
      startsAt,
      times,
      trackPack,
      withFood,
    ],
  );

  /* ---- times ------------------------------------------------------------ */

  const setSlot = useCallback((index: number, value: TimeOfDay) => {
    setTimes((current) => {
      const next = [...current];
      next[index] = value;
      return [...next].sort(compareTimeOfDay);
    });
  }, []);

  const addSlot = useCallback(() => {
    haptics.select();
    setTimes((current) => [...current, current.length > 0 ? '12:00' : '08:00'].sort(compareTimeOfDay));
  }, []);

  const removeSlot = useCallback((index: number) => {
    haptics.tap();
    setTimes((current) => current.filter((_, position) => position !== index));
  }, []);

  const changeFrequency = useCallback((next: MedicineFrequency) => {
    setFrequency(next);
    // The vet decides how often; these are the household's usual hours for it,
    // offered as a starting point rather than imposed.
    setTimes([...DEFAULT_TIMES[next]]);
  }, []);

  /* ---- actions ---------------------------------------------------------- */

  const save = useCallback(async () => {
    const next: { name?: string; dosage?: string } = {};
    if (!name.trim()) next.name = 'What is it called? The label on the box is fine.';
    if (!dosage.trim()) next.dosage = 'How much per dose? “1 tablet”, “5 mg”, “2 ml”.';

    setErrors(next);
    if (Object.keys(next).length > 0) {
      haptics.error();
      return;
    }

    try {
      await saveMedicine.mutateAsync({
        id: existing?.id,
        name: name.trim(),
        form,
        dosage: dosage.trim(),
        frequency,
        timesOfDay: times,
        startsAt,
        endsAt,
        remainingDoses: trackPack ? pack : null,
        refillAt,
        prescribedBy: prescribedBy.trim() || null,
        instructions: instructions.trim() || null,
        withFood,
        remindersOn,
        active,
      });

      haptics.success();
      toast.success(existing ? `${name.trim()} updated` : `${name.trim()} added`, {
        description:
          times.length > 0
            ? `${MEDICINE_FREQUENCY_META[frequency].label} at ${joinWithAnd(times.map(formatTimeOfDay))}.`
            : `Logged whenever you give it — no schedule, as you asked.`,
        haptic: false,
      });
      router.back();
    } catch {
      // The mutation raises its own error toast; the draft stays put.
    }
  }, [
    active,
    dosage,
    endsAt,
    existing,
    form,
    frequency,
    instructions,
    name,
    pack,
    prescribedBy,
    refillAt,
    remindersOn,
    router,
    saveMedicine,
    startsAt,
    times,
    trackPack,
    withFood,
  ]);

  /* ---- gates ------------------------------------------------------------ */

  const close = (
    <IconButton
      icon="close"
      accessibilityLabel="Close"
      accessibilityHint="Discards this prescription and goes back."
      variant="tonal"
      tone="neutral"
      onPress={() => router.back()}
    />
  );

  if (!permission.allowed) {
    const copy = denial(permission.reason);
    return (
      <Screen center header={<ScreenHeader title="Medicine" large={false} leading={close} />}>
        <EmptyState
          tone="neutral"
          illustration={<PermissionLocked size={t.spacing.colossal * 3} />}
          headline={copy.title}
          body={copy.body}
          action={{
            label: 'Tell me more',
            icon: 'help-circle-outline',
            onPress: () => permission.explain({ petName }),
          }}
          secondaryAction={{ label: 'Go back', onPress: () => router.back() }}
        />
      </Screen>
    );
  }

  if (id && medicinesQuery.isPending) {
    return (
      <Screen header={<ScreenHeader title="Medicine" large={false} leading={close} />} scroll>
        <SkeletonGroup label="Loading this prescription" gap="lg">
          <ListRowSkeleton count={5} avatar={false} />
        </SkeletonGroup>
      </Screen>
    );
  }

  if (id && medicinesQuery.isError) {
    return (
      <Screen center header={<ScreenHeader title="Medicine" large={false} leading={close} />}>
        <ErrorState
          error={medicinesQuery.error}
          title="We couldn’t open this prescription"
          body="It’s still on file — the app just couldn’t fetch it this time."
          onRetry={() => medicinesQuery.refetch()}
        />
      </Screen>
    );
  }

  if (id && !existing) {
    return (
      <Screen center header={<ScreenHeader title="Medicine" large={false} leading={close} />}>
        <EmptyState
          tone="neutral"
          icon="medkit-outline"
          headline="That prescription is gone"
          body={`It looks like it was deleted. ${possessive(petName)} other medicines are untouched.`}
          action={{
            label: 'Back to medicine',
            icon: 'arrow-back',
            onPress: () => router.replace(toHref(`/pet/${petId}/medicine`)),
          }}
        />
      </Screen>
    );
  }

  const scheduled = frequency !== 'asNeeded';

  /* ---- content ---------------------------------------------------------- */

  return (
    <Screen
      header={
        <ScreenHeader
          title={existing ? 'Edit medicine' : 'New medicine'}
          subtitle={pet ? `for ${pet.name}` : undefined}
          leading={close}
          actions={
            existing ? (
              <IconButton
                icon="trash-outline"
                accessibilityLabel="Delete this medicine"
                accessibilityHint="Removes the prescription and its dose history."
                variant="tonal"
                tone="danger"
                onPress={() => deleteSheet.open()}
              />
            ) : null
          }
        />
      }
      scroll
      contentContainerStyle={{ gap: t.spacing.xl, paddingBottom: t.spacing.xxl }}
      footer={
        <Button
          label={existing ? 'Save changes' : `Add ${name.trim() || 'this medicine'}`}
          onPress={() => void save()}
          variant="primary"
          size="lg"
          fullWidth
          hero
          loading={saveMedicine.isPending}
          haptic="none"
          accessibilityHint={`Adds ${name.trim() || 'this medicine'} to ${possessive(petName)} prescriptions.`}
        />
      }
    >
      <Animated.View layout={LinearTransition.duration(t.motion.duration.base)}>
        <MedicineCard medicine={draft} petName={petName} animate={false} />
      </Animated.View>

      <Column gap="base">
        <SectionHeader
          title="What it is"
          subtitle="Straight off the label — you'll thank yourself at the vet."
          icon="medkit-outline"
          iconColor="primaryText"
          first
        />

        <Input
          value={name}
          onChangeText={(next) => {
            setName(next);
            if (errors.name) setErrors((current) => ({ ...current, name: undefined }));
          }}
          label="Name"
          placeholder="Vetmedin, Apoquel, Metacam…"
          error={errors.name}
          leadingIcon="bandage-outline"
          maxLength={MAX_NAME}
          showCounter={false}
          clearable
          autoCapitalize="words"
        />

        <Column gap="sm">
          <Text variant="subheadStrong" color="textSecondary">
            What form does it come in?
          </Text>
          <FormPicker value={form} onChange={setForm} />
        </Column>

        <Column gap="sm">
          <Input
            value={dosage}
            onChangeText={(next) => {
              setDosage(next);
              if (errors.dosage) setErrors((current) => ({ ...current, dosage: undefined }));
            }}
            label="Dose"
            placeholder="1 tablet"
            error={errors.dosage}
            leadingIcon="calculator-outline"
            maxLength={MAX_DOSAGE}
            showCounter={false}
            clearable
          />
          <Row gap="sm" wrap>
            {DOSAGE_SUGGESTIONS.map((suggestion) => (
              <Chip
                key={suggestion}
                label={suggestion}
                selected={dosage.trim() === suggestion}
                onPress={() => {
                  setDosage(suggestion);
                  setErrors((current) => ({ ...current, dosage: undefined }));
                }}
                size="sm"
              />
            ))}
          </Row>
        </Column>

        <Switch
          value={withFood}
          onValueChange={setWithFood}
          label="Give with food"
          description="Shown on the dose button itself, not buried in the notes."
          tone="accent"
        />
      </Column>

      <Column gap="base">
        <SectionHeader
          title="How often"
          subtitle={
            scheduled
              ? `${MEDICINE_FREQUENCY_META[frequency].label} · ${plural(times.length, 'time')} a day set`
              : 'No schedule — you log it whenever you give it.'
          }
          icon="repeat-outline"
          iconColor="accentText"
        />

        <Select
          value={frequency}
          onChange={changeFrequency}
          options={FREQUENCY_OPTIONS}
          label="Frequency"
          title="How often is it given?"
          subtitle="Whatever the vet wrote on the label."
          leadingIcon="repeat-outline"
        />

        {scheduled ? (
          <Animated.View
            layout={LinearTransition.duration(t.motion.duration.base)}
            style={{ gap: t.spacing.sm }}
          >
            <Text variant="subheadStrong" color="textSecondary">
              Dose times
            </Text>
            <Text variant="caption" color="textTertiary">
              Seeded from the frequency — move them to whatever fits your day.
            </Text>

            {times.length === 0 ? (
              <Surface variant="surfaceAlt" radius="lg" padding="base" border>
                <Text variant="footnote" color="textSecondary">
                  No times yet, so nothing will appear on Today. Add at least one.
                </Text>
              </Surface>
            ) : null}

            {times.map((slot, index) => (
              <Animated.View
                key={`${slot}-${index}`}
                entering={FadeIn.duration(t.motion.duration.fast)}
                layout={LinearTransition.duration(t.motion.duration.base)}
              >
                <Row gap="sm" align="center">
                  <View style={{ flex: 1 }}>
                    <TimeField
                      value={slot}
                      onChange={(value) => setSlot(index, value)}
                      label={`Dose ${index + 1}`}
                      title={`When is dose ${index + 1}?`}
                      minuteStep={5}
                    />
                  </View>
                  <IconButton
                    icon="close"
                    accessibilityLabel={`Remove the ${formatTimeOfDay(slot)} dose`}
                    variant="tonal"
                    tone="neutral"
                    size="sm"
                    onPress={() => removeSlot(index)}
                    disabled={times.length <= 1}
                  />
                </Row>
              </Animated.View>
            ))}

            <Button
              label="Add another time"
              onPress={addSlot}
              variant="ghost"
              size="sm"
              leftIcon="add"
              accessibilityHint="Adds another dose slot to each day."
            />
          </Animated.View>
        ) : null}
      </Column>

      <Column gap="base">
        <SectionHeader
          title="The course"
          subtitle={
            endsAt ? `Ends ${friendlyDate(endsAt).toLowerCase()}` : 'Ongoing — no end date set.'
          }
          icon="calendar-outline"
          iconColor="textTertiary"
        />

        <DateField
          value={startsAt}
          onChange={(next) => setStartsAt(next ?? toDateOnly(new Date()))}
          label="Starts"
          title="First day of the course"
        />

        <DateField
          value={endsAt}
          onChange={setEndsAt}
          label="Ends"
          placeholder="Ongoing"
          helper="Leave it empty for lifelong medication."
          minDate={startsAt}
          clearable
        />
      </Column>

      <Column gap="base">
        <SectionHeader
          title="The pack"
          subtitle={
            trackPack
              ? `${plural(pack, 'dose')} in hand — we'll warn you before they run out.`
              : 'Not tracked — no refill nudge for this one.'
          }
          icon="bandage-outline"
          iconColor="primaryText"
        />

        <Switch
          value={trackPack}
          onValueChange={setTrackPack}
          label="Count the doses left"
          description="Every logged dose takes one off, so the refill nudge is honest."
        />

        {trackPack ? (
          <Animated.View
            entering={FadeIn.duration(t.motion.duration.base)}
            layout={LinearTransition.duration(t.motion.duration.base)}
            style={{ gap: t.spacing.base }}
          >
            <Row gap="md" align="center">
              <Stepper
                value={pack}
                onChange={setPack}
                min={0}
                max={MAX_PACK}
                step={1}
                unit={pack === 1 ? 'dose' : 'doses'}
                accessibilityLabel="Doses in the pack"
                accessibilityHint="Hold to change it quickly."
              />
              <Text variant="caption" color="textTertiary" style={{ flex: 1 }}>
                {MEDICINE_FREQUENCY_META[frequency].perDay > 0
                  ? `About ${plural(
                      Math.floor(pack / MEDICINE_FREQUENCY_META[frequency].perDay),
                      'day',
                    )} of cover.`
                  : 'No schedule, so there’s no run-out date to project.'}
              </Text>
            </Row>

            <DateField
              value={refillAt}
              onChange={setRefillAt}
              label="Remind me to reorder"
              placeholder="Let Furry Tracker work it out"
              helper="Leave it empty and we'll nudge you a few days before it runs out."
              minDate={toDateOnly(new Date())}
              clearable
            />
          </Animated.View>
        ) : null}
      </Column>

      <Column gap="base">
        <SectionHeader title="Reminders & notes" variant="overline" />

        <Switch
          value={remindersOn}
          onValueChange={setRemindersOn}
          label="Remind me at dose time"
          description={
            scheduled
              ? `A nudge at ${times.length > 0 ? joinWithAnd(times.map(formatTimeOfDay)) : 'each dose time'}. Medicine reminders are the one alert Furry Tracker asks to break through Focus.`
              : 'Only useful once this has dose times.'
          }
          disabled={!scheduled}
        />

        <Input
          value={prescribedBy}
          onChangeText={setPrescribedBy}
          label="Prescribed by"
          placeholder="Dr Aziz, Northgate Vets"
          leadingIcon="person-outline"
          clearable
          autoCapitalize="words"
        />

        <TextArea
          value={instructions}
          onChangeText={setInstructions}
          label="Instructions"
          placeholder={`Hide it in cheese, or whatever actually works with ${petName}`}
          minRows={2}
          maxRows={6}
          maxLength={MAX_INSTRUCTIONS}
        />

        {existing ? (
          <Switch
            value={active}
            onValueChange={setActive}
            label="Currently being given"
            description={
              active
                ? 'Doses show on Today and count towards adherence.'
                : 'Paused — kept on file for the vet, but nothing is scheduled.'
            }
          />
        ) : null}
      </Column>

      <ConfirmSheet
        controller={deleteSheet}
        title={`Delete ${existing?.name ?? 'this medicine'}?`}
        body={`The prescription and every dose logged against it go with it. ${possessive(petName)} other medicines are untouched.`}
        confirmLabel="Delete it"
        cancelLabel="Keep it"
        icon="trash-outline"
        onConfirm={() => {
          if (!existing) return;
          deleteMedicine.mutate(existing.id);
          toast.success(`${existing.name} removed`, {
            description: 'The course and its dose history are gone.',
            haptic: false,
          });
          router.back();
        }}
      />
    </Screen>
  );
}
