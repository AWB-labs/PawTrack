/**
 * Petal — the owner's permission editor.
 *
 * Twenty-seven checkboxes is how you get an owner who grants everything to the
 * neighbour's teenager, because reading twenty-seven rows is worse than the
 * risk. So the default path is four preset cards that match how sitting
 * actually works — view only, daily care, full sitter, vet trips — and the
 * per-capability switches live behind one "fine-tune" disclosure.
 *
 * Two behaviours worth knowing:
 *
 *  · **Dependencies are implied.** "Log meals" without "See feeding schedule"
 *    is a control that can't be reached, so switching a `.log`/`.edit` grant on
 *    switches its `.view` on too, and switching a `.view` off takes its
 *    dependents with it. The switches animate, which is the explanation.
 *  · **The summary is the real UI.** Owners don't audit grant lists, they read
 *    one sentence and decide. The plain-language summary under the controls is
 *    what they actually check before sending the invite.
 *
 * Fully controlled: `value` in, `(grants, presetId)` out. The invite flow owns
 * the dates; this owns the capabilities.
 */

import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useState, type ComponentProps } from 'react';
import {
  Pressable,
  StyleSheet,
  Text as RNText,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type TextProps as RNTextProps,
  type ViewStyle,
} from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  LinearTransition,
  ReduceMotion,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type WithSpringConfig,
} from 'react-native-reanimated';

import haptics from '@/lib/haptics';
import {
  CAPABILITY_GROUPS,
  CAREGIVER_BASELINE,
  CAREGIVER_GRANTABLE,
  CAREGIVER_PRESETS,
  matchPreset,
  sanitizeGrants,
  type CapabilityGroup,
  type CaregiverPreset,
  type Capability,
  type PresetId,
} from '@/rbac/permissions';
import {
  makeStyles,
  spacing,
  useTheme,
  type SpringName,
  type Theme,
  type TypeVariant,
} from '@/theme';

/* ------------------------------------------------------------------- types */

export type CapabilityPickerProps = {
  /** The current grant list. Baseline capabilities are added automatically. */
  value: Capability[];
  onChange: (grants: Capability[], presetId: PresetId) => void;
  /** Used throughout the copy — "…log Buddy's meals". */
  petName: string;
  /** Who the invite is for. Falls back to "This person". */
  personName?: string | null;
  style?: StyleProp<ViewStyle>;
};

type IconName = ComponentProps<typeof Ionicons>['name'];

/* --------------------------------------------------------------- constants */

/**
 * `[dependent, requirement]`. Granting the left implies the right; revoking the
 * right revokes the left. Without this an owner can hand out "log doses" while
 * hiding the medicine list, and the sitter gets a screen they cannot open.
 */
const REQUIRES: readonly (readonly [Capability, Capability])[] = [
  ['feeding.log', 'feeding.view'],
  ['feeding.schedule.edit', 'feeding.view'],
  ['medicine.log', 'medicine.view'],
  ['weight.log', 'weight.view'],
  ['vaccination.edit', 'vaccination.view'],
  ['vetvisit.edit', 'vetvisit.view'],
];

const requirementFor = (capability: Capability): Capability | undefined =>
  REQUIRES.find(([dependent]) => dependent === capability)?.[1];

const dependentsOf = (capability: Capability): Capability[] =>
  REQUIRES.filter(([, requirement]) => requirement === capability).map(([dependent]) => dependent);

/** Presets are the happy path; "Custom" is a *state*, not a card you can pick. */
const SELECTABLE_PRESETS = CAREGIVER_PRESETS.filter((preset) => preset.id !== 'custom');

/**
 * Switch geometry, derived from the spacing scale rather than eyeballed: a
 * 48×28 track with a 4pt inset leaves a 20pt knob and exactly 20pt of travel.
 * Module scope because the translate happens in a worklet.
 */
const SWITCH_TRACK_WIDTH = spacing.huge;
const SWITCH_TRACK_HEIGHT = spacing.xl + spacing.xxs;
const SWITCH_INSET = spacing.xxs;
const SWITCH_KNOB = SWITCH_TRACK_HEIGHT - SWITCH_INSET * 2;
const SWITCH_TRAVEL = SWITCH_TRACK_WIDTH - SWITCH_KNOB - SWITCH_INSET * 2;

const iconName = (name: string): IconName =>
  name in Ionicons.glyphMap ? (name as IconName) : 'ellipse-outline';

