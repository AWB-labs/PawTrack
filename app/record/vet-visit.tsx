/**
 * Write up a vet visit.
 *
 * This is the longest form in Petal, and the only one that earns its length: it
 * is filled in once, in the car park, and read years later by someone trying to
 * remember what the lump turned out to be.
 *
 * So it is paced rather than stacked. The type of visit is a row of glyphs you
 * tap, not a dropdown. What the vet *said* gets its own section away from the
 * admin. Money and weight sit together because they're the two numbers people
 * copy off the invoice. And the weight can go straight onto the growth chart
 * with one switch, because typing it twice is exactly the friction that stops
 * people recording it at all.
 *
 * `vetvisit.edit` is grantable, so a sitter with vet-trip access can write up
 * the visit they drove to — which is the whole point of that preset.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeInDown, LinearTransition } from 'react-native-reanimated';

import {
  useAddWeight,
  useDeleteVetVisit,
  useDocuments,
  useSaveVetVisit,
  useVetVisits,
} from '@/data/queries/useHealth';
import { usePet } from '@/data/queries/usePets';
import type { DateOnly, PetDocument, TimeOfDay, VetVisitType } from '@/data/types';
import { describeDocument, DocumentThumbnail } from '@/features/health/DocumentTile';
import { VET_VISIT_TYPE_META, VET_VISIT_TYPES } from '@/features/health/VetVisitCard';
import { applyTimeOfDay, toDateOnly, toTimeOfDay } from '@/lib/date';
import { toHref } from '@/lib/deeplinks';
import {
  currencyDecimals,
  formatCurrency,
  formatWeight,
  fromDisplayWeight,
  plural,
  possessive,
  toDisplayWeight,
  weightUnitLabel,
} from '@/lib/format';
import haptics from '@/lib/haptics';
import { DENIAL_COPY, type DenialReason } from '@/rbac/permissions';
import { useNow, usePermission } from '@/rbac/usePermission';
import { usePreferences } from '@/stores/preferences';
import { useTheme } from '@/theme';
import {
  Button,
  Checkbox,
  Chip,
  Column,
  ConfirmSheet,
  DateField,
  EmptyState,
  Icon,
  IconButton,
  Input,
  ListRow,
  Row,
  Screen,
  ScreenHeader,
  SectionHeader,
  Select,
  Sheet,
  Surface,
  Switch,
  Text,
  TextArea,
  TimeField,
  toast,
  useSheet,
  type SelectOption,
} from '@/ui';
import { PermissionLocked } from '@/ui/illustrations';
import { SkeletonGroup } from '@/ui/Skeleton';
import { ListRowSkeleton } from '@/ui/skeletons/ContentSkeletons';

/* -------------------------------------------------------------------- types */

type Draft = {
  type: VetVisitType;
  reason: string;
  day: DateOnly;
  time: TimeOfDay;
  vetName: string;
  clinic: string;
  diagnosis: string;
  treatment: string;
  weightText: string;
  costText: string;
  currency: string;
  followUpAt: DateOnly | null;
  notes: string;
  documentIds: string[];
};

/* ---------------------------------------------------------------- constants */

const REASON_MAX = 80;
const FIELD_MAX = 60;
const LONG_MAX = 600;
const NOTES_MAX = 400;

/** Sensible when there's nothing to copy from a previous visit. */
const FALLBACK_CURRENCY = 'GBP';

/** Nothing that lives in a house weighs this much — catches a stuck key. */
const MAX_KG = 500;

const CURRENCIES: SelectOption<string>[] = [
  { value: 'GBP', label: 'British pound', description: '£ · GBP' },
  { value: 'USD', label: 'US dollar', description: '$ · USD' },
  { value: 'EUR', label: 'Euro', description: '€ · EUR' },
  { value: 'CAD', label: 'Canadian dollar', description: 'CA$ · CAD' },
  { value: 'AUD', label: 'Australian dollar', description: 'A$ · AUD' },
  { value: 'NZD', label: 'New Zealand dollar', description: 'NZ$ · NZD' },
  { value: 'INR', label: 'Indian rupee', description: '₹ · INR' },
  { value: 'JPY', label: 'Japanese yen', description: '¥ · JPY' },
  { value: 'SEK', label: 'Swedish krona', description: 'kr · SEK' },
  { value: 'ZAR', label: 'South African rand', description: 'R · ZAR' },
];

