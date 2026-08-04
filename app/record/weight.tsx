/**
 * Record a weight.
 *
 * The one form in Petal with no text box in it. Weighing a pet is a two-second
 * job done one-handed, usually crouched over a bathroom scale with an animal
 * trying to get off it — so the number is entered on a big keypad with the
 * readout at eye level, and the software keyboard never appears.
 *
 * What the screen is really doing while you type:
 *
 *   · **Answering "is that right?" before you commit.** The delta against the
 *     last weigh-in updates on every keystroke, and the sparkline draws the new
 *     point onto the existing trend. A typo of 45 instead of 4.5 is obvious at a
 *     glance rather than a fortnight later.
 *   · **Speaking the user's unit and storing kilograms.** The pad is in whatever
 *     they read; `lib/format` converts once, at the boundary.
 *   · **Celebrating only when it means something.** Landing inside the vet's
 *     target band after being outside it is a genuine reward and gets confetti.
 *     Everything else gets a success tick, because a routine weigh-in that
 *     throws paper reads as a slot machine.
 *
 * Editing works by adding the corrected reading and removing the old one — the
 * data layer has no update for a weigh-in, and inventing one in the UI would
 * mean two ways to be wrong about the pet's current weight.
 */

import { subDays } from 'date-fns';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Animated, {
  FadeIn,
  FadeInDown,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { useAddWeight, useDeleteWeight, useWeights } from '@/data/queries/useHealth';
import { usePet } from '@/data/queries/usePets';
import type { DateOnly } from '@/data/types';
import { fromDateOnly, isSameLocalDay, toDateOnly } from '@/lib/date';
import { toHref } from '@/lib/deeplinks';
import {
  formatWeight,
  formatWeightDelta,
  fromDisplayWeight,
  possessive,
  toDisplayWeight,
  weightUnitLabel,
} from '@/lib/format';
import haptics from '@/lib/haptics';
import { DENIAL_COPY, type DenialReason } from '@/rbac/permissions';
import { usePermission } from '@/rbac/usePermission';
import { usePreferences } from '@/stores/preferences';
import { useTheme } from '@/theme';
import {
  Button,
  Chip,
  confetti,
  DateField,
  EmptyState,
  Icon,
  IconButton,
  Row,
  Screen,
  ScreenHeader,
  SectionHeader,
  Sparkline,
  Surface,
  Text,
  TextArea,
  toast,
  Touchable,
  type IconName,
} from '@/ui';
import { PermissionLocked } from '@/ui/illustrations';

/* -------------------------------------------------------------------- types */

type PadKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '.' | 'delete';

/* ---------------------------------------------------------------- constants */

/** Keypad layout, read left-to-right, top-to-bottom. */
const PAD_KEYS: readonly PadKey[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'delete'];

/** Nothing on earth that lives in a house weighs this much. Catches a stuck key. */
const MAX_KG = 500;

/** Two decimals is a kitchen scale; three is a lie about precision. */
const MAX_DECIMALS = 2;

/** A back-dated reading gets midday rather than midnight — it reads as "that day". */
const BACKDATE_HOUR = 12;

/** Matches `WeightSummary`'s band: a vet's "around 8kg" is not 8.00kg. */
const TARGET_TOLERANCE = 0.04;

const NOTE_MAX = 160;

/* ------------------------------------------------------------------ helpers */

function denial(reason: DenialReason | null): { title: string; body: string } {
  return DENIAL_COPY[reason ?? 'not-granted'];
}

/** Apply one key press to the raw entry string. Returns null when it's a no-op. */
function applyKey(current: string, key: PadKey): string | null {
  if (key === 'delete') return current.length === 0 ? null : current.slice(0, -1);

  if (key === '.') {
    if (current.includes('.')) return null;
    return current.length === 0 ? '0.' : `${current}.`;
  }

  const [whole = '', decimals] = current.split('.');
  if (decimals !== undefined && decimals.length >= MAX_DECIMALS) return null;
  if (decimals === undefined && whole.length >= 4) return null;
  // A leading zero is only meaningful in front of a decimal point.
  if (current === '0') return key === '0' ? null : key;
  return `${current}${key}`;
}

/* ------------------------------------------------------------------- route */

export default function RecordWeightScreen() {
  const t = useTheme();
  const router = useRouter();
  const { petId, id } = useLocalSearchParams<{ petId?: string; id?: string }>();
  const resolvedPetId = petId ?? '';

  const petQuery = usePet(resolvedPetId);
  const pet = petQuery.data ?? null;
  const canLog = usePermission('weight.log', resolvedPetId);
  const canView = usePermission('weight.view', resolvedPetId);

  if (!canLog.allowed) {
    return (
      <Screen
        header={
          <ScreenHeader
            title="Record a weight"
            large={false}
            showBack={false}
            leading={
              <IconButton
                icon="close"
                accessibilityLabel="Close"
                accessibilityHint="Closes this form."
                variant="ghost"
                tone="neutral"
                onPress={() => router.back()}
              />
            }
          />
        }
        center
      >
        <EmptyState
          tone="warning"
          illustration={<PermissionLocked size={t.spacing.colossal * 3} />}
          headline="Recording weight isn’t part of your access"
          body={denial(canLog.reason).body}
          action={{
            label: 'Back',
            icon: 'arrow-back',
            onPress: () =>
              router.canGoBack() ? router.back() : router.replace(toHref(`/pet/${resolvedPetId}`)),
          }}
          secondaryAction={{
            label: 'Why can’t I do this?',
            icon: 'help-circle-outline',
            onPress: () => canLog.explain({ petName: pet?.name ?? null }),
          }}
        />
      </Screen>
    );
  }

  return <WeightForm petId={resolvedPetId} entryId={id ?? null} canSeeHistory={canView.allowed} />;
}

/* -------------------------------------------------------------------- form */

type WeightFormProps = {
  petId: string;
  entryId: string | null;
  canSeeHistory: boolean;
};

function WeightForm({ petId, entryId, canSeeHistory }: WeightFormProps) {
  const t = useTheme();
  const router = useRouter();
  const unit = usePreferences((s) => s.weightUnit);

  const petQuery = usePet(petId);
  const pet = petQuery.data ?? null;
  const weightsQuery = useWeights(canSeeHistory ? petId : null);
  const addWeight = useAddWeight(petId);
  const deleteWeight = useDeleteWeight(petId);

  const entries = useMemo(() => weightsQuery.data ?? [], [weightsQuery.data]);
  const editing = useMemo(
    () => (entryId ? (entries.find((entry) => entry.id === entryId) ?? null) : null),
    [entries, entryId],
  );

  /** The reading this one is measured against — the newest that isn't us. */
  const reference = useMemo(() => {
    const others = entries.filter((entry) => entry.id !== entryId);
    return others.length > 0 ? (others[others.length - 1] ?? null) : null;
  }, [entries, entryId]);

  /* ---- draft ------------------------------------------------------------ */

  const [text, setText] = useState('');
  const [day, setDay] = useState<DateOnly>(() => toDateOnly(new Date()));
  const [note, setNote] = useState('');
  const [seeded, setSeeded] = useState(false);

  // Seeded once the row arrives, and only once — re-seeding on every refetch is
  // how "my edits vanished" bugs happen.
  useEffect(() => {
    if (seeded || !editing) return;
    const shown = toDisplayWeight(editing.kg, unit);
    setText(String(Number(shown.toFixed(MAX_DECIMALS))));
    setDay(toDateOnly(editing.recordedAt));
    setNote(editing.note ?? '');
    setSeeded(true);
  }, [editing, seeded, unit]);

  const parsed = text.length === 0 ? Number.NaN : Number(text);
  const displayValid = Number.isFinite(parsed) && parsed > 0;
  const kg = displayValid ? fromDisplayWeight(parsed, unit) : Number.NaN;
  const valid = displayValid && kg > 0 && kg <= MAX_KG;

  const dirty =
    editing === null ||
    Math.abs((valid ? kg : 0) - editing.kg) > Number.EPSILON ||
    day !== toDateOnly(editing.recordedAt) ||
    note.trim() !== (editing.note ?? '').trim();

  /* ---- the readout's twitch --------------------------------------------- */

  const nudge = useSharedValue(0);
  const bump = useCallback(() => {
    nudge.value = withSequence(
      withTiming(1, t.motion.timing(t.motion.duration.instant, 'accelerate')),
      withTiming(0, t.motion.timing(t.motion.duration.base, 'decelerate')),
    );
  }, [nudge, t.motion]);

  const readoutStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + nudge.value * 0.04 }],
  }));

  /* ---- pad -------------------------------------------------------------- */

  const press = useCallback(
    (key: PadKey) => {
      const next = applyKey(text, key);
      if (next === null) {
        haptics.warn();
        return;
      }
      setText(next);
      bump();
    },
    [bump, text],
  );

  const clear = useCallback(() => {
    if (text.length === 0) return;
    haptics.heavy();
    setText('');
    bump();
  }, [bump, text.length]);

  const setFromKg = useCallback(
    (value: number) => {
      haptics.select();
      setText(String(Number(toDisplayWeight(value, unit).toFixed(MAX_DECIMALS))));
      bump();
    },
    [bump, unit],
  );

  const step = useCallback(
    (delta: number) => {
      const base = displayValid ? parsed : toDisplayWeight(reference?.kg ?? 0, unit);
      const next = Math.max(0, Number((base + delta).toFixed(MAX_DECIMALS)));
      if (next === 0) {
        haptics.warn();
        return;
      }
      haptics.select();
      setText(String(next));
      bump();
    },
    [bump, displayValid, parsed, reference?.kg, unit],
  );

  /* ---- derived copy ----------------------------------------------------- */

  const delta = valid && reference ? kg - reference.kg : null;
  const deltaLabel = delta === null ? null : formatWeightDelta(delta, { unit });
  const flat = deltaLabel === 'No change';

  const targetKg = pet?.targetWeightKg ?? null;
  const insideTarget =
    valid && targetKg !== null ? Math.abs(kg - targetKg) <= targetKg * TARGET_TOLERANCE : false;
  const wasOutside =
    targetKg !== null && reference !== null
      ? Math.abs(reference.kg - targetKg) > targetKg * TARGET_TOLERANCE
      : false;

  const trend = useMemo(() => {
    const history = entries.filter((entry) => entry.id !== entryId).map((entry) => entry.kg);
    if (!valid) return history.map((value) => toDisplayWeight(value, unit));
    return [...history, kg].map((value) => toDisplayWeight(value, unit));
  }, [entries, entryId, kg, unit, valid]);

  /* ---- save ------------------------------------------------------------- */

  const recordedAt = useMemo(() => {
    if (editing && day === toDateOnly(editing.recordedAt)) return editing.recordedAt;
    const chosen = fromDateOnly(day) ?? new Date();
    const now = new Date();
    if (isSameLocalDay(chosen, now)) return now.toISOString();
    return new Date(
      chosen.getFullYear(),
      chosen.getMonth(),
      chosen.getDate(),
      BACKDATE_HOUR,
      0,
      0,
      0,
    ).toISOString();
  }, [day, editing]);

  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    if (!valid || !dirty || saving) {
      haptics.warn();
      return;
    }
    setSaving(true);
    try {
      await addWeight.mutateAsync({
        kg,
        recordedAt,
        note: note.trim().length > 0 ? note.trim() : null,
      });
      // Add first, then retire the old row: a failure between the two leaves a
      // duplicate, which is recoverable. The other order loses the reading.
      if (editing) await deleteWeight.mutateAsync(editing.id);

      const name = pet?.name ?? 'Your pet';
      if (insideTarget && wasOutside) {
        confetti.fire({ haptic: true });
        toast.success(`${name} is in the target band 🎉`, {
          description: `${formatWeight(kg, { unit })} — right where the vet wants them.`,
        });
      } else {
        haptics.success();
        toast.success(editing ? 'Weigh-in updated' : `${possessive(name)} weight is logged`, {
          description: deltaLabel && !flat ? `${formatWeight(kg, { unit })} · ${deltaLabel}` : formatWeight(kg, { unit }),
        });
      }
      router.back();
    } catch {
      // The mutation hooks already raise the explanatory toast (permission,
      // offline, whatever it was). Swallowing here only stops the unhandled
      // rejection that a fire-and-forget press handler would otherwise produce.
    } finally {
      setSaving(false);
    }
  }, [
    addWeight,
    deleteWeight,
    deltaLabel,
    dirty,
    editing,
    flat,
    insideTarget,
    kg,
    note,
    pet?.name,
    recordedAt,
    router,
    saving,
    unit,
    valid,
    wasOutside,
  ]);

  /* ---- chrome ----------------------------------------------------------- */

  const petName = pet?.name ?? 'your pet';
  const today = toDateOnly(new Date());
  const yesterday = toDateOnly(subDays(new Date(), 1));

  const header = (
    <ScreenHeader
      title={editing ? 'Edit weigh-in' : 'Weigh-in'}
      large={false}
      showBack={false}
      leading={
        <IconButton
          icon="close"
          accessibilityLabel="Close"
          accessibilityHint="Closes without saving."
          variant="ghost"
          tone="neutral"
          onPress={() => router.back()}
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
          accessibilityHint={valid ? `Saves ${formatWeight(kg, { unit })} for ${petName}.` : 'Enter a weight first.'}
        />
      }
    />
  );

  return (
    <Screen
      header={header}
      scroll
      contentContainerStyle={{ gap: t.spacing.lg, paddingBottom: t.spacing.xl }}
      footer={
        <Button
          label={editing ? 'Save the correction' : `Log it for ${petName}`}
          onPress={() => void save()}
          variant="primary"
          size="lg"
          fullWidth
          hero
          leftIcon="checkmark"
          disabled={!valid || !dirty}
          loading={saving}
          haptic="none"
          accessibilityHint={valid ? undefined : 'Tap a number to get started.'}
        />
      }
    >
      {/* ---- readout ------------------------------------------------------ */}
      <Animated.View entering={FadeIn.duration(t.motion.duration.base)}>
        <Surface
          variant="surface"
          elevation={1}
          radius="xxl"
          padding="base"
          style={{ gap: t.spacing.md, alignItems: 'center' }}
        >
          <Text variant="overline" color="textTertiary">
            {editing ? 'Corrected weight' : `How much does ${petName} weigh?`}
          </Text>

          <Animated.View style={readoutStyle}>
            <Row align="end" gap="xs">
              <Text
                variant="metric"
                color={valid ? 'text' : 'textFaint'}
                tabular
                numberOfLines={1}
                accessibilityLabel={valid ? formatWeight(kg, { unit }) : 'No weight entered yet'}
              >
                {text.length > 0 ? text : '0'}
              </Text>
              <Text variant="title3" color="textTertiary" style={{ marginBottom: t.spacing.sm }}>
                {weightUnitLabel(unit)}
              </Text>
            </Row>
          </Animated.View>

          <Animated.View layout={LinearTransition.duration(t.motion.duration.base)}>
            {deltaLabel ? (
              <Row
                gap="xs"
                style={{
                  paddingVertical: t.spacing.xs,
                  paddingHorizontal: t.spacing.md,
                  borderRadius: t.radius.pill,
                  backgroundColor: flat ? t.color.surfaceAlt : t.color.infoSoft,
                }}
              >
                <Icon
                  name={flat ? 'remove' : (delta ?? 0) > 0 ? 'arrow-up' : 'arrow-down'}
                  size="xs"
                  color={flat ? 'textSecondary' : 'onInfoSoft'}
                />
                <Text variant="captionStrong" color={flat ? 'textSecondary' : 'onInfoSoft'} tabular>
                  {reference
                    ? `${deltaLabel} vs ${formatWeight(reference.kg, { unit })} last time`
                    : deltaLabel}
                </Text>
              </Row>
            ) : (
              <Text variant="caption" color="textTertiary">
                {reference
                  ? `Last time: ${formatWeight(reference.kg, { unit })}`
                  : 'This will be the first reading on the chart.'}
              </Text>
            )}
          </Animated.View>

          {trend.length > 1 ? (
            <Sparkline
              data={trend}
              height={t.spacing.huge}
              color={insideTarget ? 'success' : 'primary'}
              fill
              lastPoint
              accessibilityLabel={`Trend with the new reading added, ${trend.length} points`}
            />
          ) : null}
        </Surface>
      </Animated.View>

      {/* ---- shortcuts ---------------------------------------------------- */}
      <Animated.View entering={FadeInDown.duration(t.motion.duration.slow).delay(t.motion.stagger.base)}>
        <Row gap="sm" wrap justify="center">
          {reference ? (
            <Chip
              label={`Same as last · ${formatWeight(reference.kg, { unit })}`}
              icon="repeat-outline"
              size="sm"
              showCheck={false}
              onPress={() => setFromKg(reference.kg)}
              accessibilityHint="Fills in the last recorded weight."
            />
          ) : null}
          {targetKg !== null ? (
            <Chip
              label={`Target · ${formatWeight(targetKg, { unit })}`}
              icon="flag-outline"
              size="sm"
              tone="accent"
              showCheck={false}
              onPress={() => setFromKg(targetKg)}
              accessibilityHint="Fills in the vet's target weight."
            />
          ) : null}
        </Row>
      </Animated.View>

      {/* ---- the pad ------------------------------------------------------ */}
      <Animated.View
        entering={FadeInDown.duration(t.motion.duration.slow).delay(t.motion.stagger.base * 2)}
        style={{ gap: t.spacing.md }}
      >
        <Row gap="md" justify="center">
          <NudgeButton icon="remove" label="Down a tenth" onPress={() => step(-0.1)} />
          <NudgeButton icon="add" label="Up a tenth" onPress={() => step(0.1)} />
        </Row>

        <Row gap="sm" wrap accessibilityLabel="Number pad">
          {PAD_KEYS.map((key) => (
            <PadButton
              key={key}
              value={key}
              onPress={() => press(key)}
              onLongPress={key === 'delete' ? clear : undefined}
            />
          ))}
        </Row>
      </Animated.View>

      {/* ---- when & why --------------------------------------------------- */}
      <Animated.View
        entering={FadeInDown.duration(t.motion.duration.slow).delay(t.motion.stagger.base * 3)}
        style={{ gap: t.spacing.md }}
      >
        <SectionHeader
          title="When was this?"
          subtitle="Back-date a reading you took at the vet and the chart still lines up."
          icon="calendar-outline"
          iconColor="textTertiary"
          first
        />

        <Row gap="sm" wrap>
          <Chip
            label="Today"
            selected={day === today}
            size="sm"
            onPress={() => setDay(today)}
          />
          <Chip
            label="Yesterday"
            selected={day === yesterday}
            size="sm"
            onPress={() => setDay(yesterday)}
          />
        </Row>

        <DateField
          label="Date"
          value={day}
          onChange={(next) => setDay(next ?? today)}
          maxDate={today}
          title="When was the weigh-in?"
          helper="We only ever use this to place the reading on the chart."
        />

        <TextArea
          label="Note (optional)"
          value={note}
          onChangeText={setNote}
          placeholder="Weighed after breakfast, on the vet's scales"
          helper="Anything that explains an odd number later."
          maxLength={NOTE_MAX}
          minRows={2}
          maxRows={4}
        />
      </Animated.View>
    </Screen>
  );
}