/**
 * `theme.motion.springWith()` currently infers a union that Reanimated's
 * `withSpring` rejects — its optional `overrides` spread widens the return type
 * (`src/theme/motion.ts`). Reading the named preset directly produces the
 * identical runtime config with a type `withSpring` accepts. Delete once the
 * theme pins `springWith`'s return type to `WithSpringConfig`.
 */
function springOf(t: Theme, name: SpringName): WithSpringConfig {
  return { ...t.motion.spring[name], reduceMotion: ReduceMotion.System };
}

/* ------------------------------------------------------- plain-language */

function actionPhrases(petName: string): readonly (readonly [Capability, string])[] {
  return [
    ['feeding.log', 'log meals'],
    ['feeding.schedule.edit', 'change the feeding schedule'],
    ['medicine.log', 'log doses'],
    ['weight.log', 'record weight'],
    ['vaccination.edit', 'update vaccinations'],
    ['vetvisit.edit', 'write up vet visits'],
    ['community.post', `post about ${petName}`],
  ];
}

function joinPhrases(list: string[]): string {
  if (list.length === 0) return '';
  if (list.length === 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function summarise(
  grants: Capability[],
  petName: string,
  personName?: string | null,
): { can: string; cannot: string } {
  const who = personName?.trim() || 'This person';
  const held = new Set(grants);
  const phrases = actionPhrases(petName);
  const granted = phrases.filter(([capability]) => held.has(capability)).map(([, phrase]) => phrase);
  const missing = phrases
    .filter(([capability]) => !held.has(capability))
    .map(([, phrase]) => phrase);

  const shown = granted.slice(0, 4);
  const extra = granted.length - shown.length;

  const can =
    granted.length === 0
      ? `${who} will see ${petName}'s profile, schedule and medicines — and won't be able to log or change anything.`
      : `${who} will be able to ${joinPhrases(shown)}${extra > 0 ? `, plus ${extra} more` : ''}.`;

  const cannot =
    missing.length === 0
      ? `That's everything a sitter can hold. Editing the profile, inviting other sitters and the account itself still stay with you.`
      : `They won't be able to ${joinPhrases(missing.slice(0, 2))}. Profile edits, other sitters and the account always stay with you.`;

  return { can, cannot };
}

/* --------------------------------------------------------------- local UI */

/** Stand-in for `@/ui/Text` while the primitives land — same ramp, same caps. */
type LabelProps = RNTextProps & { variant?: TypeVariant; color?: string };

function Label({ variant = 'body', color, style, ...rest }: LabelProps) {
  const t = useTheme();
  const { maxFontSizeMultiplier, ...typeStyle } = t.type[variant];
  return (
    <RNText
      {...rest}
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      style={[typeStyle, color ? { color } : null, style]}
    />
  );
}

/** Purely presentational — the enclosing row owns the press and the a11y. */
function Toggle({ on }: { on: boolean }) {
  const t = useTheme();
  const styles = useStyles();
  const progress = useSharedValue(on ? 1 : 0);

  const offTrack = t.color.borderStrong;
  const onTrack = t.color.primary;
  const offKnob = t.color.surface;
  const onKnob = t.color.onPrimary;

  useEffect(() => {
    progress.value = withSpring(on ? 1 : 0, springOf(t, 'snappy'));
  }, [on, progress, t.motion]);

  const trackStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [offTrack, onTrack]),
  }));

  const knobStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * SWITCH_TRAVEL }],
    backgroundColor: interpolateColor(progress.value, [0, 1], [offKnob, onKnob]),
  }));

  return (
    <Animated.View style={[styles.track, trackStyle]}>
      <Animated.View style={[styles.knob, knobStyle]} />
    </Animated.View>
  );
}

type PresetCardProps = {
  preset: CaregiverPreset;
  selected: boolean;
  index: number;
  onPress: () => void;
};

