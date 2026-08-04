/**
 * Petal — BreedField.
 *
 * Breed is free text with a memory. A closed `Select` would be wrong — there is
 * no complete list of dog breeds, and "Cockapoo", "Collie cross" and "Rescue,
 * best guess lurcher" are all real answers people need to type. So this is an
 * input that *suggests*, never constrains:
 *
 *   · **Prefix matches rank above contains matches.** Typing "lab" should offer
 *     Labrador before Black Russian Terrier, however alphabetical the source.
 *   · **The free-text answer is offered back explicitly.** "Use 'Collie cross'"
 *     sits at the end of the list, so nobody wonders whether an unmatched breed
 *     will be thrown away when they tap Continue.
 *   · **The list is per species.** Offering "Ragdoll" to a budgie owner is the
 *     kind of small wrongness that makes an app feel machine-made.
 *
 * The panel grows and shrinks with a layout transition rather than snapping, so
 * the Continue button below it never jumps under a thumb.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, LinearTransition } from 'react-native-reanimated';

import { SPECIES_META } from '@/data/types';
import haptics from '@/lib/haptics';
import { useTheme, type SpeciesKey } from '@/theme';
import { Icon, Input, Surface, Text, Touchable, type InputHandle } from '@/ui';

/* -------------------------------------------------------------------- types */

