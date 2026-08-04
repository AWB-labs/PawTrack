/**
 * Petal — VisitWriteUpSheet.
 *
 * The moment an appointment is marked "we went", this is what appears.
 *
 * The brief asks for appointments and vet visits to cross-link. The temptation
 * is a "Create linked vet visit" button somewhere in a menu — technically the
 * requirement, practically a second chore nobody does, which leaves the history
 * permanently one visit behind reality. So the write-up is offered at the only
 * moment the answers are fresh: on the way out of the car park, straight after
 * the tap that said the visit happened.
 *
 * Three things ride along with it, because they're the three things a vet
 * actually tells you and the three that otherwise get typed into three separate
 * screens later, or not at all:
 *
 *   · **The weight.** Prefilled from the pet's last reading so it's a nudge, not
 *     a data-entry task, and written as a real weigh-in dated to the visit.
 *   · **The vaccinations that were linked to the booking.** Ticking one marks it
 *     given and rolls the next due date forward by the interval that vaccine was
 *     already running on — so the reminder keeps working without anyone doing
 *     the arithmetic.
 *   · **The follow-up date**, which is the one thing you're told at the desk and
 *     have forgotten by the time you're home.
 *
 * Every carry-over is separately gated: a sitter with `vetvisit.edit` but not
 * `weight.log` gets the write-up with the weight block disabled and explaining
 * itself, rather than a save that silently drops half of what they typed.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';

import { useSaveVaccination, useSaveVetVisit, useAddWeight } from '@/data/queries/useHealth';
import type {
  Appointment,
  DateOnly,
  ID,
  Pet,
  Vaccination,
  VetVisit,
  VetVisitType,
} from '@/data/types';
import { DAY_MS, friendlyDate, toDate, toDateOnly } from '@/lib/date';
import {
  displayWeightUnit,
  formatWeight,
  fromDisplayWeight,
  possessive,
  weightUnitLabel,
} from '@/lib/format';
import haptics from '@/lib/haptics';
import { DENIAL_COPY } from '@/rbac/permissions';
import { usePermission } from '@/rbac/usePermission';
import { useTheme } from '@/theme';
import {
  Button,
  Checkbox,
  Chip,
  Column,
  confetti,
  DateField,
  Divider,
  Icon,
  Input,
  Row,
  Sheet,
  Surface,
  Text,
  TextArea,
  toast,
  type IconName,
  type SheetController,
} from '@/ui';

import { APPOINTMENT_TYPE_META } from './AppointmentCard';

/* -------------------------------------------------------------------- types */

export type VisitWriteUpSheetProps = {
  controller: SheetController;
  /** The appointment being written up. Null whenever the sheet is closed. */
  appointment: Appointment | null;
  pet: Pet;
  /** Vaccinations for this pet, already fetched. Only linked ones are offered. */
  vaccinations?: readonly Vaccination[];
  /**
   * Currency for the visit record. There's no cost field here — a write-up is
   * about care, not bookkeeping — but the model requires the code, so the host
   * can pass whatever the pet's previous visits used.
   */
  currency?: string;
  onSaved?: (visit: VetVisit) => void;
  /** Fired whenever the sheet goes away, saved or not — clear the host's selection here. */
  onDismiss?: () => void;
};

type VisitTypeMeta = { label: string; icon: IconName };

/* ---------------------------------------------------------------- constants */

const VISIT_TYPES: readonly VetVisitType[] = [
  'checkup',
  'vaccination',
  'illness',
  'injury',
  'dental',
  'surgery',
  'other',
];

const VISIT_TYPE_META: Record<VetVisitType, VisitTypeMeta> = {
  checkup: { label: 'Check-up', icon: 'pulse-outline' },
  vaccination: { label: 'Vaccination', icon: 'shield-checkmark-outline' },
  illness: { label: 'Illness', icon: 'thermometer-outline' },
  injury: { label: 'Injury', icon: 'bandage-outline' },
  dental: { label: 'Dental', icon: 'sparkles-outline' },
  surgery: { label: 'Surgery', icon: 'medkit-outline' },
  other: { label: 'Something else', icon: 'ellipsis-horizontal-outline' },
};