function PresetCard({ preset, selected, index, onPress }: PresetCardProps) {
  const t = useTheme();
  const styles = useStyles();

  const chosen = useSharedValue(selected ? 1 : 0);
  const pressed = useSharedValue(0);

  const restBorder = t.color.border;
  const activeBorder = t.color.primary;

  useEffect(() => {
    chosen.value = withSpring(selected ? 1 : 0, springOf(t, 'snappy'));
  }, [selected, chosen, t.motion]);

  const cardStyle = useAnimatedStyle(() => ({
    borderColor: interpolateColor(chosen.value, [0, 1], [restBorder, activeBorder]),
    transform: [{ scale: 1 - pressed.value * (1 - t.motion.pressScale.large) }],
  }));

  const washStyle = useAnimatedStyle(() => ({ opacity: chosen.value }));
  const dotStyle = useAnimatedStyle(() => ({ transform: [{ scale: chosen.value }] }));

  const entering = t.reduceMotion
    ? FadeIn.duration(t.motion.duration.base)
    : FadeInDown.duration(t.motion.duration.base)
        .delay(index * t.motion.stagger.base)
        .easing(t.motion.easing.decelerate);

  return (
    <Pressable
      onPressIn={() => {
        pressed.value = withSpring(1, springOf(t, 'press'));
      }}
      onPressOut={() => {
        pressed.value = withSpring(0, springOf(t, 'press'));
      }}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected, checked: selected }}
      accessibilityLabel={preset.label}
      accessibilityHint={preset.summary}
    >
      <Animated.View entering={entering} style={[styles.presetCard, cardStyle]}>
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, styles.presetWash, washStyle]}
        />

        <View
          style={[
            styles.presetIcon,
            { backgroundColor: selected ? t.color.primarySoftBorder : t.color.surfaceAlt },
          ]}
        >
          <Ionicons
            name={iconName(preset.icon)}
            size={t.spacing.lg}
            color={selected ? t.color.onPrimarySoft : t.color.textSecondary}
          />
        </View>

        <View style={styles.presetText}>
          <Label variant="bodyStrong" color={t.color.text}>
            {preset.label}
          </Label>
          <Label variant="footnote" color={t.color.textTertiary}>
            {preset.summary}
          </Label>
        </View>

        <View style={styles.radio}>
          <Animated.View style={[styles.radioDot, dotStyle]} />
        </View>
      </Animated.View>
    </Pressable>
  );
}

type CapabilityRowProps = {
  label: string;
  hint?: string;
  checked: boolean;
  /** Baseline grants every sitter holds — shown, but not switchable. */
  fixed?: boolean;
  onToggle: () => void;
};

function CapabilityRow({ label, hint, checked, fixed = false, onToggle }: CapabilityRowProps) {
  const t = useTheme();
  const styles = useStyles();

  if (fixed) {
    return (
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={`${label}. Always on for every sitter.`}
        style={styles.row}
      >
        <View style={styles.rowText}>
          <Label variant="callout" color={t.color.textSecondary}>
            {label}
          </Label>
        </View>
        <View style={styles.alwaysOn}>
          <Ionicons name="checkmark" size={t.spacing.md} color={t.color.onPrimarySoft} />
          <Label variant="caption" color={t.color.onPrimarySoft}>
            Always on
          </Label>
        </View>
      </View>
    );
  }

  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="switch"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      accessibilityHint={hint}
      style={styles.row}
    >
      <View style={styles.rowText}>
        <Label variant="callout" color={t.color.text}>
          {label}
        </Label>
        {hint ? (
          <Label variant="caption" color={t.color.textTertiary}>
            {hint}
          </Label>
        ) : null}
      </View>
      <Toggle on={checked} />
    </Pressable>
  );
}

/* -------------------------------------------------------------- component */

