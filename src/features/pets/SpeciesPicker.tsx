/**
 * Petal — SpeciesPicker.
 *
 * The first question the create flow asks, so it sets the tone for everything
 * after it. A `Select` would have been three taps and a sheet; this is one tap
 * on something the size of a thumb, with the pet's identity colour arriving as
 * you press it.
 *
 * The selection spring does three things at once — the tile lifts, the species
 * wash floods in, and a check pops onto the corner — because a single property
 * changing (a border, say) is easy to miss on a wall of eight tiles.
 *
 * Tile widths are measured, not guessed: `flexBasis` percentages leave the last
 * row of a ragged grid stretched, and a row of two enormous tiles under a row of
 * three small ones is the tell of a form that was never looked at.
 */

import React, { useCallback, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  interpolate,
  interpolateColor,
  ReduceMotion,
  useAnimatedStyle,
  useDerivedValue,
  withSpring,
  ZoomIn,
  ZoomOut,
  type WithSpringConfig,
} from 'react-native-reanimated';

import { SPECIES_META } from '@/data/types';
import { spring, useTheme, type SpeciesKey } from '@/theme';
import { Icon, Text, Touchable } from '@/ui';

/* -------------------------------------------------------------------- types */

export type SpeciesPickerProps = {
  value: SpeciesKey | null;
  onChange: (species: SpeciesKey) => void;
  /** Restrict or reorder the grid. Defaults to every species Petal knows. */
  options?: readonly SpeciesKey[];
  columns?: number;
  disabled?: boolean;
  /** Announced for the group — "What kind of pet?". */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

type SpeciesTileProps = {
  species: SpeciesKey;
  selected: boolean;
  disabled: boolean;
  width: number;
  onPress: (species: SpeciesKey) => void;
};

/* ---------------------------------------------------------------- constants */

const ALL_SPECIES = Object.keys(SPECIES_META) as SpeciesKey[];

/** See `Touchable` — the theme's `springWith` helper doesn't type-check yet. */
const PICK_SPRING: WithSpringConfig = { ...spring.snappy, reduceMotion: ReduceMotion.System };

/** How far a chosen tile rises out of the grid. */
const LIFT_SCALE = 0.03;

const DEFAULT_COLUMNS = 3;

/* ---------------------------------------------------------------- component */

export function SpeciesPicker({
  value,
  onChange,
  options = ALL_SPECIES,
  columns = DEFAULT_COLUMNS,
  disabled = false,
  accessibilityLabel = 'Species',
  style,
  testID,
}: SpeciesPickerProps) {
  const t = useTheme();
  const [gridWidth, setGridWidth] = useState(0);

  const gap = t.spacing.md;
  const count = Math.max(1, columns);
  const tileWidth = gridWidth > 0 ? (gridWidth - gap * (count - 1)) / count : 0;

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    setGridWidth((previous) => (Math.abs(previous - width) < 1 ? previous : width));
  }, []);

  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      onLayout={onLayout}
      testID={testID}
      style={[styles.grid, { gap }, style]}
    >
      {tileWidth > 0
        ? options.map((species) => (
            <SpeciesTile
              key={species}
              species={species}
              selected={value === species}
              disabled={disabled}
              width={tileWidth}
              onPress={onChange}
            />
          ))
        : null}
    </View>
  );
}

/* -------------------------------------------------------------------- tile */

function SpeciesTile({ species, selected, disabled, width, onPress }: SpeciesTileProps) {
  const t = useTheme();
  const meta = SPECIES_META[species];
  const identity = t.speciesColor(species);

  // Derived rather than an effect: the spring is a pure function of `selected`,
  // so there is no frame where the two disagree.
  const progress = useDerivedValue(() => withSpring(selected ? 1 : 0, PICK_SPRING), [selected]);

  const restFill = t.color.surface;
  const restBorder = t.color.border;
  const reduce = t.reduceMotion;

  // The border *width* stays put: animating it re-runs layout every frame and
  // nudges the label a pixel. Only the colours and the lift move.
  const tileStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [restFill, identity.tint]),
    borderColor: interpolateColor(progress.value, [0, 1], [restBorder, identity.base]),
    transform: [{ scale: reduce ? 1 : 1 + progress.value * LIFT_SCALE }],
  }));

  const glyphStyle = useAnimatedStyle(() => ({
    transform: [{ scale: reduce ? 1 : interpolate(progress.value, [0, 1], [1, 1.12]) }],
  }));

  return (
    <Touchable
      accessibilityRole="radio"
      accessibilityLabel={meta.label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      haptic="select"
      onPress={() => onPress(species)}
      pressScale="large"
      style={{ width }}
    >
      <Animated.View
        style={[
          styles.tile,
          {
            paddingVertical: t.spacing.base,
            paddingHorizontal: t.spacing.sm,
            gap: t.spacing.xs,
            borderRadius: t.radius.xl,
            borderWidth: t.borderWidth.thin,
          },
          tileStyle,
        ]}
      >
        <Animated.View style={glyphStyle}>
          <Text variant="title1" maxFontSizeMultiplier={1.2}>
            {meta.emoji}
          </Text>
        </Animated.View>

        <Text
          variant="subheadStrong"
          color={selected ? 'text' : 'textSecondary'}
          numberOfLines={1}
          align="center"
        >
          {meta.label}
        </Text>

        {selected ? (
          <Animated.View
            entering={ZoomIn.springify().damping(spring.snappy.damping).stiffness(spring.snappy.stiffness)}
            exiting={ZoomOut.duration(t.motion.duration.fast)}
            pointerEvents="none"
            style={[
              styles.check,
              {
                top: t.spacing.xs,
                right: t.spacing.xs,
                width: t.spacing.lg,
                height: t.spacing.lg,
                borderRadius: t.radius.pill,
                backgroundColor: identity.base,
              },
            ]}
          >
            <Icon name="checkmark" size="xs" color={t.color.textInverse} />
          </Animated.View>
        ) : null}
      </Animated.View>
    </Touchable>
  );
}

/* ------------------------------------------------------------------ styles */

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  tile: { alignItems: 'center', justifyContent: 'center' },
  check: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
});

export default SpeciesPicker;
