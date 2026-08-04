/**
 * Petal — WeightSummary.
 *
 * The number, the two comparisons that give it meaning, and the chart.
 *
 * The one idea the whole component is built around: **the headline is the chart's
 * readout.** Drag across the line and the big number becomes whatever your
 * finger is on, the caption becomes that day, and the delta chips recalculate
 * against it. Let go and it springs back to today. That turns a chart from a
 * picture into an instrument, and it costs one piece of state — the alternative
 * (a tooltip floating over the plot) tells you the same thing in half the size,
 * somewhere your thumb is covering.
 *
 * The rest:
 *
 *   · **Kilograms in, the user's unit out.** Storage is always kg; every number
 *     on this card is rendered through `lib/format` with the *reactive* unit
 *     preference, including the chart's domain — so switching to pounds moves
 *     the axis, not just the label.
 *   · **The target is a band, not a line.** Vets say "keep him around 8kg", and
 *     a hairline at exactly 8.0 makes 8.1 look like a failure. We draw ±4% and
 *     call anything inside it right.
 *   · **A single reading is still worth drawing.** The chart handles it; the
 *     copy stops pretending to know a trend.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import type { Pet, WeightEntry } from '@/data/types';
import { DAY_MS, formatDay, friendlyDate, relativeTime } from '@/lib/date';
import {
  formatWeight,
  formatWeightDelta,
  possessive,
  toDisplayWeight,
  weightUnitLabel,
} from '@/lib/format';
import { usePreferences } from '@/stores/preferences';
import { useTheme } from '@/theme';
import {
  Column,
  Icon,
  LineChart,
  Row,
  Surface,
  Text,
  type BadgeTone,
  type IconName,
  type LineChartPoint,
  type LineChartTarget,
} from '@/ui';

/* -------------------------------------------------------------------- types */