export function CapabilityPicker({
  value,
  onChange,
  petName,
  personName,
  style,
}: CapabilityPickerProps) {
  const t = useTheme();
  const styles = useStyles();

  const [tuning, setTuning] = useState(false);
  const [tuningHeight, setTuningHeight] = useState(0);
  const openTuning = useSharedValue(0);

  const presetId = useMemo(() => matchPreset(value), [value]);
  const held = useMemo(() => new Set(value), [value]);
  const summary = useMemo(() => summarise(value, petName, personName), [value, petName, personName]);

  const emit = useCallback(
    (next: Iterable<Capability>) => {
      const clean = sanitizeGrants([...CAREGIVER_BASELINE, ...next]);
      onChange(clean, matchPreset(clean));
    },
    [onChange],
  );

  const choosePreset = useCallback(
    (preset: CaregiverPreset) => {
      haptics.commit();
      emit(preset.grants);
    },
    [emit],
  );

  const toggleCapability = useCallback(
    (capability: Capability) => {
      haptics.select();
      const next = new Set(value);
      if (next.has(capability)) {
        next.delete(capability);
        for (const dependent of dependentsOf(capability)) next.delete(dependent);
      } else {
        next.add(capability);
        const requirement = requirementFor(capability);
        if (requirement) next.add(requirement);
      }
      emit(next);
    },
    [value, emit],
  );

  const toggleGroup = useCallback(
    (group: CapabilityGroup, turnOn: boolean) => {
      haptics.commit();
      const next = new Set(value);
      for (const item of group.items) {
        if (CAREGIVER_BASELINE.includes(item.capability)) continue;
        if (turnOn) {
          next.add(item.capability);
          const requirement = requirementFor(item.capability);
          if (requirement) next.add(requirement);
        } else {
          next.delete(item.capability);
          for (const dependent of dependentsOf(item.capability)) next.delete(dependent);
        }
      }
      emit(next);
    },
    [value, emit],
  );

  const toggleTuning = useCallback(() => {
    const next = !tuning;
    setTuning(next);
    openTuning.value = withTiming(
      next ? 1 : 0,
      t.motion.timing(t.motion.duration.base, next ? 'decelerate' : 'accelerate'),
    );
    haptics.tap();
  }, [tuning, openTuning, t.motion]);

  const onTuningLayout = useCallback((event: LayoutChangeEvent) => {
    setTuningHeight(event.nativeEvent.layout.height);
  }, []);

  const tuningStyle = useAnimatedStyle(
    () => ({ height: tuningHeight * openTuning.value, opacity: openTuning.value }),
    [tuningHeight],
  );

  const tuningChevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${openTuning.value * 180}deg` }],
  }));

  const isCustom = presetId === 'custom';

  return (
    <View style={style}>
      <Label variant="overline" color={t.color.textTertiary} style={styles.sectionLabel}>
        Start from a preset
      </Label>

      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="Access presets"
        style={styles.presetList}
      >
        {SELECTABLE_PRESETS.map((preset, index) => (
          <PresetCard
            key={preset.id}
            preset={preset}
            index={index}
            selected={preset.id === presetId}
            onPress={() => choosePreset(preset)}
          />
        ))}
      </View>

      {/* ------------------------------------------------------ fine-tune */}
      <Pressable
        onPress={toggleTuning}
        accessibilityRole="button"
        accessibilityState={{ expanded: tuning }}
        accessibilityLabel="Fine-tune permissions"
        accessibilityHint="Opens the full list of individual permissions."
        style={styles.tuneHeader}
      >
        <Ionicons name="options-outline" size={t.spacing.lg} color={t.color.textSecondary} />
        <View style={styles.tuneHeaderText}>
          <Label variant="bodyStrong" color={t.color.text}>
            Fine-tune permissions
          </Label>
          <Label variant="caption" color={t.color.textTertiary}>
            {isCustom ? 'Custom · ' : ''}
            {value.length} of {CAREGIVER_GRANTABLE.length} switched on
          </Label>
        </View>
        <Animated.View style={tuningChevronStyle}>
          <Ionicons name="chevron-down" size={t.spacing.lg} color={t.color.textSecondary} />
        </Animated.View>
      </Pressable>

      <Animated.View style={[styles.tuneClip, tuningStyle]}>
        <View
          onLayout={onTuningLayout}
          accessibilityElementsHidden={!tuning}
          importantForAccessibility={tuning ? 'auto' : 'no-hide-descendants'}
        >
          {CAPABILITY_GROUPS.map((group) => {
            const toggleable = group.items
              .map((item) => item.capability)
              .filter((capability) => !CAREGIVER_BASELINE.includes(capability));
            const allOn = toggleable.length > 0 && toggleable.every((c) => held.has(c));

            return (
              <View key={group.id} style={styles.group}>
                <View style={styles.groupHeader}>
                  <Ionicons
                    name={iconName(group.icon)}
                    size={t.spacing.base}
                    color={t.color.textSecondary}
                  />
                  <Label variant="overline" color={t.color.textSecondary} style={styles.groupLabel}>
                    {group.label}
                  </Label>
                  {toggleable.length > 1 ? (
                    <Pressable
                      onPress={() => toggleGroup(group, !allOn)}
                      accessibilityRole="button"
                      accessibilityLabel={
                        allOn ? `Turn off all ${group.label} permissions` : `Turn on all ${group.label} permissions`
                      }
                      style={styles.groupAction}
                    >
                      <Label variant="buttonSmall" color={t.color.primaryText}>
                        {allOn ? 'None' : 'All'}
                      </Label>
                    </Pressable>
                  ) : null}
                </View>

                <View style={styles.groupBody}>
                  {group.items.map((item) => (
                    <CapabilityRow
                      key={item.capability}
                      label={item.label}
                      hint={item.hint}
                      checked={held.has(item.capability)}
                      fixed={CAREGIVER_BASELINE.includes(item.capability)}
                      onToggle={() => toggleCapability(item.capability)}
                    />
                  ))}
                </View>
              </View>
            );
          })}
        </View>
      </Animated.View>

      {/* -------------------------------------------------------- summary */}
      <Animated.View
        layout={LinearTransition.duration(t.motion.duration.base)}
        style={styles.summary}
      >
        <View style={styles.summaryIcon}>
          <Ionicons name="sparkles-outline" size={t.spacing.base} color={t.color.onPrimarySoft} />
        </View>
        <Animated.View
          key={`${summary.can}${summary.cannot}`}
          entering={FadeIn.duration(t.motion.duration.base)}
          style={styles.summaryText}
        >
          <Label variant="callout" color={t.color.text}>
            {summary.can}
          </Label>
          <Label variant="footnote" color={t.color.textSecondary}>
            {summary.cannot}
          </Label>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

export default CapabilityPicker;

/* ----------------------------------------------------------------- styles */

const useStyles = makeStyles((t: Theme) =>
  StyleSheet.create({
    sectionLabel: {
      marginBottom: t.spacing.sm,
    },
    presetList: {
      gap: t.spacing.md,
    },
    presetCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.md,
      padding: t.spacing.base,
      minHeight: t.minTarget,
      borderRadius: t.radius.lg,
      borderWidth: t.borderWidth.thin,
      backgroundColor: t.color.surface,
      overflow: 'hidden',
    },
    presetWash: {
      backgroundColor: t.color.primarySoft,
      borderRadius: t.radius.lg,
    },
    presetIcon: {
      width: t.spacing.xxl,
      height: t.spacing.xxl,
      borderRadius: t.radius.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    presetText: {
      flex: 1,
      gap: t.spacing.hair,
    },
    radio: {
      width: t.spacing.lg,
      height: t.spacing.lg,
      borderRadius: t.radius.pill,
      borderWidth: t.borderWidth.thin,
      borderColor: t.color.borderStrong,
      alignItems: 'center',
      justifyContent: 'center',
    },
    radioDot: {
      width: t.spacing.md,
      height: t.spacing.md,
      borderRadius: t.radius.pill,
      backgroundColor: t.color.primary,
    },
    tuneHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.md,
      minHeight: t.minTarget,
      marginTop: t.spacing.lg,
      paddingVertical: t.spacing.md,
      paddingHorizontal: t.spacing.base,
      borderRadius: t.radius.lg,
      backgroundColor: t.color.surfaceAlt,
    },
    tuneHeaderText: {
      flex: 1,
      gap: t.spacing.hair,
    },
    tuneClip: {
      overflow: 'hidden',
    },
    group: {
      marginTop: t.spacing.lg,
    },
    groupHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.xs,
      marginBottom: t.spacing.xs,
    },
    groupLabel: {
      flex: 1,
    },
    groupAction: {
      minHeight: t.minTarget,
      justifyContent: 'center',
      paddingHorizontal: t.spacing.sm,
    },
    groupBody: {
      borderRadius: t.radius.lg,
      backgroundColor: t.color.surface,
      borderWidth: t.borderWidth.hairline,
      borderColor: t.color.border,
      paddingHorizontal: t.spacing.base,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.md,
      minHeight: t.minTarget + t.spacing.sm,
      paddingVertical: t.spacing.sm,
    },
    rowText: {
      flex: 1,
      gap: t.spacing.hair,
    },
    alwaysOn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.xxs,
      paddingVertical: t.spacing.xxs,
      paddingHorizontal: t.spacing.sm,
      borderRadius: t.radius.pill,
      backgroundColor: t.color.primarySoft,
    },
    track: {
      width: SWITCH_TRACK_WIDTH,
      height: SWITCH_TRACK_HEIGHT,
      borderRadius: t.radius.pill,
      padding: SWITCH_INSET,
      justifyContent: 'center',
    },
    knob: {
      width: SWITCH_KNOB,
      height: SWITCH_KNOB,
      borderRadius: t.radius.pill,
      ...t.elevation(1),
    },
    summary: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: t.spacing.md,
      marginTop: t.spacing.lg,
      padding: t.spacing.base,
      borderRadius: t.radius.lg,
      backgroundColor: t.color.primarySoft,
      borderWidth: t.borderWidth.hairline,
      borderColor: t.color.primarySoftBorder,
    },
    summaryIcon: {
      width: t.spacing.xl,
      height: t.spacing.xl,
      borderRadius: t.radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.color.primarySoftBorder,
    },
    summaryText: {
      flex: 1,
      gap: t.spacing.xs,
    },
  }),
);