export type BreedFieldProps = {
  /** Chooses the suggestion list. */
  species: SpeciesKey;
  value: string;
  onChange: (breed: string) => void;
  label?: string;
  placeholder?: string;
  helper?: string;
  error?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  /** Rows offered at once. Beyond ~6 the panel stops being scannable. */
  maxSuggestions?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* --------------------------------------------------------------- breed data */

/**
 * Common breeds per species — the ones a UK/US owner is most likely to type,
 * not an exhaustive registry. Anything missing is still perfectly typeable;
 * this list exists to save keystrokes, not to define what counts as a pet.
 */
export const BREEDS: Record<SpeciesKey, readonly string[]> = {
  dog: [
    'Labrador Retriever',
    'Golden Retriever',
    'French Bulldog',
    'Cockapoo',
    'Cocker Spaniel',
    'Springer Spaniel',
    'Border Collie',
    'German Shepherd',
    'Staffordshire Bull Terrier',
    'Jack Russell Terrier',
    'Dachshund',
    'Miniature Schnauzer',
    'Shih Tzu',
    'Pug',
    'Beagle',
    'Boxer',
    'Whippet',
    'Greyhound',
    'Lurcher',
    'Cavalier King Charles Spaniel',
    'Chihuahua',
    'Yorkshire Terrier',
    'Bichon Frise',
    'Poodle',
    'Labradoodle',
    'Goldendoodle',
    'Rottweiler',
    'Husky',
    'Shiba Inu',
    'Australian Shepherd',
    'Bernese Mountain Dog',
    'Great Dane',
    'Dalmatian',
    'Basset Hound',
    'Pomeranian',
    'Corgi',
    'Weimaraner',
    'Vizsla',
    'Border Terrier',
    'West Highland White Terrier',
    'Mixed breed',
  ],
  cat: [
    'Domestic Shorthair',
    'Domestic Longhair',
    'British Shorthair',
    'British Longhair',
    'Ragdoll',
    'Maine Coon',
    'Bengal',
    'Siamese',
    'Persian',
    'Sphynx',
    'Russian Blue',
    'Norwegian Forest Cat',
    'Scottish Fold',
    'Burmese',
    'Birman',
    'Abyssinian',
    'Devon Rex',
    'Cornish Rex',
    'Oriental Shorthair',
    'Tonkinese',
    'Ragamuffin',
    'Turkish Van',
    'Manx',
    'Savannah',
    'Tabby (moggy)',
    'Tuxedo (moggy)',
    'Mixed breed',
  ],
  bird: [
    'Budgerigar',
    'Cockatiel',
    'Lovebird',
    'Canary',
    'Zebra Finch',
    'African Grey Parrot',
    'Amazon Parrot',
    'Cockatoo',
    'Conure',
    'Macaw',
    'Quaker Parrot',
    'Senegal Parrot',
    'Parrotlet',
    'Java Sparrow',
    'Diamond Dove',
    'Ringneck Parakeet',
  ],
  rabbit: [
    'Netherland Dwarf',
    'Mini Lop',
    'Holland Lop',
    'French Lop',
    'Lionhead',
    'Rex',
    'Mini Rex',
    'Dutch',
    'English Lop',
    'Flemish Giant',
    'Continental Giant',
    'Himalayan',
    'New Zealand',
    'Angora',
    'Harlequin',
    'Mixed breed',
  ],
  reptile: [
    'Bearded Dragon',
    'Leopard Gecko',
    'Crested Gecko',
    'Corn Snake',
    'Ball Python',
    'Royal Python',
    'Blue-Tongued Skink',
    'Hermann’s Tortoise',
    'Russian Tortoise',
    'Red-Eared Slider',
    'Green Iguana',
    'Chameleon',
  ],
  fish: [
    'Betta',
    'Goldfish',
    'Guppy',
    'Neon Tetra',
    'Corydoras',
    'Angelfish',
    'Molly',
    'Platy',
    'Discus',
    'Oscar',
    'Koi',
    'Clownfish',
  ],
  smallPet: [
    'Syrian Hamster',
    'Dwarf Hamster',
    'Guinea Pig',
    'Fancy Rat',
    'Gerbil',
    'Chinchilla',
    'Ferret',
    'Degu',
    'African Pygmy Hedgehog',
    'Mouse',
  ],
  other: [],
};

/* ---------------------------------------------------------------- constants */

const DEFAULT_MAX = 6;

/** Rows past this stop staggering — the cascade would read as lag. */
const STAGGER_CAP = 6;

/* ------------------------------------------------------------------ helpers */

/** Prefix hits first, then contained hits, each keeping its source order. */
function rankBreeds(pool: readonly string[], query: string, limit: number): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return pool.slice(0, limit);

  const starts: string[] = [];
  const contains: string[] = [];
  for (const breed of pool) {
    const haystack = breed.toLowerCase();
    if (haystack.startsWith(needle)) starts.push(breed);
    else if (haystack.includes(needle)) contains.push(breed);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}

/* ---------------------------------------------------------------- component */

export function BreedField({
  species,
  value,
  onChange,
  label = 'Breed',
  placeholder,
  helper,
  error,
  autoFocus = false,
  disabled = false,
  disabledReason,
  maxSuggestions = DEFAULT_MAX,
  style,
  testID,
}: BreedFieldProps) {
  const t = useTheme();
  const inputRef = useRef<InputHandle>(null);
  const [open, setOpen] = useState(false);

  const meta = SPECIES_META[species];
  const pool = BREEDS[species];

  const suggestions = useMemo(
    () => rankBreeds(pool, value, maxSuggestions),
    [maxSuggestions, pool, value],
  );

  const trimmed = value.trim();
  const exact = suggestions.some((breed) => breed.toLowerCase() === trimmed.toLowerCase());
  const offerFreeText = trimmed.length > 0 && !exact;

  const pick = useCallback(
    (breed: string) => {
      haptics.select();
      onChange(breed);
      setOpen(false);
      inputRef.current?.blur();
    },
    [onChange],
  );

  const showPanel = open && !disabled && (suggestions.length > 0 || offerFreeText);
  const heading = trimmed.length > 0 ? 'Closest matches' : `Common for a ${meta.label.toLowerCase()}`;

  return (
    <Animated.View
      layout={LinearTransition.duration(t.motion.duration.base)}
      style={style}
      testID={testID}
    >
      <Input
        ref={inputRef}
        label={label}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder ?? `e.g. ${pool[0] ?? 'Mixed breed'}`}
        helper={helper}
        error={error}
        leadingIcon="paw-outline"
        clearable
        autoFocus={autoFocus}
        autoCapitalize="words"
        autoCorrect={false}
        returnKeyType="done"
        disabled={disabled}
        disabledReason={disabledReason}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onSubmitEditing={() => setOpen(false)}
        accessibilityHint="Type any breed, or pick one of the suggestions below"
      />

      {showPanel ? (
        <Animated.View
          entering={
            t.reduceMotion
              ? FadeIn.duration(t.motion.duration.fast)
              : FadeInDown.duration(t.motion.duration.base).easing(t.motion.easing.decelerate)
          }
          exiting={FadeOut.duration(t.motion.duration.fast)}
          layout={LinearTransition.duration(t.motion.duration.base)}
        >
          <Surface
            variant="surfaceAlt"
            radius="lg"
            padding="xs"
            border
            style={{ marginTop: t.spacing.xs, gap: t.spacing.hair }}
          >
            <Text
              variant="overline"
              color="textTertiary"
              style={{ paddingHorizontal: t.spacing.sm, paddingTop: t.spacing.xs }}
            >
              {heading}
            </Text>

            {suggestions.map((breed, index) => (
              <SuggestionRow
                key={breed}
                label={breed}
                index={index}
                selected={breed.toLowerCase() === trimmed.toLowerCase()}
                onPress={() => pick(breed)}
              />
            ))}

            {offerFreeText ? (
              <SuggestionRow
                key="free-text"
                label={`Use “${trimmed}”`}
                index={suggestions.length}
                icon="create-outline"
                onPress={() => pick(trimmed)}
              />
            ) : null}
          </Surface>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

/* -------------------------------------------------------------------- row */

function SuggestionRow({
  label,
  index,
  selected = false,
  icon = 'paw-outline',
  onPress,
}: {
  label: string;
  index: number;
  selected?: boolean;
  icon?: 'paw-outline' | 'create-outline';
  onPress: () => void;
}) {
  const t = useTheme();

  return (
    <Animated.View
      entering={
        t.reduceMotion
          ? FadeIn.duration(t.motion.duration.fast).delay(
              Math.min(index, STAGGER_CAP) * t.motion.stagger.tight,
            )
          : FadeInDown.duration(t.motion.duration.base).delay(
              Math.min(index, STAGGER_CAP) * t.motion.stagger.tight,
            )
      }
    >
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected }}
        haptic="none"
        onPress={onPress}
        pressScale="large"
        style={[
          styles.row,
          {
            gap: t.spacing.sm,
            paddingVertical: t.spacing.sm,
            paddingHorizontal: t.spacing.sm,
            borderRadius: t.radius.md,
            backgroundColor: selected ? t.color.primarySoft : 'transparent',
          },
        ]}
      >
        <Icon name={icon} size="sm" color={selected ? 'onPrimarySoft' : 'textTertiary'} />
        <View style={styles.grow}>
          <Text
            variant="callout"
            color={selected ? 'onPrimarySoft' : 'text'}
            numberOfLines={1}
          >
            {label}
          </Text>
        </View>
        {selected ? <Icon name="checkmark" size="sm" color="onPrimarySoft" /> : null}
      </Touchable>
    </Animated.View>
  );
}

/* ------------------------------------------------------------------ styles */

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  grow: { flex: 1 },
});

export default BreedField;
