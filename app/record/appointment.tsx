/**
 * Book or edit a vet appointment.
 *
 * `petId` alone means "book"; `petId` + `id` means "edit", so the two can never
 * drift apart.
 *
 * A booking form is where a care app most easily becomes a tax form: fourteen
 * fields, one Save button, no idea what any of it will do. The shape here fights
 * that in four ways:
 *
 *   · **Five titled sections, in the order you'd say them out loud** — what it's
 *     for, when, where, how you'll be reminded, what it belongs with. Each one
 *     is a decision, not a field.
 *   · **The form answers back.** Picking a type writes a sensible reason for
 *     you; picking a date and time produces a plain sentence ("Friday 12
 *     September at 3:00pm — that's in 8 days") right where you'd look to check
 *     it; the reminder picker previews the actual notification.
 *   · **Clinics you've used before are one tap**, filling the name, number and
 *     address together, because the second appointment at the same practice
 *     shouldn't cost the same typing as the first.
 *   · **Linking is a first-class step, not an afterthought.** The vaccination
 *     you're going for and the referral letter you'll be asked about get
 *     attached here, which is what makes the write-up flow work later.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import {
  useAppointments,
  useDeleteAppointment,
  useSaveAppointment,
} from '@/data/queries/useAppointments';
import { useDocuments, useVaccinations } from '@/data/queries/useHealth';
import { usePet } from '@/data/queries/usePets';
import type {
  Appointment,
  AppointmentStatus,
  AppointmentType,
  DateOnly,
  ID,
  TimeOfDay,
} from '@/data/types';
import {
  APPOINTMENT_STATUS_META,
  APPOINTMENT_TYPE_META,
  APPOINTMENT_TYPES,
  describeCountdown,
} from '@/features/appointments/AppointmentCard';
import {
  DEFAULT_REMINDER_OFFSETS,
  ReminderPicker,
} from '@/features/appointments/ReminderPicker';
import { applyTimeOfDay, formatDurationMinutes, toDate, toDateOnly, toTimeOfDay } from '@/lib/date';
import { toHref } from '@/lib/deeplinks';
import { possessive } from '@/lib/format';
import haptics from '@/lib/haptics';
import { DENIAL_COPY, type DenialReason } from '@/rbac/permissions';
import { useNow, usePermission } from '@/rbac/usePermission';
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
  ListRow,
  Row,
  Screen,
  ScreenHeader,
  SectionHeader,
  Select,
  Skeleton,
  SkeletonGroup,
  Surface,
  Text,
  TextArea,
  TimeField,
  toast,
  useSheet,
  type SelectOption,
} from '@/ui';
import { PermissionLocked } from '@/ui/illustrations';

/* ---------------------------------------------------------------- constants */

/** What people call each kind of visit, so the reason field starts filled in. */
const DEFAULT_REASON: Record<AppointmentType, string> = {
  checkup: 'Annual check-up',
  vaccination: 'Booster jab',
  dental: 'Dental clean',
  grooming: 'Grooming appointment',
  surgery: 'Surgery',
  followUp: 'Follow-up visit',
  other: '',
};

const DEFAULT_REASONS = new Set(Object.values(DEFAULT_REASON).filter(Boolean));

const DURATIONS: SelectOption<number>[] = [
  { value: 15, label: '15 minutes', description: 'A quick jab or nail trim' },
  { value: 20, label: '20 minutes', description: 'The usual consult length' },
  { value: 30, label: '30 minutes', description: 'A thorough check-up' },
  { value: 45, label: '45 minutes' },
  { value: 60, label: '1 hour', description: 'Dentals and longer procedures' },
  { value: 120, label: '2 hours', description: 'Surgery, or a day of tests' },
];

const STATUS_OPTIONS: SelectOption<AppointmentStatus>[] = [
  { value: 'scheduled', label: 'Booked', description: 'In the diary, not confirmed yet' },
  { value: 'confirmed', label: 'Confirmed', description: 'The clinic has it too' },
  { value: 'completed', label: 'Went', description: 'It happened' },
  { value: 'missed', label: 'Missed', description: 'It didn’t happen' },
  { value: 'cancelled', label: 'Cancelled', description: 'Called off' },
];