/** What the booking was for is the best first guess at what the visit was. */
const TYPE_FROM_APPOINTMENT: Record<Appointment['type'], VetVisitType> = {
  checkup: 'checkup',
  vaccination: 'vaccination',
  dental: 'dental',
  grooming: 'other',
  surgery: 'surgery',
  followUp: 'checkup',
  other: 'other',
};

/** Fallback booster interval when the record has nothing to infer one from. */
const DEFAULT_BOOSTER_DAYS = 365;

const DEFAULT_CURRENCY = 'GBP';

/* ------------------------------------------------------------------ helpers */

/**
 * Roll a vaccination forward. Reusing the interval it was already running on
 * keeps a six-month booster on six months instead of quietly becoming annual —
 * a difference that only shows up a year later, in the worst possible way.
 */
function nextDueAfter(vaccination: Vaccination, givenAt: Date): DateOnly {
  const previousGiven = toDate(vaccination.administeredAt);
  const previousDue = toDate(vaccination.dueAt);
  const measured =
    previousGiven && previousDue ? previousDue.getTime() - previousGiven.getTime() : 0;
  const span = measured > 0 ? measured : DEFAULT_BOOSTER_DAYS * DAY_MS;
  return toDateOnly(new Date(givenAt.getTime() + span));
}

function parseWeight(text: string): number | null {
  const value = Number(text.trim().replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/* ---------------------------------------------------------------- component */

export function VisitWriteUpSheet({
  controller,
  appointment,
  pet,
  vaccinations,
  currency = DEFAULT_CURRENCY,
  onSaved,
  onDismiss,
}: VisitWriteUpSheetProps) {
  const t = useTheme();

  const writeUp = usePermission('vetvisit.edit', pet.id);
  const logWeight = usePermission('weight.log', pet.id);
  const editVaccination = usePermission('vaccination.edit', pet.id);

  const saveVisit = useSaveVetVisit(pet.id);
  const addWeight = useAddWeight(pet.id);
  const saveVaccination = useSaveVaccination(pet.id);

  const [type, setType] = useState<VetVisitType>('checkup');
  const [diagnosis, setDiagnosis] = useState('');
  const [treatment, setTreatment] = useState('');
  const [notes, setNotes] = useState('');
  const [weighed, setWeighed] = useState(false);
  const [weightText, setWeightText] = useState('');
  const [weightError, setWeightError] = useState<string | undefined>(undefined);
  const [followUpAt, setFollowUpAt] = useState<DateOnly | null>(null);
  const [givenIds, setGivenIds] = useState<readonly ID[]>([]);
  const [saving, setSaving] = useState(false);

  const unit = displayWeightUnit();

  const linkedVaccinations = useMemo(
    () =>
      (vaccinations ?? []).filter((row) =>
        appointment ? appointment.linkedVaccinationIds.includes(row.id) : false,
      ),
    [appointment, vaccinations],
  );

  /** A fresh appointment is a fresh form — never someone else's half-typed notes. */
  useEffect(() => {
    if (!appointment) return;
    setType(TYPE_FROM_APPOINTMENT[appointment.type]);
    setDiagnosis('');
    setTreatment('');
    setNotes('');
    setWeighed(false);
    setWeightError(undefined);
    setWeightText(
      pet.currentWeightKg === null
        ? ''
        : formatWeight(pet.currentWeightKg, { withUnit: false, unit }),
    );
    setFollowUpAt(null);
    setGivenIds([]);
  }, [appointment, pet.currentWeightKg, unit]);

  const visitDate = useMemo(() => toDate(appointment?.at) ?? new Date(), [appointment?.at]);

  const explainWith = useMemo(() => ({ petName: pet.name }), [pet.name]);

  const toggleVaccination = useCallback((id: ID) => {
    setGivenIds((current) =>
      current.includes(id) ? current.filter((row) => row !== id) : [...current, id],
    );
  }, []);

  const handleClose = useCallback(() => {
    controller.close();
  }, [controller]);

  const handleSave = useCallback(() => {
    if (!appointment) return;

    const kgTyped = weighed ? parseWeight(weightText) : null;
    if (weighed && kgTyped === null) {
      setWeightError(`That doesn’t look like a weight in ${weightUnitLabel(unit)}.`);
      haptics.error();
      return;
    }
    setWeightError(undefined);

    const kg = kgTyped === null ? null : fromDisplayWeight(kgTyped, unit);
    const carriedVaccinations = editVaccination.allowed
      ? linkedVaccinations.filter((row) => givenIds.includes(row.id))
      : [];

    setSaving(true);
    void (async () => {
      try {
        const visit = await saveVisit.mutateAsync({
          at: appointment.at,
          type,
          reason: appointment.reason,
          vetName: appointment.vetName,
          clinic: appointment.clinic,
          diagnosis: diagnosis.trim() || null,
          treatment: treatment.trim() || null,
          weightKg: kg,
          costMinor: null,
          currency,
          followUpAt,
          notes: notes.trim() || null,
          documentIds: [...appointment.linkedDocumentIds],
        });

        if (kg !== null && logWeight.allowed) {
          await addWeight.mutateAsync({
            kg,
            recordedAt: appointment.at,
            note: appointment.clinic ? `Weighed at ${appointment.clinic}` : 'Weighed at the vet',
          });
        }

        const givenOn = toDateOnly(visitDate);
        for (const vaccination of carriedVaccinations) {
          await saveVaccination.mutateAsync({
            id: vaccination.id,
            name: vaccination.name,
            core: vaccination.core,
            administeredAt: givenOn,
            dueAt: nextDueAfter(vaccination, visitDate),
            vetName: appointment.vetName ?? vaccination.vetName,
            clinic: appointment.clinic ?? vaccination.clinic,
            batchNumber: vaccination.batchNumber,
            notes: vaccination.notes,
            documentIds: [...vaccination.documentIds],
          });
        }

        confetti.fire({ haptic: true });
        toast.success(`${possessive(pet.name)} visit is written up`, {
          description: describeCarryOver(kg, carriedVaccinations.length, followUpAt, unit),
        });

        onSaved?.(visit);
        controller.close();
      } catch {
        // The mutations already raise a themed error toast; this only has to
        // stop the button spinning and leave the form intact to retry.
        haptics.error();
      } finally {
        setSaving(false);
      }
    })();
  }, [
    addWeight,
    appointment,
    controller,
    currency,
    diagnosis,
    editVaccination.allowed,
    followUpAt,
    givenIds,
    linkedVaccinations,
    logWeight.allowed,
    notes,
    onSaved,
    pet.name,
    saveVaccination,
    saveVisit,
    treatment,
    type,
    unit,
    visitDate,
    weighed,
    weightText,
  ]);

  /* ---- one shell, two bodies -------------------------------------------- */

  /**
   * The host presents this sheet in the same handler that chooses the
   * appointment, so for exactly one render the controller is already opening
   * while `appointment` is still null. The shell — height, scrolling,
   * dismissal — therefore depends only on the permission verdict, which was
   * settled long before. Nothing re-snaps to a new height mid-animation; only
   * the content inside fills in, and React has flushed that within a frame.
   */
  const denialCopy = DENIAL_COPY[writeUp.reason ?? 'not-granted'];

  const subtitle = appointment
    ? [
        APPOINTMENT_TYPE_META[appointment.type].label,
        friendlyDate(appointment.at),
        appointment.clinic,
      ]
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
        .join(' · ')
    : undefined;

  return (
    <Sheet
      controller={controller}
      size={writeUp.allowed ? 'tall' : 'compact'}
      scrollable={writeUp.allowed}
      title={writeUp.allowed ? `How did ${pet.name} get on?` : denialCopy.title}
      subtitle={subtitle}
      dismissible={!saving}
      onDismiss={onDismiss}
      footer={
        writeUp.allowed && appointment ? (
          <Column gap="sm">
            <Button
              label="Save the write-up"
              variant="primary"
              size="lg"
              fullWidth
              hero
              haptic="commit"
              loading={saving}
              onPress={handleSave}
              accessibilityHint={`Adds this to ${possessive(pet.name)} vet history.`}
            />
            <Button
              label="Not right now"
              variant="ghost"
              size="md"
              fullWidth
              disabled={saving}
              onPress={handleClose}
              accessibilityHint="Closes without writing anything up. The visit stays marked as done."
            />
          </Column>
        ) : undefined
      }
      contentStyle={{ gap: t.spacing.xl }}
    >
      {!writeUp.allowed ? (
        <Column gap="base">
          <Text variant="callout" color="textSecondary">
            {denialCopy.body}
          </Text>
          <Row gap="sm">
            <Button
              label="Why not?"
              variant="tonal"
              onPress={() => writeUp.explain(explainWith)}
              accessibilityHint="Explains what access you'd need to write up a visit."
            />
            <Button label="Close" variant="ghost" onPress={handleClose} />
          </Row>
        </Column>
      ) : !appointment ? null : (
        <>
          <Surface variant="surfaceAlt" radius="lg" padding="md" style={{ gap: t.spacing.xs }}>
            <Row gap="sm" align="start">
              <Icon name="sparkles-outline" size="sm" color="onPrimarySoft" />
              <Text variant="footnote" color="textSecondary" style={{ flex: 1 }}>
                {`A couple of lines now saves digging through paperwork later — and anything you add here shows up in ${possessive(pet.name)} health record straight away.`}
              </Text>
            </Row>
          </Surface>

          {/* ---- what happened ------------------------------------------------ */}

          <Column gap="md">
            <Text variant="overline" color="textTertiary">
              What was it for?
            </Text>
            <Row gap="sm" wrap>
              {VISIT_TYPES.map((option) => (
                <Chip
                  key={option}
                  label={VISIT_TYPE_META[option].label}
                  icon={VISIT_TYPE_META[option].icon}
                  selected={type === option}
                  showCheck={false}
                  onPress={() => setType(option)}
                  accessibilityLabel={VISIT_TYPE_META[option].label}
                  accessibilityHint="Sets what kind of visit this was."
                />
              ))}
            </Row>

            <TextArea
              label="What did the vet say?"
              placeholder={`e.g. "Ears are clear, slight tartar on the back teeth"`}
              value={diagnosis}
              onChangeText={setDiagnosis}
              minRows={2}
              maxRows={5}
              maxLength={400}
              helper="The findings, in whatever words you remember them."
            />

            <TextArea
              label="What was done or prescribed?"
              placeholder={`e.g. "Ear drops twice a day for a week"`}
              value={treatment}
              onChangeText={setTreatment}
              minRows={2}
              maxRows={5}
              maxLength={400}
            />
          </Column>

          <Divider />

          {/* ---- carry-overs -------------------------------------------------- */}

          <Column gap="md">
            <Column gap="hair">
              <Text variant="overline" color="textTertiary">
                While you were there
              </Text>
              <Text variant="footnote" color="textSecondary">
                {`Tick anything the vet checked and we'll file it under ${possessive(pet.name)} record for you.`}
              </Text>
            </Column>

            <Surface variant="surface" radius="lg" padding="base" border style={{ gap: t.spacing.md }}>
              {/* `weight.log` is grantable, so a sitter without it sees the row
                  dimmed and gets the real reason on tap rather than a dead control. */}
              <Checkbox
                checked={weighed && logWeight.allowed}
                onChange={logWeight.allowed ? setWeighed : () => logWeight.explain(explainWith)}
                label={`${pet.name} was weighed`}
                description={
                  pet.currentWeightKg === null
                    ? 'This would be the first weight on record.'
                    : `Last on record: ${formatWeight(pet.currentWeightKg, { unit })}.`
                }
                disabledReason={
                  logWeight.allowed ? undefined : DENIAL_COPY[logWeight.reason ?? 'not-granted'].title
                }
                accessibilityHint={
                  logWeight.allowed
                    ? 'Records a weigh-in dated to this visit.'
                    : 'Explains why you can’t record a weight.'
                }
              />

              {weighed && logWeight.allowed ? (
                <Input
                  label="Weight at the visit"
                  value={weightText}
                  onChangeText={(next) => {
                    setWeightText(next);
                    if (weightError) setWeightError(undefined);
                  }}
                  keyboardType="decimal-pad"
                  inputMode="decimal"
                  leadingIcon="fitness-outline"
                  error={weightError}
                  maxLength={8}
                  trailing={
                    <Text variant="subheadStrong" color="textSecondary">
                      {weightUnitLabel(unit)}
                    </Text>
                  }
                  accessibilityLabel={`Weight in ${weightUnitLabel(unit)}`}
                  helper={
                    pet.targetWeightKg === null
                      ? undefined
                      : `Target is ${formatWeight(pet.targetWeightKg, { unit })}.`
                  }
                />
              ) : null}

              {linkedVaccinations.length > 0 ? (
                <>
                  <Divider />
                  <Column gap="sm">
                    <Text variant="subheadStrong">Vaccinations booked in</Text>
                    {linkedVaccinations.map((vaccination) => (
                      <Checkbox
                        key={vaccination.id}
                        checked={editVaccination.allowed && givenIds.includes(vaccination.id)}
                        onChange={
                          editVaccination.allowed
                            ? () => toggleVaccination(vaccination.id)
                            : () => editVaccination.explain(explainWith)
                        }
                        label={`${vaccination.name} given`}
                        description={`We’ll date it ${friendlyDate(visitDate)} and put the next one down for ${friendlyDate(nextDueAfter(vaccination, visitDate))}.`}
                        disabledReason={
                          editVaccination.allowed
                            ? undefined
                            : DENIAL_COPY[editVaccination.reason ?? 'not-granted'].title
                        }
                      />
                    ))}
                  </Column>
                </>
              ) : null}
            </Surface>
          </Column>

          <Divider />

          {/* ---- what happens next -------------------------------------------- */}

          <Column gap="md">
            <Column gap="hair">
              <Text variant="overline" color="textTertiary">
                What happens next
              </Text>
              <Text variant="footnote" color="textSecondary">
                {`If they asked to see ${pet.name} again, put the date in and it won't get lost.`}
              </Text>
            </Column>

            <DateField
              label="Come back on"
              value={followUpAt}
              onChange={setFollowUpAt}
              placeholder="No follow-up needed"
              minDate={toDateOnly(visitDate)}
              clearable
              title="When should you come back?"
            />

            <TextArea
              label="Anything else worth remembering"
              placeholder={`e.g. "Ask about the food next time"`}
              value={notes}
              onChangeText={setNotes}
              minRows={2}
              maxRows={6}
              maxLength={500}
            />
          </Column>

          {/* Breathing room above the pinned footer on short devices. */}
          <View style={{ height: t.spacing.sm }} />
        </>
      )}
    </Sheet>
  );
}

/* ------------------------------------------------------------------ copy */

/** The toast's second line — what actually got filed, named specifically. */
function describeCarryOver(
  kg: number | null,
  vaccinationCount: number,
  followUpAt: DateOnly | null,
  unit: ReturnType<typeof displayWeightUnit>,
): string {
  const parts: string[] = [];
  if (kg !== null) parts.push(formatWeight(kg, { unit }));
  if (vaccinationCount > 0) {
    parts.push(vaccinationCount === 1 ? '1 vaccination' : `${vaccinationCount} vaccinations`);
  }
  if (followUpAt) parts.push(`follow-up ${friendlyDate(followUpAt)}`);

  return parts.length === 0
    ? 'It’s in the vet history now.'
    : `Filed with it: ${parts.join(' · ')}.`;
}

export default VisitWriteUpSheet;