/* ------------------------------------------------------------------ helpers */

function denial(reason: DenialReason | null): { title: string; body: string } {
  return DENIAL_COPY[reason ?? 'not-granted'];
}

const blank = (value: string): string | null => (value.trim().length > 0 ? value.trim() : null);

/** Accepts "48", "48.50" and "48,50" — people type all three. */
function parseAmount(value: string): number | null {
  const raw = value.trim().replace(',', '.');
  if (raw.length === 0) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.NaN;
}

/* ------------------------------------------------------------------- route */

export default function RecordVetVisitScreen() {
  const t = useTheme();
  const router = useRouter();
  const now = useNow();
  const unit = usePreferences((s) => s.weightUnit);
  const { petId, id } = useLocalSearchParams<{ petId?: string; id?: string }>();
  const resolvedPetId = petId ?? '';

  const petQuery = usePet(resolvedPetId);
  const pet = petQuery.data ?? null;
  const canEdit = usePermission('vetvisit.edit', resolvedPetId);
  const visitsQuery = useVetVisits(canEdit.allowed ? resolvedPetId : null);

  const visits = useMemo(() => visitsQuery.data ?? [], [visitsQuery.data]);
  const existing = useMemo(
    () => (id ? (visits.find((row) => row.id === id) ?? null) : null),
    [id, visits],
  );

  /** Households mostly pay in one currency; the last visit is the best guess. */
  const lastCurrency = useMemo(() => {
    const withCost = visits.filter((visit) => visit.costMinor !== null);
    return withCost[0]?.currency ?? FALLBACK_CURRENCY;
  }, [visits]);

  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace(toHref(`/pet/${resolvedPetId}/vet-visits`));
  }, [resolvedPetId, router]);

  const header = (
    <ScreenHeader
      title={id ? 'Edit visit' : 'Write up a visit'}
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
          headline="Writing up visits isn’t part of your access"
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

  if (id && visitsQuery.isPending) {
    return (
      <Screen header={header} scroll>
        <SkeletonGroup label="Loading this visit" gap="xl">
          <ListRowSkeleton count={5} avatar={false} />
        </SkeletonGroup>
      </Screen>
    );
  }

  const existingWeightKg = existing?.weightKg ?? null;

  return (
    <VetVisitForm
      petId={resolvedPetId}
      petName={pet?.name ?? null}
      existingId={existing?.id ?? null}
      initial={{
        type: existing?.type ?? 'checkup',
        reason: existing?.reason ?? '',
        day: toDateOnly(existing?.at ?? now),
        time: toTimeOfDay(existing?.at ?? now),
        vetName: existing?.vetName ?? '',
        clinic: existing?.clinic ?? '',
        diagnosis: existing?.diagnosis ?? '',
        treatment: existing?.treatment ?? '',
        weightText:
          existingWeightKg === null
            ? ''
            : String(Number(toDisplayWeight(existingWeightKg, unit).toFixed(2))),
        costText:
          existing?.costMinor === null || existing?.costMinor === undefined
            ? ''
            : String(existing.costMinor / 10 ** currencyDecimals(existing.currency)),
        currency: existing?.currency ?? lastCurrency,
        followUpAt: existing?.followUpAt ?? null,
        notes: existing?.notes ?? '',
        documentIds: existing ? [...existing.documentIds] : [],
      }}
      onClose={close}
    />
  );
}

/* -------------------------------------------------------------------- form */

type VetVisitFormProps = {
  petId: string;
  petName: string | null;
  existingId: string | null;
  initial: Draft;
  onClose: () => void;
};

