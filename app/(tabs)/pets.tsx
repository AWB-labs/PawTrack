/**
 * Pets — the household, and the other households you help with.
 *
 * The screen exists to make Petal's central idea visible without explaining it:
 * the list is *split by role*, not sorted by it. "Your pets" and "Pets you look
 * after" are two sections with different counts, different accent colours and
 * different affordances, because owning Buddy and sitting for Mochi are two
 * genuinely different jobs the same person does on the same afternoon.
 *
 * Three decisions worth naming:
 *
 *   · **Role comes from the membership, not from `ownerId`.** The pet record's
 *     owner is a fact about the pet; the membership is a fact about *you*, and
 *     it's the one every permission check in the app reads. Deriving the split
 *     from anything else would let this screen and the profile disagree.
 *   · **Status chips are built once, from one query.** `useCareTasks()` returns
 *     today's whole stream across every pet, so six cards cost one round trip
 *     rather than six — see `buildPetStatuses()`.
 *   · **Search and species filters only appear once the list stops being
 *     scannable.** A filter bar above three cards is furniture.
 */

import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeInDown, LinearTransition } from 'react-native-reanimated';

import { useMyMemberships } from '@/data/queries/useCaregivers';
import { useCareTasks } from '@/data/queries/useCareTasks';
import { usePets } from '@/data/queries/usePets';
import { useUser } from '@/data/queries/useUsers';
import { SPECIES_META, type CareTask, type Pet } from '@/data/types';
import { PetCard, buildPetStatuses, type PetStatusChip } from '@/features/pets/PetCard';
import { toHref } from '@/lib/deeplinks';
import { joinWithAnd, possessive } from '@/lib/format';
import type { Membership, MembershipRole } from '@/rbac/permissions';
import { useCurrentUser } from '@/stores/session';
import { useTheme, type SpeciesKey } from '@/theme';
import {
  Chip,
  Column,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  Row,
  Screen,
  ScreenHeader,
  SearchField,
  SectionHeader,
  Text,
  Touchable,
} from '@/ui';
import { EmptyCaregivers, EmptyPets, EmptySearch } from '@/ui/illustrations';
import { SkeletonGroup } from '@/ui/Skeleton';
import { PetCardSkeleton } from '@/ui/skeletons/ContentSkeletons';

/* ---------------------------------------------------------------- constants */

/** Below this a filter row costs more attention than it saves. */
const FILTER_THRESHOLD = 4;

/** Past ~8 the cascade stops reading as choreography and starts as lag. */
const STAGGER_CAP = 8;

/** Names shown in the header line before it collapses to "and 2 more". */
const HEADER_NAMES = 3;

/* ------------------------------------------------------------------ helpers */

function matchesQuery(pet: Pet, needle: string): boolean {
  if (!needle) return true;
  return (
    pet.name.toLowerCase().includes(needle) ||
    (pet.breed ?? '').toLowerCase().includes(needle) ||
    SPECIES_META[pet.species].label.toLowerCase().includes(needle)
  );
}

/* ---------------------------------------------------------------- component */