export type WeightSummaryProps = {
  pet: Pet;
  /** Full history, oldest first — exactly as `useWeights()` returns it. */
  entries: readonly WeightEntry[];
  /** Narrows the plot without touching the headline figures. Null means all. */
  windowDays?: number | null;
  /** Caption under the chart naming the window — "Last 3 months". */
  windowLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

type Comparison = {
  label: string;
  value: string;
  tone: BadgeTone;
  icon: IconName;
};

/* ---------------------------------------------------------------- constants */

/** Half-width of the target band. A vet's "around 8kg" is not 8.00kg. */
const TARGET_TOLERANCE = 0.04;

/** Below this a "change" is scale noise, not the pet. */
const NOISE_KG = 0.005;

/* ------------------------------------------------------------------ helpers */

function withinTarget(kg: number, targetKg: number): boolean {
  return Math.abs(kg - targetKg) <= targetKg * TARGET_TOLERANCE;
}

/* ---------------------------------------------------------------- component */

export function WeightSummary({
  pet,
  entries,
  windowDays = null,
  windowLabel,
  style,
  testID,
}: WeightSummaryProps) {
  const t = useTheme();
  const unit = usePreferences((s) => s.weightUnit);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);

  const identity = t.speciesColor(pet.species);

  /* ---- the series ------------------------------------------------------- */

  const plotted = useMemo(() => {
    if (windowDays === null) return entries;
    const cutoff = Date.now() - windowDays * DAY_MS;
    const inside = entries.filter((entry) => Date.parse(entry.recordedAt) >= cutoff);
    // One point is a dot, not a line. Reach back for a neighbour so a quiet
    // quarter still shows which way things were going.
    if (inside.length >= 2 || entries.length < 2) return inside;
    return entries.slice(Math.max(0, entries.length - 2));
  }, [entries, windowDays]);

  const points = useMemo<LineChartPoint[]>(
    () =>
      plotted.map((entry) => ({
        x: Date.parse(entry.recordedAt),
        y: toDisplayWeight(entry.kg, unit),
      })),
    [plotted, unit],
  );

  const latest = entries.length > 0 ? entries[entries.length - 1] : undefined;
  const previous = entries.length > 1 ? entries[entries.length - 2] : undefined;

  /** What the headline is showing: the scrubbed reading, or today's. */
  const shown = scrubIndex === null ? latest : (plotted[scrubIndex] ?? latest);
  const scrubbing = scrubIndex !== null && shown !== latest;

  /* ---- the two comparisons --------------------------------------------- */

  const comparisons = useMemo<Comparison[]>(() => {
    if (!shown) return [];
    const rows: Comparison[] = [];

    // When scrubbing, "since last" means the reading before the one under the
    // finger — otherwise the chip would describe a point nobody is looking at.
    const baseline = scrubbing
      ? entries[entries.findIndex((entry) => entry.id === shown.id) - 1]
      : previous;

    if (baseline) {
      const delta = shown.kg - baseline.kg;
      const flat = Math.abs(delta) < NOISE_KG;
      rows.push({
        label: `since ${friendlyDate(baseline.recordedAt).toLowerCase()}`,
        value: flat ? 'No change' : formatWeightDelta(delta, { unit }),
        tone: flat ? 'neutral' : 'info',
        icon: flat ? 'remove' : delta > 0 ? 'arrow-up' : 'arrow-down',
      });
    }

    if (pet.targetWeightKg !== null) {
      const gap = shown.kg - pet.targetWeightKg;
      const inside = withinTarget(shown.kg, pet.targetWeightKg);
      rows.push({
        label: 'vs target',
        value: inside ? 'On target' : formatWeightDelta(gap, { unit }),
        tone: inside ? 'success' : 'warning',
        icon: inside ? 'checkmark-circle' : gap > 0 ? 'trending-up' : 'trending-down',
      });
    }

    return rows;
  }, [entries, pet.targetWeightKg, previous, scrubbing, shown, unit]);

  /* ---- the target band -------------------------------------------------- */

  const target = useMemo<LineChartTarget | null>(() => {
    if (pet.targetWeightKg === null) return null;
    const lo = pet.targetWeightKg * (1 - TARGET_TOLERANCE);
    const hi = pet.targetWeightKg * (1 + TARGET_TOLERANCE);
    return {
      min: toDisplayWeight(lo, unit),
      max: toDisplayWeight(hi, unit),
      label: `Target ${formatWeight(pet.targetWeightKg, { unit })}`,
    };
  }, [pet.targetWeightKg, unit]);

  /* ---- formatting ------------------------------------------------------- */

  const formatValue = useCallback((value: number) => {
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }, []);

  const formatX = useCallback((x: number) => formatDay(x), []);

  const formatScrubMeta = useCallback((point: LineChartPoint) => friendlyDate(point.x), []);

  const handleScrub = useCallback((_point: LineChartPoint | null, index: number) => {
    setScrubIndex(index < 0 ? null : index);
  }, []);

  /* ---- copy ------------------------------------------------------------- */

  const caption = (() => {
    if (!shown) return `No weigh-ins for ${pet.name} yet`;
    if (scrubbing) return `On ${friendlyDate(shown.recordedAt).toLowerCase()}`;
    return `Last weighed ${relativeTime(shown.recordedAt)}`;
  })();

  const verdict = (() => {
    if (!latest) return null;
    if (pet.targetWeightKg === null) {
      return `Set a target on ${possessive(pet.name)} profile and we’ll draw the band you’re aiming for.`;
    }
    if (withinTarget(latest.kg, pet.targetWeightKg)) {
      return `${pet.name} is sitting right in the target band. 🎉`;
    }
    const gap = latest.kg - pet.targetWeightKg;
    return gap > 0
      ? `${formatWeight(Math.abs(gap), { unit })} above the vet's target — worth a word at the next visit.`
      : `${formatWeight(Math.abs(gap), { unit })} under the vet's target — worth a word at the next visit.`;
  })();

  return (
    <Surface
      variant="surface"
      elevation={1}
      radius="xxl"
      padding="base"
      style={[{ gap: t.spacing.base }, style]}
      testID={testID}
    >
      <Row justify="between" align="start" gap="md">
        <Column gap="xxs" style={{ flexShrink: 1 }}>
          <Text variant="overline" color="textTertiary">
            {scrubbing ? 'That day' : 'Right now'}
          </Text>

          <Row align="end" gap="xs">
            <Text variant="metric" tabular numberOfLines={1}>
              {shown ? formatWeight(shown.kg, { unit, withUnit: false }) : '—'}
            </Text>
            <Text variant="subhead" color="textTertiary" style={{ marginBottom: t.spacing.xs }}>
              {weightUnitLabel(unit)}
            </Text>
          </Row>

          <Text variant="footnote" color="textSecondary" numberOfLines={1}>
            {caption}
          </Text>
        </Column>

        <View
          style={{
            width: t.spacing.huge,
            height: t.spacing.huge,
            borderRadius: t.radius.lg,
            backgroundColor: identity.tint,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="fitness-outline" size="lg" color={identity.base} />
        </View>
      </Row>

      {comparisons.length > 0 ? (
        <Row gap="sm" wrap>
          {comparisons.map((row) => (
            <ComparisonChip key={row.label} comparison={row} />
          ))}
        </Row>
      ) : null}

      <LineChart
        data={points}
        color={identity.base}
        target={target}
        formatValue={formatValue}
        formatX={points.length > 1 ? formatX : undefined}
        formatScrubMeta={formatScrubMeta}
        onScrubChange={handleScrub}
        emptyLabel="No readings in this window — try a longer one."
        accessibilityLabel={
          latest
            ? `${possessive(pet.name)} weight chart. ${points.length} readings, latest ${formatWeight(latest.kg, { unit })}.`
            : `No weight readings for ${pet.name} yet.`
        }
      />

      {windowLabel ? (
        <Text variant="caption" color="textTertiary" align="center">
          {points.length > 0 ? `${windowLabel} · drag the line to read a day` : windowLabel}
        </Text>
      ) : null}

      {verdict ? (
        <Animated.View entering={FadeIn.duration(t.motion.duration.base)}>
          <Row
            gap="sm"
            align="start"
            style={{
              padding: t.spacing.md,
              borderRadius: t.radius.lg,
              backgroundColor: t.color.surfaceAlt,
            }}
          >
            <Icon
              name={pet.targetWeightKg === null ? 'flag-outline' : 'information-circle-outline'}
              size="sm"
              color="textTertiary"
            />
            <Text variant="footnote" color="textSecondary" style={{ flex: 1 }}>
              {verdict}
            </Text>
          </Row>
        </Animated.View>
      ) : null}
    </Surface>
  );
}

/* ------------------------------------------------------------------- chip */

function ComparisonChip({ comparison }: { comparison: Comparison }) {
  const t = useTheme();

  const skin =
    comparison.tone === 'success'
      ? { fill: t.color.successSoft, ink: t.color.onSuccessSoft }
      : comparison.tone === 'warning'
        ? { fill: t.color.warningSoft, ink: t.color.onWarningSoft }
        : comparison.tone === 'info'
          ? { fill: t.color.infoSoft, ink: t.color.onInfoSoft }
          : { fill: t.color.surfaceAlt, ink: t.color.textSecondary };

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={`${comparison.value} ${comparison.label}`}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.spacing.xs,
        paddingVertical: t.spacing.xs,
        paddingHorizontal: t.spacing.md,
        borderRadius: t.radius.pill,
        backgroundColor: skin.fill,
      }}
    >
      <Icon name={comparison.icon} size="xs" color={skin.ink} />
      <Text variant="captionStrong" color={skin.ink} tabular numberOfLines={1}>
        {comparison.value}
      </Text>
      <Text variant="caption" color={skin.ink} numberOfLines={1} style={{ opacity: t.opacity.muted }}>
        {comparison.label}
      </Text>
    </View>
  );
}

export default WeightSummary;