function VetVisitForm({ petId, petName, existingId, initial, onClose }: VetVisitFormProps) {
  const t = useTheme();
  const router = useRouter();
  const now = useNow();
  const unit = usePreferences((s) => s.weightUnit);

  const save = useSaveVetVisit(petId);
  const remove = useDeleteVetVisit(petId);
  const addWeight = useAddWeight(petId);

  const canLogWeight = usePermission('weight.log', petId);
  const canSeeDocuments = usePermission('document.view', petId);
  const documentsQuery = useDocuments(canSeeDocuments.allowed ? petId : null);

  const attachSheet = useSheet();
  const deleteSheet = useSheet();

  const [draft, setDraft] = useState<Draft>(initial);
  const [reasonTouched, setReasonTouched] = useState(false);
  const [alsoLogWeight, setAlsoLogWeight] = useState(existingId === null);
  const [saving, setSaving] = useState(false);

  const patch = useCallback((next: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...next })), []);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial]);

  /* ---- validation ------------------------------------------------------- */

  const trimmedReason = draft.reason.trim();
  const reasonError =
    reasonTouched && trimmedReason.length === 0
      ? 'A line about why you went is what makes this findable later.'
      : undefined;

  const weightValue = parseAmount(draft.weightText);
  const weightKg = useMemo(() => {
    if (weightValue === null) return null;
    if (Number.isNaN(weightValue) || weightValue <= 0) return Number.NaN;
    const kg = fromDisplayWeight(weightValue, unit);
    return kg > MAX_KG ? Number.NaN : kg;
  }, [unit, weightValue]);

  const weightError =
    weightKg !== null && Number.isNaN(weightKg)
      ? `That doesn’t look like a weight in ${weightUnitLabel(unit)}.`
      : undefined;

  const costValue = parseAmount(draft.costText);
  const costMinor = useMemo(() => {
    if (costValue === null) return null;
    if (Number.isNaN(costValue)) return Number.NaN;
    return Math.round(costValue * 10 ** currencyDecimals(draft.currency));
  }, [costValue, draft.currency]);

  const costError =
    costMinor !== null && Number.isNaN(costMinor) ? 'That doesn’t look like an amount.' : undefined;

  const valid =
    trimmedReason.length > 0 && weightError === undefined && costError === undefined;

  /* ---- derived ---------------------------------------------------------- */

  const documents = useMemo(() => documentsQuery.data ?? [], [documentsQuery.data]);
  const attached = useMemo(
    () =>
      draft.documentIds
        .map((docId) => documents.find((document) => document.id === docId))
        .filter((document): document is PetDocument => document !== undefined),
    [documents, draft.documentIds],
  );

  const at = useMemo(
    () => (applyTimeOfDay(draft.day, draft.time) ?? new Date()).toISOString(),
    [draft.day, draft.time],
  );

  const costPreview =
    costMinor !== null && !Number.isNaN(costMinor)
      ? formatCurrency(costMinor, draft.currency)
      : null;

  /* ---- actions ---------------------------------------------------------- */

  const toggleDocument = useCallback((documentId: string) => {
    haptics.tap();
    setDraft((prev) => ({
      ...prev,
      documentIds: prev.documentIds.includes(documentId)
        ? prev.documentIds.filter((value) => value !== documentId)
        : [...prev.documentIds, documentId],
    }));
  }, []);

  const submit = useCallback(async () => {
    if (trimmedReason.length === 0) {
      setReasonTouched(true);
      haptics.warn();
      return;
    }
    if (!valid || saving) {
      haptics.warn();
      return;
    }

    setSaving(true);
    try {
      const saved = await save.mutateAsync({
        id: existingId ?? undefined,
        at,
        type: draft.type,
        reason: trimmedReason,
        vetName: blank(draft.vetName),
        clinic: blank(draft.clinic),
        diagnosis: blank(draft.diagnosis),
        treatment: blank(draft.treatment),
        weightKg: weightKg !== null && !Number.isNaN(weightKg) ? weightKg : null,
        costMinor: costMinor !== null && !Number.isNaN(costMinor) ? costMinor : null,
        currency: draft.currency,
        followUpAt: draft.followUpAt,
        notes: blank(draft.notes),
        documentIds: draft.documentIds,
      });

      // A clinic weight is the most accurate one anybody gets all year — worth
      // one extra call to keep the growth chart honest.
      if (alsoLogWeight && canLogWeight.allowed && weightKg !== null && !Number.isNaN(weightKg)) {
        await addWeight.mutateAsync({
          kg: weightKg,
          recordedAt: at,
          note: `Weighed at ${blank(draft.clinic) ?? 'the vet'}`,
        });
      }

      haptics.success();
      toast.success(existingId ? 'Visit updated' : 'Visit written up', {
        description: costPreview
          ? `${saved.reason} · ${costPreview}`
          : `${saved.reason} — safely on ${possessive(petName ?? 'your pet')} record.`,
      });
      onClose();
    } catch {
      // The mutation hooks already raise the explanatory toast; this only stops
      // an unhandled rejection escaping a fire-and-forget press handler.
    } finally {
      setSaving(false);
    }
  }, [
    addWeight,
    alsoLogWeight,
    at,
    canLogWeight.allowed,
    costMinor,
    costPreview,
    draft,
    existingId,
    onClose,
    petName,
    save,
    saving,
    trimmedReason,
    valid,
    weightKg,
  ]);

  const enter = useCallback(
    (index: number) =>
      t.reduceMotion
        ? FadeIn.duration(t.motion.duration.base).delay(index * t.motion.stagger.tight)
        : FadeInDown.duration(t.motion.duration.slow)
            .delay(index * t.motion.stagger.base)
            .easing(t.motion.easing.decelerate),
    [t.motion, t.reduceMotion],
  );

  const name = petName ?? 'your pet';

  /* ---- chrome ----------------------------------------------------------- */

  const header = (
    <ScreenHeader
      title={existingId ? 'Edit visit' : 'Write up a visit'}
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
          onPress={() => void submit()}
          variant="primary"
          size="sm"
          disabled={!dirty || !valid}
          loading={saving}
          haptic="none"
          accessibilityHint={dirty ? 'Saves this write-up.' : 'Nothing has changed yet.'}
        />
      }
    />
  );

  return (
    <Screen
      header={header}
      scroll
      contentContainerStyle={{ gap: t.spacing.xl, paddingBottom: t.spacing.xl }}
      footer={
        <Button
          label={existingId ? 'Save the changes' : 'Save the write-up'}
          onPress={() => void submit()}
          variant="primary"
          size="lg"
          fullWidth
          hero
          leftIcon="checkmark"
          disabled={!dirty || !valid}
          loading={saving}
          haptic="none"
        />
      }
    >
      {/* ---- what ---------------------------------------------------------- */}
      <Animated.View entering={enter(0)} style={{ gap: t.spacing.md }}>
        <SectionHeader
          title="What was it for?"
          subtitle="Pick the kind of visit — it colours the card and groups the history."
          icon="medkit-outline"
          iconColor="primaryText"
          first
        />

        <Row gap="sm" wrap>
          {VET_VISIT_TYPES.map((type) => {
            const meta = VET_VISIT_TYPE_META[type];
            return (
              <Chip
                key={type}
                label={meta.label}
                icon={meta.icon}
                size="sm"
                selected={draft.type === type}
                onPress={() => patch({ type })}
                accessibilityLabel={`${meta.label} visit`}
              />
            );
          })}
        </Row>

        <Surface variant="surface" elevation={1} radius="xl" padding="base">
          <Input
            label="Reason for the visit"
            value={draft.reason}
            onChangeText={(value) => patch({ reason: value })}
            onBlur={() => setReasonTouched(true)}
            error={reasonError}
            placeholder="Limping on the back left leg"
            helper="How you'd describe it to a friend."
            leadingIcon="help-buoy-outline"
            maxLength={REASON_MAX}
            autoCapitalize="sentences"
            required
            clearable
          />
        </Surface>
      </Animated.View>

      {/* ---- when ---------------------------------------------------------- */}
      <Animated.View entering={enter(1)} style={{ gap: t.spacing.md }}>
        <SectionHeader
          title="When"
          subtitle="Defaults to right now, so a write-up in the car park is two taps."
          icon="time-outline"
          iconColor="accentText"
        />
        <Surface variant="surface" elevation={1} radius="xl" padding="base" style={{ gap: t.spacing.lg }}>
          <DateField
            label="Date"
            value={draft.day}
            onChange={(value) => patch({ day: value ?? toDateOnly(now) })}
            maxDate={toDateOnly(now)}
            title="When was the visit?"
          />
          <TimeField
            label="Time"
            value={draft.time}
            onChange={(value) => patch({ time: value })}
            title="What time?"
          />
        </Surface>
      </Animated.View>

      {/* ---- who ----------------------------------------------------------- */}
      <Animated.View entering={enter(2)} style={{ gap: t.spacing.md }}>
        <SectionHeader
          title="Where and who"
          subtitle="So a locum or an out-of-hours vet can pick up the thread."
          icon="business-outline"
          iconColor="textTertiary"
        />
        <Surface variant="surface" elevation={1} radius="xl" padding="base" style={{ gap: t.spacing.lg }}>
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
            label="Vet"
            value={draft.vetName}
            onChangeText={(value) => patch({ vetName: value })}
            placeholder="Dr Amara Chen"
            leadingIcon="person-outline"
            maxLength={FIELD_MAX}
            autoCapitalize="words"
            clearable
          />
        </Surface>
      </Animated.View>

      {/* ---- outcome -------------------------------------------------------- */}
      <Animated.View entering={enter(3)} style={{ gap: t.spacing.md }}>
        <SectionHeader
          title="What the vet said"
          subtitle="Write it while it's fresh. In a year this is the only record of it."
          icon="chatbubbles-outline"
          iconColor="primaryText"
        />
        <Surface variant="surface" elevation={1} radius="xl" padding="base" style={{ gap: t.spacing.lg }}>
          <TextArea
            label="Diagnosis"
            value={draft.diagnosis}
            onChangeText={(value) => patch({ diagnosis: value })}
            placeholder="Mild soft-tissue strain — no fracture on the x-ray."
            maxLength={LONG_MAX}
            minRows={2}
            maxRows={6}
          />
          <TextArea
            label="Treatment"
            value={draft.treatment}
            onChangeText={(value) => patch({ treatment: value })}
            placeholder="Five days of anti-inflammatories, lead walks only for a fortnight."
            maxLength={LONG_MAX}
            minRows={2}
            maxRows={6}
          />
        </Surface>
      </Animated.View>

      {/* ---- numbers -------------------------------------------------------- */}
      <Animated.View entering={enter(4)} style={{ gap: t.spacing.md }}>
        <SectionHeader
          title="The numbers"
          subtitle="The two things people copy off the invoice on the way home."
          icon="calculator-outline"
          iconColor="accentText"
        />
        <Surface variant="surface" elevation={1} radius="xl" padding="base" style={{ gap: t.spacing.lg }}>
          <Input
            label={`Weight at the clinic (${weightUnitLabel(unit)})`}
            value={draft.weightText}
            onChangeText={(value) => patch({ weightText: value })}
            error={weightError}
            placeholder={unit === 'lb' ? '18.4' : '8.4'}
            helper="Clinic scales are the most accurate reading anyone gets all year."
            leadingIcon="fitness-outline"
            keyboardType="decimal-pad"
            clearable
          />

          <Animated.View layout={LinearTransition.duration(t.motion.duration.base)}>
            {weightKg !== null && !Number.isNaN(weightKg) && canLogWeight.allowed ? (
              <Switch
                value={alsoLogWeight}
                onValueChange={setAlsoLogWeight}
                label="Add it to the weight chart too"
                description={`Records ${formatWeight(weightKg, { unit })} for ${name} on the day of the visit.`}
              />
            ) : null}
          </Animated.View>

          <Row gap="md" align="start">
            <Input
              label="Cost"
              value={draft.costText}
              onChangeText={(value) => patch({ costText: value })}
              error={costError}
              placeholder="48.50"
              leadingIcon="wallet-outline"
              keyboardType="decimal-pad"
              clearable
              style={{ flex: 2 }}
            />
            <Select
              label="Currency"
              value={draft.currency}
              onChange={(value) => patch({ currency: value })}
              options={CURRENCIES}
              title="Which currency?"
              searchPlaceholder="Search currencies"
              style={{ flex: 3 }}
            />
          </Row>

          {costPreview ? (
            <Row gap="xs">
              <Icon name="checkmark-circle-outline" size="xs" color="onSuccessSoft" />
              <Text variant="caption" color="textSecondary" tabular>
                {`Recorded as ${costPreview}`}
              </Text>
            </Row>
          ) : null}

          <DateField
            label="Follow-up"
            value={draft.followUpAt}
            onChange={(value) => patch({ followUpAt: value })}
            minDate={draft.day}
            title="When’s the recheck?"
            placeholder="No follow-up needed"
            helper="Shows on the card so it can’t quietly slip."
            clearable
          />
        </Surface>
      </Animated.View>

      {/* ---- paperwork ------------------------------------------------------ */}
      <Animated.View entering={enter(5)} style={{ gap: t.spacing.md }}>
        <SectionHeader
          title="Paperwork"
          subtitle="Link the invoice, the x-ray, the discharge notes."
          icon="document-attach-outline"
          iconColor="textTertiary"
          actionLabel={documents.length > 0 ? 'Choose files' : undefined}
          onAction={documents.length > 0 ? () => attachSheet.open() : undefined}
          actionIcon="attach-outline"
        />
        <Surface variant="surface" elevation={1} radius="xl" padding="base" style={{ gap: t.spacing.md }}>
          {attached.length > 0 ? (
            <Row gap="sm" wrap>
              {attached.map((document) => (
                <Column key={document.id} gap="xxs" style={{ width: t.spacing.giant }}>
                  <DocumentThumbnail document={document} size={t.spacing.giant} />
                  <Text variant="caption" color="textTertiary" numberOfLines={2}>
                    {document.title}
                  </Text>
                </Column>
              ))}
            </Row>
          ) : (
            <Text variant="footnote" color="textTertiary">
              {documents.length > 0
                ? 'Nothing linked yet.'
                : `No files in ${possessive(name)} library yet — add one from the Documents screen and it'll show up here.`}
            </Text>
          )}

          <Button
            label={attached.length > 0 ? `Change (${plural(attached.length, 'file')})` : 'Attach a file'}
            onPress={() =>
              documents.length > 0 ? attachSheet.open() : router.push(toHref(`/pet/${petId}/documents`))
            }
            variant="tonal"
            size="sm"
            leftIcon="attach-outline"
            accessibilityHint={
              documents.length > 0
                ? 'Choose which files belong to this visit.'
                : 'Opens the document library.'
            }
          />
        </Surface>
      </Animated.View>

      {/* ---- notes ---------------------------------------------------------- */}
      <Animated.View entering={enter(6)} style={{ gap: t.spacing.md }}>
        <SectionHeader
          title="Anything else"
          subtitle="How they coped, what to watch for, what to ask next time."
          icon="create-outline"
          iconColor="textTertiary"
        />
        <Surface variant="surface" elevation={1} radius="xl" padding="base">
          <TextArea
            label="Notes"
            value={draft.notes}
            onChangeText={(value) => patch({ notes: value })}
            placeholder="Hated the waiting room, was an angel once inside. Ask about the diet next visit."
            maxLength={NOTES_MAX}
            minRows={3}
            maxRows={6}
          />
        </Surface>
      </Animated.View>

      {existingId ? (
        <Animated.View entering={enter(7)}>
          <Button
            label="Remove this write-up"
            onPress={() => deleteSheet.open()}
            variant="ghost"
            size="md"
            fullWidth
            leftIcon="trash-outline"
            accessibilityHint="Asks before deleting."
          />
        </Animated.View>
      ) : null}

      {/* ---- attach sheet --------------------------------------------------- */}
      <Sheet
        controller={attachSheet}
        title="Attach paperwork"
        subtitle={`Anything in ${possessive(name)} library can be linked here.`}
        size="half"
        scrollable
      >
        <Column gap="xxs">
          {documents.map((document) => {
            const checked = draft.documentIds.includes(document.id);
            return (
              <ListRow
                key={document.id}
                leading={<DocumentThumbnail document={document} size={t.spacing.xxxl} />}
                title={document.title}
                subtitle={describeDocument(document)}
                selected={checked}
                onPress={() => toggleDocument(document.id)}
                trailing={
                  <Checkbox
                    checked={checked}
                    onChange={() => toggleDocument(document.id)}
                    accessibilityLabel={`Attach ${document.title}`}
                  />
                }
              />
            );
          })}
        </Column>
        <View style={{ paddingTop: t.spacing.base }}>
          <Button label="Done" onPress={() => attachSheet.close()} variant="secondary" size="md" fullWidth />
        </View>
      </Sheet>

      <ConfirmSheet
        controller={deleteSheet}
        title="Remove this write-up?"
        body={`The diagnosis, the treatment and the cost go with it. Anything you attached stays in ${possessive(name)} library.`}
        confirmLabel="Remove it"
        cancelLabel="Keep it"
        icon="trash-outline"
        onConfirm={async () => {
          if (!existingId) return;
          await remove.mutateAsync(existingId);
          toast.success('Write-up removed');
          onClose();
        }}
      />
    </Screen>
  );
}