export default function PetsScreen() {
  const t = useTheme();
  const router = useRouter();
  const user = useCurrentUser();

  const petsQuery = usePets();
  const membershipsQuery = useMyMemberships();
  const tasksQuery = useCareTasks();

  const [query, setQuery] = useState('');
  const [species, setSpecies] = useState<SpeciesKey | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const pets = useMemo(() => petsQuery.data ?? [], [petsQuery.data]);
  const tasks = useMemo<readonly CareTask[]>(() => tasksQuery.data ?? [], [tasksQuery.data]);

  const membershipByPet = useMemo(
    () => new Map((membershipsQuery.data ?? []).map((row) => [row.petId, row])),
    [membershipsQuery.data],
  );

  /**
   * The membership is the source of truth everywhere else in the app, so it
   * wins here too. `ownerId` is only the fallback for the frame between a pet
   * arriving and its membership landing.
   */
  const roleOf = useCallback(
    (pet: Pet): MembershipRole =>
      membershipByPet.get(pet.id)?.role ?? (pet.ownerId === user?.id ? 'owner' : 'caregiver'),
    [membershipByPet, user?.id],
  );

  const owned = useMemo(() => pets.filter((pet) => roleOf(pet) === 'owner'), [pets, roleOf]);
  const sitting = useMemo(() => pets.filter((pet) => roleOf(pet) === 'caregiver'), [pets, roleOf]);

  const speciesOptions = useMemo(() => {
    const seen: SpeciesKey[] = [];
    for (const pet of pets) if (!seen.includes(pet.species)) seen.push(pet.species);
    return seen;
  }, [pets]);

  const needle = query.trim().toLowerCase();
  const filtering = needle.length > 0 || species !== null;

  const keep = useCallback(
    (pet: Pet) => (species === null || pet.species === species) && matchesQuery(pet, needle),
    [needle, species],
  );

  const ownedShown = useMemo(() => owned.filter(keep), [keep, owned]);
  const sittingShown = useMemo(() => sitting.filter(keep), [keep, sitting]);

  const showTools = pets.length > FILTER_THRESHOLD;

  /* ---- copy ------------------------------------------------------------- */

  const subtitle = useMemo(() => {
    if (pets.length === 0) return 'Everyone under your roof, and everyone you help with.';
    const names = pets.slice(0, HEADER_NAMES).map((pet) => pet.name);
    const rest = pets.length - names.length;
    const list = joinWithAnd(rest > 0 ? [...names, `${rest} more`] : names);
    return sitting.length > 0
      ? `${list} — yours, plus the ones you’re helping with.`
      : `${list} — the whole household.`;
  }, [pets, sitting.length]);

  /* ---- actions ---------------------------------------------------------- */

  const addPet = useCallback(() => router.push(toHref('/pet/new')), [router]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([petsQuery.refetch(), membershipsQuery.refetch(), tasksQuery.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }, [membershipsQuery, petsQuery, tasksQuery]);

  const clearFilters = useCallback(() => {
    setQuery('');
    setSpecies(null);
  }, []);

  const enter = useCallback(
    (index: number) =>
      t.reduceMotion
        ? FadeIn.duration(t.motion.duration.base).delay(
            Math.min(index, STAGGER_CAP) * t.motion.stagger.tight,
          )
        : FadeInDown.duration(t.motion.duration.slow)
            .delay(Math.min(index, STAGGER_CAP) * t.motion.stagger.base)
            .easing(t.motion.easing.decelerate),
    [t.motion, t.reduceMotion],
  );

  /* ---- chrome ----------------------------------------------------------- */

  const header = (
    <ScreenHeader
      title="Pets"
      subtitle={subtitle}
      showBack={false}
      actions={
        <IconButton
          icon="add"
          accessibilityLabel="Add a pet"
          accessibilityHint="Starts the new pet flow."
          variant="tonal"
          tone="primary"
          onPress={addPet}
        />
      }
    />
  );

  /** Clearance for the floating tab bar. */
  const bottomInset = t.spacing.giant + t.spacing.md;

  /* ---- loading ---------------------------------------------------------- */

  if (petsQuery.isPending || membershipsQuery.isPending) {
    return (
      <Screen header={header} scroll bottomInset={bottomInset}>
        <SkeletonGroup label="Loading your pets" gap="xl">
          <PetCardSkeleton count={3} />
        </SkeletonGroup>
      </Screen>
    );
  }

  /* ---- error ------------------------------------------------------------ */

  if (petsQuery.isError) {
    return (
      <Screen header={header} center bottomInset={bottomInset}>
        <ErrorState
          error={petsQuery.error}
          title="We couldn’t reach your pets"
          body="Their records are safe — we just couldn’t fetch the list this time."
          onRetry={() => petsQuery.refetch()}
        />
      </Screen>
    );
  }

  /* ---- empty ------------------------------------------------------------ */

  if (pets.length === 0) {
    return (
      <Screen header={header} center bottomInset={bottomInset}>
        <EmptyState
          illustration={<EmptyPets size={t.spacing.colossal * 3} />}
          headline="Let’s meet your first pet"
          body="Add them once and Furry Tracker keeps the meals, the medicine and the vet paperwork in one place — and lets you share it with a sitter when you need to."
          action={{
            label: 'Add a pet',
            icon: 'add',
            onPress: addPet,
            accessibilityHint: 'Opens the new pet flow.',
          }}
        />
      </Screen>
    );
  }

  /* ---- content ---------------------------------------------------------- */

  const nothingMatches = filtering && ownedShown.length === 0 && sittingShown.length === 0;

  return (
    <Screen
      header={header}
      scroll
      bottomInset={bottomInset}
      refreshing={refreshing}
      onRefresh={() => {
        void refresh();
      }}
      contentContainerStyle={{ gap: t.spacing.lg, paddingBottom: t.spacing.xl }}
    >
      {showTools ? (
        <Animated.View entering={enter(0)} style={{ gap: t.spacing.md }}>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder="Search by name or breed"
            accessibilityLabel="Search your pets"
            onCancel={clearFilters}
          />

          {speciesOptions.length > 1 ? (
            <Row
              gap="xs"
              wrap
              accessibilityRole="radiogroup"
              accessibilityLabel="Filter by kind of pet"
            >
              <Chip
                label="All"
                selected={species === null}
                onPress={() => setSpecies(null)}
                size="sm"
                accessibilityHint="Shows every pet."
              />
              {speciesOptions.map((key) => (
                <Chip
                  key={key}
                  label={SPECIES_META[key].label}
                  emoji={SPECIES_META[key].emoji}
                  selected={species === key}
                  onPress={() => setSpecies(species === key ? null : key)}
                  size="sm"
                />
              ))}
            </Row>
          ) : null}
        </Animated.View>
      ) : null}

      {nothingMatches ? (
        <Animated.View entering={enter(1)} layout={LinearTransition.duration(t.motion.duration.base)}>
          <EmptyState
            variant="compact"
            frame
            illustration={<EmptySearch size={t.spacing.colossal * 2} />}
            headline="Nobody by that name"
            body={
              needle
                ? `No pet here matches “${query.trim()}”. Try a shorter word, or clear the filters.`
                : 'No pets of that kind yet. Clear the filter to see everyone.'
            }
            action={{ label: 'Clear filters', icon: 'close-circle-outline', onPress: clearFilters }}
          />
        </Animated.View>
      ) : (
        <>
          <Animated.View entering={enter(1)} style={{ gap: t.spacing.md }}>
            <SectionHeader
              title="Your pets"
              subtitle="Yours to look after, and yours to share when you need a hand."
              count={owned.length > 0 ? owned.length : undefined}
              icon="shield-checkmark-outline"
              iconColor="primaryText"
              first
            />

            {owned.length === 0 ? (
              <EmptyState
                variant="compact"
                frame
                illustration={<EmptyPets size={t.spacing.colossal * 2} />}
                headline="None of your own yet"
                body="You’re helping with someone else’s pet — lovely. When you get one of your own, this is where they’ll live."
                action={{ label: 'Add a pet', icon: 'add', onPress: addPet }}
              />
            ) : ownedShown.length === 0 ? (
              <Text variant="footnote" color="textTertiary">
                None of your own pets match that.
              </Text>
            ) : (
              <Column gap="md">
                {ownedShown.map((pet, index) => (
                  <PetCard
                    key={pet.id}
                    pet={pet}
                    index={index}
                    statuses={buildPetStatuses({ pet, tasks })}
                    membership={membershipByPet.get(pet.id)}
                  />
                ))}
              </Column>
            )}

            {owned.length > 0 && !filtering ? (
              <AddPetTile
                label="Add another pet"
                hint="Two minutes, and their whole routine lives here."
                onPress={addPet}
              />
            ) : null}
          </Animated.View>

          <Animated.View entering={enter(2)} style={{ gap: t.spacing.md }}>
            <SectionHeader
              title="Pets you look after"
              subtitle="Someone else’s pet, and exactly what they trusted you with."
              count={sitting.length > 0 ? sitting.length : undefined}
              countTone="accent"
              icon="home-outline"
              iconColor="accentText"
            />

            {sitting.length === 0 ? (
              <EmptyState
                variant="compact"
                frame
                tone="accent"
                illustration={<EmptyCaregivers size={t.spacing.colossal * 2} />}
                headline="Nobody’s asked you to sit yet"
                body="When a friend shares a pet with you, they land here — with their meals, their medicine, and a plain note about what you’re allowed to do."
              />
            ) : sittingShown.length === 0 ? (
              <Text variant="footnote" color="textTertiary">
                None of the pets you sit for match that.
              </Text>
            ) : (
              <Column gap="md">
                {sittingShown.map((pet, index) => (
                  <SitterPetCard
                    key={pet.id}
                    pet={pet}
                    membership={membershipByPet.get(pet.id)}
                    tasks={tasks}
                    index={index}
                  />
                ))}
              </Column>
            )}
          </Animated.View>
        </>
      )}
    </Screen>
  );
}

/* --------------------------------------------------------------- add tile */

type AddPetTileProps = {
  label: string;
  hint: string;
  onPress: () => void;
};

/**
 * A dashed slot rather than a button: it reads as a gap in the list waiting to
 * be filled, which is a quieter invitation than a second primary CTA under a
 * screen that already has one in the header.
 */
function AddPetTile({ label, hint, onPress }: AddPetTileProps) {
  const t = useTheme();
  const well = t.spacing.huge;

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Opens the new pet flow."
      haptic="tap"
      onPress={onPress}
      pressScale="large"
      style={{
        padding: t.spacing.base,
        borderRadius: t.radius.xxl,
        borderWidth: t.borderWidth.thin,
        borderColor: t.color.border,
        borderStyle: 'dashed',
        backgroundColor: t.color.surfaceAlt,
      }}
    >
      <Row gap="md">
        <View
          style={{
            width: well,
            height: well,
            borderRadius: t.radius.pill,
            backgroundColor: t.color.primarySoft,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="add" size="lg" color="onPrimarySoft" />
        </View>
        <Column flex gap="hair">
          <Text variant="headline">{label}</Text>
          <Text variant="footnote" color="textTertiary">
            {hint}
          </Text>
        </Column>
      </Row>
    </Touchable>
  );
}

/* ------------------------------------------------------------ sitter card */

type SitterPetCardProps = {
  pet: Pet;
  /** Undefined lets `PetCard` fall back to the session's own membership. */
  membership: Membership | undefined;
  tasks: readonly CareTask[];
  index: number;
};

/**
 * The same card, with one extra fact that only matters on this half of the
 * screen: whose pet it is. Resolving the owner in a child component means one
 * lookup per row rather than a hook inside a loop.
 */
function SitterPetCard({ pet, membership, tasks, index }: SitterPetCardProps) {
  const owner = useUser(pet.ownerId);
  const ownerName = owner.data?.displayName ?? null;

  const statuses = useMemo<PetStatusChip[]>(() => {
    const derived = buildPetStatuses({ pet, tasks, max: 2 });
    if (!ownerName) return derived;
    return [
      {
        id: 'owner',
        label: `${possessive(ownerName)} ${SPECIES_META[pet.species].label.toLowerCase()}`,
        icon: 'person-outline',
        tone: 'neutral',
      },
      ...derived,
    ];
  }, [ownerName, pet, tasks]);

  return (
    <PetCard
      pet={pet}
      index={index}
      statuses={statuses}
      membership={membership}
      live={membership?.status === 'active'}
    />
  );
}
