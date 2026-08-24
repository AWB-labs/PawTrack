/**
 * Petal — RefillCard.
 *
 * Running out of medication is a quiet failure: nothing breaks, a dose is just
 * missed on a Sunday when the vet is shut. So this card answers the only two
 * questions that matter — *how much is left* and *when does that become a
 * problem* — and puts the fix one tap away.
 *
 *   · **Cover is expressed in days, not doses.** "Six doses" means nothing
 *     until you know it's a twice-daily tablet; "about three days" is a decision.
 *   · **A refill replaces the pack, it doesn't add to it.** The sheet says so,
 *     because a stepper that looks like "add 30" and behaves like "set to 30" is
 *     how a count silently doubles.
 *   · **Owner-only, so it is simply absent for a sitter.** `medicine.edit` can
 *     never be granted to a caregiver, and a locked control they can't ever
 *     unlock reads as a threat rather than an explanation.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { useRecordRefill } from '@/data/queries/useMedicine';
import type { DateOnly, ID, Medicine } from '@/data/types';
import { DAY_MS, friendlyDate, toDateOnly } from '@/lib/date';
import { plural, possessive } from '@/lib/format';
import haptics from '@/lib/haptics';
import { useTheme } from '@/theme';
import {
  Button,
  Chip,
  Column,
  DateField,
  Icon,
  ProgressBar,
  Row,
  Sheet,
  Stepper,
  Surface,
  Text,
  toast,
  useSheet,
} from '@/ui';

import { dosesPerDay, MEDICINE_FREQUENCY_META } from './MedicineCard';

/* -------------------------------------------------------------------- types */