const DEFAULT_TIME: TimeOfDay = '09:00';
const DEFAULT_DURATION_MIN = 20;

/** How many previously-used clinics to offer as one-tap fills. */
const RECENT_CLINICS = 3;

const REASON_MAX = 80;
const NOTES_MAX = 500;

/* ------------------------------------------------------------------ helpers */

function denial(reason: DenialReason | null): { title: string; body: string } {
  return DENIAL_COPY[reason ?? 'not-granted'];
}

type ClinicSuggestion = {
  clinic: string;
  clinicPhone: string | null;
  clinicAddress: string | null;
  vetName: string | null;
};

/** The clinics this pet has actually been to, newest first, deduped by name. */
function recentClinics(rows: readonly Appointment[], excludeId: ID | null): ClinicSuggestion[] {
  const seen = new Set<string>();
  const out: ClinicSuggestion[] = [];

  for (const row of [...rows].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) {
    const name = row.clinic?.trim();
    if (!name || row.id === excludeId) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      clinic: name,
      clinicPhone: row.clinicPhone,
      clinicAddress: row.clinicAddress,
      vetName: row.vetName,
    });
    if (out.length >= RECENT_CLINICS) break;
  }

  return out;
}

/* ---------------------------------------------------------------- component */

export default function AppointmentFormScreen() {
  const t = useTheme();
  const router = useRouter();
  const now = useNow();
  const params = useLocalSearchParams<{ petId?: string; id?: string }>();

  const petId = params.petId ?? '';
  const appointmentId = params.id ?? null;
  const isEditing = appointmentId !== null;

  /* ---- permissions ------------------------------------------------------ */

  const capability = isEditing ? 'appointment.edit' : 'appointment.create';
  const permission = usePermission(capability, petId);
  const canSeeDocuments = usePermission('document.view', petId);
  const canSeeVaccinations = usePermission('vaccination.view', petId);

  /* ---- data ------------------------------------------------------------- */

  const petQuery = usePet(petId || null);
  const appointmentsQuery = useAppointments(petId || null);
  const documentsQuery = useDocuments(canSeeDocuments.allowed && petId ? petId : null);
  const vaccinationsQuery = useVaccinations(canSeeVaccinations.allowed && petId ? petId : null);

  const save = useSaveAppointment(petId);
  const remove = useDeleteAppointment(petId);
  const deleteSheet = useSheet();

  const pet = petQuery.data ?? null;
  const existing = useMemo(
    () => (appointmentId ? (appointmentsQuery.data ?? []).find((row) => row.id === appointmentId) ?? null : null),
    [appointmentId, appointmentsQuery.data],
  );

  /* ---- form state ------------------------------------------------------- */

  const [type, setType] = useState<AppointmentType>('checkup');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState<DateOnly | null>(null);
  const [time, setTime] = useState<TimeOfDay | null>(DEFAULT_TIME);
  const [durationMin, setDurationMin] = useState(DEFAULT_DURATION_MIN);
  const [clinic, setClinic] = useState('');
  const [clinicPhone, setClinicPhone] = useState('');
  const [clinicAddress, setClinicAddress] = useState('');
  const [vetName, setVetName] = useState('');
  const [status, setStatus] = useState<AppointmentStatus>('scheduled');
  const [notes, setNotes] = useState('');
  const [reminderOffsets, setReminderOffsets] = useState<number[]>([...DEFAULT_REMINDER_OFFSETS]);
  const [documentIds, setDocumentIds] = useState<readonly ID[]>([]);
  const [vaccinationIds, setVaccinationIds] = useState<readonly ID[]>([]);

  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);

  /** Hydrate once. A background refetch must not wipe what's being typed. */
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || !existing) return;
    hydrated.current = true;

    const at = toDate(existing.at);
    setType(existing.type);
    setReason(existing.reason);
    setDate(at ? toDateOnly(at) : null);
    setTime(at ? toTimeOfDay(at) : DEFAULT_TIME);
    setDurationMin(existing.durationMin > 0 ? existing.durationMin : DEFAULT_DURATION_MIN);
    setClinic(existing.clinic ?? '');
    setClinicPhone(existing.clinicPhone ?? '');
    setClinicAddress(existing.clinicAddress ?? '');
    setVetName(existing.vetName ?? '');
    setStatus(existing.status);
    setNotes(existing.notes ?? '');
    setReminderOffsets([...existing.reminderOffsets]);
    setDocumentIds([...existing.linkedDocumentIds]);
    setVaccinationIds([...existing.linkedVaccinationIds]);
  }, [existing]);

  /* ---- derived ---------------------------------------------------------- */

  const at = useMemo(() => (date && time ? applyTimeOfDay(date, time) : null), [date, time]);

  const countdown = useMemo(() => (at ? describeCountdown(at, now) : null), [at, now]);
  const inThePast = at !== null && at.getTime() < now.getTime();

  const suggestions = useMemo(
    () => recentClinics(appointmentsQuery.data ?? [], appointmentId),
    [appointmentId, appointmentsQuery.data],
  );

  const documents = documentsQuery.data ?? [];
  const vaccinations = vaccinationsQuery.data ?? [];
  const hasLinkables = documents.length > 0 || vaccinations.length > 0;

  const reasonError = touched && reason.trim().length === 0 ? 'What’s the visit for?' : undefined;
  const dateError = touched && !date ? 'Pick a day.' : undefined;
  const timeError = touched && !time ? 'Pick a time.' : undefined;

  const petName = pet?.name ?? 'your pet';

  /* ---- handlers --------------------------------------------------------- */

  const handleType = useCallback(
    (next: AppointmentType) => {
      setType(next);
      // Only ever overwrite a suggestion of ours, never something they wrote.
      setReason((current) =>
        current.trim().length === 0 || DEFAULT_REASONS.has(current.trim())
          ? DEFAULT_REASON[next]
          : current,
      );
    },
    [],
  );

  const applySuggestion = useCallback((suggestion: ClinicSuggestion) => {
    setClinic(suggestion.clinic);
    setClinicPhone(suggestion.clinicPhone ?? '');
    setClinicAddress(suggestion.clinicAddress ?? '');
    setVetName((current) => (current.trim().length > 0 ? current : suggestion.vetName ?? ''));
    haptics.commit();
  }, []);

  const toggleId = useCallback(
    (setter: (updater: (current: readonly ID[]) => readonly ID[]) => void, id: ID) => {
      setter((current) => (current.includes(id) ? current.filter((row) => row !== id) : [...current, id]));
    },
    [],
  );

  const handleSave = useCallback(() => {
    setTouched(true);

    if (!at || reason.trim().length === 0) {
      haptics.error();
      toast.warning('A couple of things are missing', {
        description: 'We need what the visit is for, plus a day and a time.',
      });
      return;
    }

    setSaving(true);
    void (async () => {
      try {
        await save.mutateAsync({
          id: appointmentId ?? undefined,
          at: at.toISOString(),
          durationMin,
          type,
          reason: reason.trim(),
          clinic: clinic.trim() || null,
          clinicPhone: clinicPhone.trim() || null,
          clinicAddress: clinicAddress.trim() || null,
          vetName: vetName.trim() || null,
          status,
          notes: notes.trim() || null,
          reminderOffsets: [...reminderOffsets].sort((a, b) => b - a),
          linkedDocumentIds: [...documentIds],
          linkedVaccinationIds: [...vaccinationIds],
        });

        toast.success(
          isEditing ? `${possessive(petName)} visit is updated` : `${petName} is booked in`,
          {
            description: countdown
              ? `${countdown.detail}${clinic.trim() ? ` · ${clinic.trim()}` : ''}`
              : undefined,
          },
        );
        router.back();
      } catch {
        // The mutation already raises a themed error toast; this just unsticks
        // the button and leaves everything typed exactly where it was.
        haptics.error();
      } finally {
        setSaving(false);
      }
    })();
  }, [
    appointmentId,
    at,
    clinic,
    clinicAddress,
    clinicPhone,
    countdown,
    documentIds,
    durationMin,
    isEditing,
    notes,
    petName,
    reason,
    reminderOffsets,
    router,
    save,
    status,
    type,
    vaccinationIds,
    vetName,
  ]);

  const handleDelete = useCallback(async () => {
    if (!appointmentId) return;
    await remove.mutateAsync(appointmentId);
    toast.success('Visit removed', {
      description: `It’s out of ${possessive(petName)} diary, reminders and all.`,
    });
    router.back();
  }, [appointmentId, petName, remove, router]);

  /* ---- chrome ----------------------------------------------------------- */

  const header = (
    <ScreenHeader
      title={isEditing ? 'Edit visit' : 'Book a visit'}
      subtitle={isEditing ? `${possessive(petName)} appointment` : `A trip to the vet for ${petName}`}
      leading={
        <IconButton
          icon="close"
          accessibilityLabel="Close without saving"
          variant="ghost"
          tone="neutral"
          onPress={() => router.back()}
        />
      }
    />
  );

  /* ---- states ----------------------------------------------------------- */

  if (!petId) {
    return (
      <Screen header={header} center>
        <ErrorState
          title="We’ve lost track of which pet this is for"
          body="Head back and open the booking from the pet you meant — it’ll carry the right details with it."
          onRetry={() => router.replace(toHref('/pets'))}
          retryLabel="Back to your pets"
        />
      </Screen>
    );
  }

  if (!permission.allowed) {
    return (
      <Screen header={header} center>
        <EmptyState
          tone="warning"
          illustration={<PermissionLocked size={t.spacing.colossal * 3} />}
          headline={denial(permission.reason).title}
          body={denial(permission.reason).body}
          action={{
            label: 'What can I do?',
            icon: 'help-circle-outline',
            onPress: () => permission.explain({ petName: pet?.name ?? null }),
          }}
          secondaryAction={{ label: 'Close', icon: 'close', onPress: () => router.back() }}
        />
      </Screen>
    );
  }

  if (petQuery.isPending || (isEditing && appointmentsQuery.isPending)) {
    return (
      <Screen header={header} scroll>
        <FormSkeleton />
      </Screen>
    );
  }

  if (petQuery.isError || (isEditing && appointmentsQuery.isError)) {
    return (
      <Screen header={header} center>
        <ErrorState
          error={petQuery.error ?? appointmentsQuery.error}
          title="We couldn’t open the form"
          body="Nothing is lost — the details are still on file. Try once more."
          onRetry={() => {
            void petQuery.refetch();
            void appointmentsQuery.refetch();
          }}
        />
      </Screen>
    );
  }

  if (isEditing && !existing) {
    return (
      <Screen header={header} center>
        <EmptyState
          tone="neutral"
          icon="calendar-outline"
          headline="That visit isn’t in the diary any more"
          body="It may have been removed from another device. You can book a fresh one whenever you need it."
          action={{
            label: 'Book a new visit',
            icon: 'add',
            onPress: () => router.replace(toHref(`/record/appointment?petId=${petId}`)),
          }}
          secondaryAction={{ label: 'Close', icon: 'close', onPress: () => router.back() }}
        />
      </Screen>
    );
  }

  /* ---- form ------------------------------------------------------------- */

  const enter = (index: number) =>
    t.reduceMotion
      ? FadeIn.duration(t.motion.duration.base).delay(index * t.motion.stagger.tight)
      : FadeInDown.duration(t.motion.duration.slow)
          .delay(index * t.motion.stagger.base)
          .easing(t.motion.easing.decelerate);

  return (
    <Screen
      header={header}
      scroll
      contentContainerStyle={{ gap: t.spacing.xl, paddingBottom: t.spacing.xl }}
      footer={
        <Button
          label={isEditing ? 'Save changes' : 'Book it in'}
          variant="primary"
          size="lg"
          fullWidth
          hero
          haptic="commit"
          loading={saving}
          onPress={handleSave}
          accessibilityHint={
            isEditing
              ? `Updates ${possessive(petName)} appointment.`
              : `Adds this visit to ${possessive(petName)} diary.`
          }
        />
      }
    >
      {/* ---- what for --------------------------------------------------- */}

      <Animated.View entering={enter(0)} style={{ gap: t.spacing.md }}>
        <SectionHeader
          title="What’s it for?"
          subtitle="Pick the closest kind and we’ll write the rest for you."
          icon="medkit-outline"
          iconColor="primaryText"
          first
        />

        <Row gap="sm" wrap>
          {APPOINTMENT_TYPES.map((option) => (
            <Chip
              key={option}
              label={APPOINTMENT_TYPE_META[option].label}
              emoji={APPOINTMENT_TYPE_META[option].emoji}
              selected={type === option}
              showCheck={false}
              onPress={() => handleType(option)}
              accessibilityLabel={APPOINTMENT_TYPE_META[option].label}
              accessibilityHint="Sets what kind of visit this is."
            />
          ))}
        </Row>

        <Input
          label="Reason"
          value={reason}
          onChangeText={setReason}
          placeholder="e.g. Yearly check-up and boosters"
          leadingIcon="create-outline"
          maxLength={REASON_MAX}
          required
          error={reasonError}
          helper="This is what you'll see on the card and in the reminder."
          returnKeyType="done"
        />
      </Animated.View>

      {/* ---- when ------------------------------------------------------- */}

      <Animated.View entering={enter(1)} style={{ gap: t.spacing.md }}>
        <SectionHeader
          title="When"
          subtitle={`We'll count down to it on ${possessive(petName)} appointments screen.`}
          icon="calendar-outline"
          iconColor="accentText"
        />

        <View
          style={{
            flexDirection: t.isLargeText ? 'column' : 'row',
            gap: t.spacing.md,
          }}
        >
          <View style={{ flex: t.isLargeText ? undefined : 1 }}>
            <DateField
              label="Day"
              value={date}
              onChange={setDate}
              placeholder="Pick a day"
              required
              error={dateError}
              title="Which day?"
            />
          </View>
          <View style={{ flex: t.isLargeText ? undefined : 1 }}>
            <TimeField
              label="Time"
              value={time}
              onChange={setTime}
              placeholder="Pick a time"
              minuteStep={5}
              required
              error={timeError}
              title="What time?"
            />
          </View>
        </View>

        <Select
          label="How long to set aside"
          value={durationMin}
          onChange={setDurationMin}
          options={DURATIONS}
          leadingIcon="hourglass-outline"
          title="How long?"
          subtitle="Just for your own diary — the clinic decides the real thing."
        />

        {countdown ? (
          <Animated.View entering={FadeIn.duration(t.motion.duration.fast)}>
            <Surface
              variant={inThePast ? 'surfaceAlt' : 'surface'}
              radius="lg"
              padding="md"
              border
              style={{ gap: t.spacing.xxs }}
            >
              <Row gap="sm">
                <Icon
                  name={inThePast ? 'alert-circle-outline' : 'time-outline'}
                  size="sm"
                  color={inThePast ? 'onWarningSoft' : 'primaryText'}
                />
                <Text variant="subheadStrong" style={{ flex: 1 }} numberOfLines={2}>
                  {`${countdown.detail} · ${formatDurationMinutes(durationMin)}`}
                </Text>
              </Row>
              <Text variant="footnote" color="textSecondary">
                {inThePast
                  ? 'That’s already been and gone, so no reminders will fire. Fine if you’re logging something you forgot to add.'
                  : `That’s ${countdown.lead.toLowerCase()}.`}
              </Text>
            </Surface>
          </Animated.View>
        ) : null}
      </Animated.View>

      {/* ---- where ------------------------------------------------------ */}

      <Animated.View entering={enter(2)} style={{ gap: t.spacing.md }}>
        <SectionHeader
          title="Where"
          subtitle="The number and address power the Call and Directions buttons on the card."
          icon="business-outline"
          iconColor="textTertiary"
        />

        {suggestions.length > 0 ? (
          <Column gap="sm">
            <Text variant="caption" color="textTertiary">
              Been here before?
            </Text>
            <Row gap="sm" wrap>
              {suggestions.map((suggestion) => (
                <Chip
                  key={suggestion.clinic}
                  label={suggestion.clinic}
                  icon="repeat-outline"
                  size="sm"
                  showCheck={false}
                  selected={clinic.trim().toLowerCase() === suggestion.clinic.toLowerCase()}
                  onPress={() => applySuggestion(suggestion)}
                  accessibilityLabel={`Use ${suggestion.clinic}`}
                  accessibilityHint="Fills in the clinic name, number and address."
                />
              ))}
            </Row>
          </Column>
        ) : null}

        <Input
          label="Clinic"
          value={clinic}
          onChangeText={setClinic}
          placeholder="e.g. Riverside Veterinary Centre"
          leadingIcon="business-outline"
          maxLength={80}
          clearable
        />

        <Input
          label="Vet"
          value={vetName}
          onChangeText={setVetName}
          placeholder="e.g. Dr Amara Okafor"
          leadingIcon="person-outline"
          maxLength={60}
          clearable
        />

        <Input
          label="Phone"
          value={clinicPhone}
          onChangeText={setClinicPhone}
          placeholder="e.g. 020 7946 0123"
          leadingIcon="call-outline"
          keyboardType="phone-pad"
          textContentType="telephoneNumber"
          maxLength={24}
          clearable
        />

        <Input
          label="Address"
          value={clinicAddress}
          onChangeText={setClinicAddress}
          placeholder="e.g. 12 Riverside Way, London"
          leadingIcon="location-outline"
          maxLength={120}
          clearable
        />
      </Animated.View>

      {/* ---- reminders --------------------------------------------------- */}

      <Animated.View entering={enter(3)} style={{ gap: t.spacing.md }}>
        <SectionHeader
          title="Reminders"
          subtitle="Nudges land on this phone, so they work with no signal at all."
          icon="notifications-outline"
          iconColor="accentText"
        />

        <ReminderPicker
          value={reminderOffsets}
          onChange={setReminderOffsets}
          at={at}
          petName={petName}
          reason={reason.trim() || DEFAULT_REASON[type]}
          clinic={clinic.trim() || null}
          label="Remind me"
          helper="Pick as many as you like. Here's the first one that'll arrive."
        />
      </Animated.View>

      {/* ---- linked records ---------------------------------------------- */}

      <Animated.View entering={enter(4)} style={{ gap: t.spacing.md }}>
        <SectionHeader
          title="Keep it with"
          subtitle="Anything you attach shows on the visit card and rides along into the write-up."
          icon="link-outline"
          iconColor="primaryText"
        />

        {hasLinkables ? (
          <Column gap="base">
            {vaccinations.length > 0 ? (
              <Column gap="sm">
                <Text variant="caption" color="textTertiary">
                  Vaccinations
                </Text>
                <Row gap="sm" wrap>
                  {vaccinations.map((vaccination) => (
                    <Chip
                      key={vaccination.id}
                      label={vaccination.name}
                      icon="shield-checkmark-outline"
                      size="sm"
                      selected={vaccinationIds.includes(vaccination.id)}
                      onPress={() => toggleId(setVaccinationIds, vaccination.id)}
                      accessibilityHint={
                        vaccinationIds.includes(vaccination.id)
                          ? 'Unlinks this vaccination from the visit.'
                          : 'Links this vaccination so you can tick it off afterwards.'
                      }
                    />
                  ))}
                </Row>
              </Column>
            ) : null}

            {documents.length > 0 ? (
              <Column gap="sm">
                <Text variant="caption" color="textTertiary">
                  Documents
                </Text>
                <Row gap="sm" wrap>
                  {documents.map((document) => (
                    <Chip
                      key={document.id}
                      label={document.title}
                      icon="document-text-outline"
                      size="sm"
                      selected={documentIds.includes(document.id)}
                      onPress={() => toggleId(setDocumentIds, document.id)}
                      accessibilityHint={
                        documentIds.includes(document.id)
                          ? 'Unlinks this document from the visit.'
                          : 'Links this document so it’s one tap away at the clinic.'
                      }
                    />
                  ))}
                </Row>
              </Column>
            ) : null}
          </Column>
        ) : (
          <Surface variant="surfaceAlt" radius="lg" padding="md" border>
            <Row gap="sm" align="start">
              <Icon name="folder-open-outline" size="sm" color="textTertiary" />
              <Text variant="footnote" color="textSecondary" style={{ flex: 1 }}>
                {canSeeDocuments.allowed || canSeeVaccinations.allowed
                  ? `Nothing to attach yet. Once ${petName} has vaccinations or documents on file, you can pin them to a visit from here.`
                  : `Attaching records isn’t part of your access for ${petName} — the owner can add it if it would help.`}
              </Text>
            </Row>
          </Surface>
        )}
      </Animated.View>

      {/* ---- notes and status -------------------------------------------- */}

      <Animated.View entering={enter(5)} style={{ gap: t.spacing.md }}>
        <SectionHeader
          title="Anything else"
          subtitle="Questions to ask, symptoms to mention, the thing you always forget."
          icon="document-text-outline"
          iconColor="textTertiary"
        />

        <TextArea
          label="Notes"
          value={notes}
          onChangeText={setNotes}
          placeholder={`e.g. "Ask about the limp after long walks"`}
          minRows={3}
          maxRows={8}
          maxLength={NOTES_MAX}
        />

        {isEditing ? (
          <Select
            label="Where this visit stands"
            value={status}
            onChange={setStatus}
            options={STATUS_OPTIONS}
            leadingIcon={APPOINTMENT_STATUS_META[status].icon}
            title="Status"
            subtitle="Marking it as Went will offer you the write-up afterwards."
          />
        ) : null}
      </Animated.View>

      {/* ---- remove ------------------------------------------------------- */}

      {isEditing ? (
        <Animated.View entering={enter(6)}>
          <Surface variant="surface" elevation={0} radius="xl" paddingX="base" border>
            <ListRow
              icon="trash-outline"
              destructive
              title="Remove this visit"
              subtitle="Takes it out of the diary and cancels its reminders"
              chevron={false}
              onPress={() => deleteSheet.open()}
            />
          </Surface>
        </Animated.View>
      ) : null}

      <ConfirmSheet
        controller={deleteSheet}
        title="Remove this visit?"
        body={`${reason.trim() || 'This appointment'} will disappear from ${possessive(petName)} diary, along with any reminders you set for it.`}
        confirmLabel="Yes, remove it"
        cancelLabel="Keep it"
        icon="trash-outline"
        onConfirm={handleDelete}
      />
    </Screen>
  );
}

/* ------------------------------------------------------------- skeleton */

/** Section headings and field frames, at the heights the real form uses. */
function FormSkeleton() {
  const t = useTheme();
  const field = t.minTarget + t.spacing.md;

  return (
    <SkeletonGroup label="Opening the booking form" gap="xl">
      {[0, 1, 2].map((section) => (
        <View key={section} style={{ gap: t.spacing.md }}>
          <View style={{ gap: t.spacing.xs }}>
            <Skeleton w="42%" h={t.type.title3.fontSize} r="xs" />
            <Skeleton w="76%" h={t.type.footnote.fontSize} r="xs" dim />
          </View>
          <Skeleton w="100%" h={field} r="lg" />
          <Skeleton w="100%" h={field} r="lg" />
        </View>
      ))}
    </SkeletonGroup>
  );
}