/* --------------------------------------------------------------- pad keys */

/**
 * One key. Big enough to hit while crouching, and it reports its own label to
 * VoiceOver — "delete" rather than the backspace glyph, which reads as nothing.
 */
function PadButton({
  value,
  onPress,
  onLongPress,
}: {
  value: PadKey;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const t = useTheme();
  const isDelete = value === 'delete';

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={isDelete ? 'Delete the last digit' : value === '.' ? 'Decimal point' : value}
      accessibilityHint={isDelete ? 'Hold to clear the whole number.' : undefined}
      haptic={isDelete ? 'tap' : 'select'}
      onPress={onPress}
      onLongPress={onLongPress}
      pressScale="medium"
      style={{ flexBasis: '30%', flexGrow: 1 }}
    >
      <Surface
        variant={isDelete ? 'surfaceAlt' : 'surface'}
        elevation={isDelete ? 0 : 1}
        radius="xl"
        border={isDelete}
        style={{
          height: t.spacing.giant,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {isDelete ? (
          <Icon name="backspace-outline" size="lg" color="textSecondary" />
        ) : (
          <Text variant="title1" tabular>
            {value}
          </Text>
        )}
      </Surface>
    </Touchable>
  );
}

function NudgeButton({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  const t = useTheme();

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      haptic="none"
      onPress={onPress}
      pressScale="small"
      style={{ flex: 1 }}
    >
      <Surface
        variant="surfaceAlt"
        radius="pill"
        paddingY="sm"
        border
        style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: t.spacing.xs }}
      >
        <Icon name={icon} size="sm" color="primaryText" />
        <Text variant="buttonSmall" color="primaryText">
          0.1
        </Text>
      </Surface>
    </Touchable>
  );
}