export type RefillCardProps = {
  petId: ID;
  petName: string;
  medicine: Medicine;
  /** Days of cover at or below which the card reads as urgent. */
  urgentDays?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/** A full bar means a fortnight of cover — the point at which nobody worries. */
const RUNWAY_DAYS = 14;

/** Below this, the card stops being informational and starts being a nudge. */
const DEFAULT_URGENT_DAYS = 4;

/** Pack sizes that cover almost every real prescription. */
const QUICK_PACKS = [14, 28, 30, 60, 90] as const;

const DEFAULT_PACK = 30;

/* ---------------------------------------------------------------- component */

export function RefillCard({
  petId,
  petName,
  medicine,
  urgentDays = DEFAULT_URGENT_DAYS,
  style,
  testID,
}: RefillCardProps) {
  const t = useTheme();
  const sheet = useSheet();
  const recordRefill = useRecordRefill(petId);

  const remaining = medicine.remainingDoses;
  const perDay = dosesPerDay(medicine.frequency);
  const frequency = MEDICINE_FREQUENCY_META[medicine.frequency];

  const [pack, setPack] = useState<number>(remaining && remaining > 0 ? remaining : DEFAULT_PACK);
  const [remindAt, setRemindAt] = useState<DateOnly | null>(medicine.refillAt);

  const cover = useMemo(() => {
    if (remaining === null || perDay <= 0) return null;
    const days = remaining / perDay;
    return { days, runsOut: new Date(Date.now() + days * DAY_MS) };
  }, [perDay, remaining]);

  const urgent = cover !== null && cover.days <= urgentDays;
  const tone = urgent ? (cover !== null && cover.days <= 1 ? 'danger' : 'warning') : 'success';

  const headline = (() => {
    if (remaining === null) return `No pack count for ${medicine.name} yet`;
    if (remaining === 0) return `${possessive(petName)} pack is empty`;
    return `${plural(remaining, 'dose')} left`;
  })();

  const detail = (() => {
    if (remaining === null) {
      return `Tell us how many doses are in the pack and we'll warn you before ${petName} runs out.`;
    }
    if (perDay <= 0) {
      return `${frequency.label}, so there's no run-out date to project — but we'll keep the count for you.`;
    }
    if (!cover) return '';
    const whole = Math.max(0, Math.floor(cover.days));
    if (whole === 0) return `That's today's doses and no more. Worth ringing the vet now.`;
    return `About ${plural(whole, 'day')} of cover — runs out around ${friendlyDate(cover.runsOut).toLowerCase()}.`;
  })();

  const openSheet = useCallback(() => {
    setPack(remaining && remaining > 0 ? remaining : DEFAULT_PACK);
    setRemindAt(medicine.refillAt);
    sheet.open();
  }, [medicine.refillAt, remaining, sheet]);

  const save = useCallback(() => {
    haptics.success();
    recordRefill.mutate({ medicineId: medicine.id, doses: pack, refillAt: remindAt });
    sheet.close();
    toast.success(`${medicine.name} topped up`, {
      description: `${plural(pack, 'dose')} in the pack. We'll nudge you before it runs low again.`,
      icon: 'bandage-outline',
      haptic: false,
    });
  }, [medicine.id, medicine.name, pack, recordRefill, remindAt, sheet]);

  const today = toDateOnly(new Date());

  return (
    <View style={style} testID={testID}>
      <Surface variant="surface" elevation={1} radius="xxl" padding="base" style={{ gap: t.spacing.base }}>
        <Row gap="md" align="start">
          <View
            style={{
              width: t.spacing.xxxl,
              height: t.spacing.xxxl,
              borderRadius: t.radius.md,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: urgent ? t.color.warningSoft : t.color.primarySoft,
            }}
          >
            <Icon
              name={urgent ? 'alert-circle-outline' : 'bandage-outline'}
              size="md"
              color={urgent ? 'onWarningSoft' : 'onPrimarySoft'}
            />
          </View>

          <Column flex gap="hair">
            <Text variant="overline" color="textTertiary">
              {medicine.name} · pack
            </Text>
            <Text variant="title3" numberOfLines={2}>
              {headline}
            </Text>
          </Column>
        </Row>

        {detail ? (
          <Text variant="footnote" color="textSecondary">
            {detail}
          </Text>
        ) : null}

        {cover ? (
          <ProgressBar
            value={Math.min(1, cover.days / RUNWAY_DAYS)}
            tone={tone}
            size="md"
            label="Cover left"
            trailingLabel={`${Math.max(0, Math.floor(cover.days))} days`}
            accessibilityLabel={`About ${plural(Math.max(0, Math.floor(cover.days)), 'day')} of ${medicine.name} left for ${petName}`}
          />
        ) : null}

        <Button
          label={remaining === null ? 'Add a pack count' : 'Record a refill'}
          onPress={openSheet}
          variant={urgent ? 'primary' : 'tonal'}
          size="md"
          fullWidth
          leftIcon="add-circle-outline"
          hero={urgent}
          accessibilityHint={`Sets how many doses of ${medicine.name} are in the pack.`}
        />
      </Surface>

      <Sheet
        controller={sheet}
        contentStyle={{ gap: t.spacing.lg }}
        title={`Refill ${medicine.name}`}
        subtitle="A refill replaces the pack — this sets the count, it doesn’t add to it."
        footer={
          <Row gap="md">
            <Button label="Cancel" variant="ghost" size="lg" onPress={sheet.close} />
            <View style={{ flex: 1 }} />
            <Button
              label={`Set to ${plural(pack, 'dose')}`}
              variant="primary"
              size="lg"
              onPress={save}
              loading={recordRefill.isPending}
              haptic="none"
            />
          </Row>
        }
      >
        <Column gap="sm">
          <Text variant="subheadStrong" color="textSecondary">
            How many doses are in the new pack?
          </Text>
          <Stepper
            value={pack}
            onChange={setPack}
            min={0}
            max={365}
            step={1}
            unit={pack === 1 ? 'dose' : 'doses'}
            accessibilityLabel="Doses in the pack"
            accessibilityHint="Hold to change it quickly."
          />
          <Row gap="sm" wrap style={{ paddingTop: t.spacing.xs }}>
            {QUICK_PACKS.map((size) => (
              <Chip
                key={size}
                label={String(size)}
                selected={pack === size}
                onPress={() => setPack(size)}
                size="sm"
                accessibilityLabel={`${size} doses`}
              />
            ))}
          </Row>
          {perDay > 0 ? (
            <Text variant="caption" color="textTertiary">
              At {frequency.label.toLowerCase()}, that&apos;s about{' '}
              {plural(Math.floor(pack / perDay), 'day')} of cover for {petName}.
            </Text>
          ) : null}
        </Column>

        <DateField
          value={remindAt}
          onChange={setRemindAt}
          label="Remind me to reorder"
          placeholder="Let Furry Tracker work it out"
          helper="Leave it empty and we'll nudge you a few days before the pack runs out."
          minDate={today}
          clearable
        />
      </Sheet>
    </View>
  );
}

export default RefillCard;
