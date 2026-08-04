/**
 * Petal — PetCard.
 *
 * The most-repeated object in the app: it is the Pets tab, the Today carousel,
 * the pet switcher's expanded form and the "who is this for" row in every
 * composer. Four decisions keep it honest at that volume:
 *
 *   · **Identity before words.** The species colour rings the portrait *and*
 *     stripes the card's leading edge, so a household of three is separable in
 *     peripheral vision before a single name is read.
 *   · **Status is passed in, never fetched.** A card that runs its own queries
 *     turns a list of six pets into a dozen round trips and, worse, asks for
 *     capabilities a sitter may not hold. `buildPetStatuses()` turns data the
 *     *screen* already has into chips, so one `useCareTasks()` feeds every card.
 *   · **The role badge is the dual-role model made visible.** A card for a pet
 *     you merely sit for says so, with the sitting window attached — that is the
 *     difference between "your pets" and "pets in your app".
 *   · **`compact` is a different composition, not a smaller one.** The
 *     horizontal carousel stacks portrait over name and shows a single status;
 *     shrinking the full layout would produce four unreadable chips.
 */

import { useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { SPECIES_META, type CareTask, type Pet, type Vaccination } from '@/data/types';
import { dueLabel, describeAge, formatClock } from '@/lib/date';
import { joinWithAnd, pluralWord, possessive } from '@/lib/format';
import type { Membership } from '@/rbac/permissions';
import { RoleBadge } from '@/rbac/RoleBadge';
import { useMembership } from '@/rbac/usePermission';
import { useTheme, type Theme } from '@/theme';
import {
  Avatar,
  AvatarStack,
  Card,
  Column,
  Icon,
  Row,
  Text,
  type AvatarStackItem,
  type IconName,
} from '@/ui';

/* -------------------------------------------------------------------- types */

export type PetStatusTone =
  | 'neutral'
  | 'primary'
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info';

/** One at-a-glance fact. Built by `buildPetStatuses`, or hand-rolled by a screen. */
export type PetStatusChip = {
  id: string;
  label: string;
  icon: IconName;
  tone: PetStatusTone;
};

export type PetCardVariant = 'full' | 'compact';

export type PetCardProps = {
  pet: Pet;
  variant?: PetCardVariant;
  /** At-a-glance chips. See `buildPetStatuses()`. */
  statuses?: readonly PetStatusChip[];
  /** Everyone who can look after this pet. Omit to hide the stack entirely. */
  caregivers?: readonly AvatarStackItem[];
  /**
   * The viewer's membership on this pet. Defaults to the session's own, so the
   * role badge is correct without the caller assembling it.
   */
  membership?: Membership | null;
  /** Someone is on duty right now — pulses the portrait's ring. */
  live?: boolean;
  /** Position in its list; drives the entrance stagger. */
  index?: number;
  animate?: boolean;
  /** Defaults to opening the pet's profile. */
  onPress?: () => void;
  onLongPress?: () => void;
  /** Width of a `compact` card. Ignored by `full`, which fills its column. */
  width?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export type PetStatusPillProps = {
  chip: PetStatusChip;
  size?: 'sm' | 'md';
};

export type BuildPetStatusesInput = {
  pet: Pet;
  /** Today's care stream. Tasks for other pets are ignored, so pass the lot. */
  tasks?: readonly CareTask[];
  /** Only screens that already hold them — the card never fetches. */
  vaccinations?: readonly Vaccination[];
  now?: Date;
  /** Chips beyond this are dropped, most urgent first. Defaults to 3. */
  max?: number;
};

/* ---------------------------------------------------------------- constants */

/** Past ~8 the cascade stops reading as choreography and starts as lag. */
const STAGGER_CAP = 8;

/** A vaccination inside this window is worth a chip; beyond it, it is noise. */
const VACCINATION_HORIZON_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ helpers */

function statusSkin(t: Theme, tone: PetStatusTone): { fill: string; ink: string } {
  switch (tone) {
    case 'primary':
      return { fill: t.color.primarySoft, ink: t.color.onPrimarySoft };
    case 'accent':
      return { fill: t.color.accentSoft, ink: t.color.onAccentSoft };
    case 'success':
      return { fill: t.color.successSoft, ink: t.color.onSuccessSoft };
    case 'warning':
      return { fill: t.color.warningSoft, ink: t.color.onWarningSoft };
    case 'danger':
      return { fill: t.color.dangerSoft, ink: t.color.onDangerSoft };
    case 'info':
      return { fill: t.color.infoSoft, ink: t.color.onInfoSoft };
    case 'neutral':
    default:
      return { fill: t.color.surfaceAlt, ink: t.color.textSecondary };
  }
}

/** "Golden Retriever · 4 years", degrading to whatever is actually known. */
export function describePet(pet: Pet, now: Date = new Date()): string {
  const age = describeAge(pet, now);
  const kind = pet.breed?.trim() || SPECIES_META[pet.species].label;
  return age ? `${kind} · ${age}` : kind;
}

/**
 * Turn what a screen already has into the card's chips, urgent first.
 *
 * Everything is derived — nothing is fetched — so a list of six cards costs the
 * single `useCareTasks()` the screen was going to run anyway.
 */
export function buildPetStatuses({
  pet,
  tasks = [],
  vaccinations = [],
  now = new Date(),
  max = 3,
}: BuildPetStatusesInput): PetStatusChip[] {
  const chips: PetStatusChip[] = [];
  const mine = tasks.filter((task) => task.petId === pet.id);

  const overdue = mine.filter((task) => task.state === 'overdue');
  if (overdue.length > 0) {
    chips.push({
      id: 'overdue',
      label: `${overdue.length} ${pluralWord(overdue.length, 'thing')} overdue`,
      icon: 'alert-circle',
      tone: 'danger',
    });
  }

  const overdueVaccination = vaccinations.find(
    (row) => row.dueAt !== null && Date.parse(row.dueAt) < now.getTime(),
  );
  if (overdueVaccination) {
    chips.push({
      id: 'vaccination-overdue',
      label: `${overdueVaccination.name} ${dueLabel(overdueVaccination.dueAt ?? '', now)}`,
      icon: 'shield-half-outline',
      tone: 'danger',
    });
  }

  const dueDoses = mine.filter((task) => task.kind === 'medicine' && task.state === 'due');
  if (dueDoses.length > 0) {
    chips.push({
      id: 'doses-due',
      label: `${dueDoses.length} ${pluralWord(dueDoses.length, 'dose')} due`,
      icon: 'medical',
      tone: 'warning',
    });
  }

  const meals = mine
    .filter((task) => task.kind === 'feeding' && (task.state === 'due' || task.state === 'upcoming'))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const nextMeal = meals[0];
  if (nextMeal) {
    chips.push(
      nextMeal.state === 'due'
        ? { id: 'meal', label: 'Mealtime now', icon: 'restaurant', tone: 'accent' }
        : {
            id: 'meal',
            label: `Next meal ${formatClock(nextMeal.at)}`,
            icon: 'restaurant-outline',
            tone: 'neutral',
          },
    );
  }

  const appointment = mine
    .filter((task) => task.kind === 'appointment' && task.state !== 'done')
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
  if (appointment) {
    chips.push({
      id: 'appointment',
      label: `Vet at ${formatClock(appointment.at)}`,
      icon: 'medkit-outline',
      tone: 'info',
    });
  }

  if (!overdueVaccination) {
    const soon = vaccinations
      .filter((row) => {
        if (!row.dueAt) return false;
        const delta = Date.parse(row.dueAt) - now.getTime();
        return delta >= 0 && delta <= VACCINATION_HORIZON_DAYS * DAY_MS;
      })
      .sort((a, b) => Date.parse(a.dueAt ?? '') - Date.parse(b.dueAt ?? ''))[0];
    if (soon) {
      chips.push({
        id: 'vaccination-soon',
        label: `${soon.name} ${dueLabel(soon.dueAt ?? '', now)}`,
        icon: 'shield-checkmark-outline',
        tone: 'warning',
      });
    }
  }

  // A day with nothing left is worth saying out loud — an empty chip row reads
  // as missing data rather than as a job finished.
  if (chips.length === 0 && mine.length > 0) {
    chips.push({ id: 'clear', label: 'All done today', icon: 'checkmark-circle', tone: 'success' });
  }

  if (pet.allergies.length > 0) {
    chips.push({
      id: 'allergies',
      label: `No ${joinWithAnd(pet.allergies).toLowerCase()}`,
      icon: 'warning-outline',
      tone: 'warning',
    });
  }

  return chips.slice(0, Math.max(1, max));
}

/* --------------------------------------------------------------- status pill */

/** Non-interactive status token. `Chip` is a *choice*; this is a *fact*. */
export function PetStatusPill({ chip, size = 'md' }: PetStatusPillProps) {
  const t = useTheme();
  const skin = statusSkin(t, chip.tone);
  const dense = size === 'sm';

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={chip.label}
      style={[
        styles.pill,
        {
          gap: t.spacing.xxs,
          paddingVertical: dense ? t.spacing.hair : t.spacing.xxs,
          paddingHorizontal: dense ? t.spacing.xs : t.spacing.sm,
          borderRadius: t.radius.pill,
          backgroundColor: skin.fill,
        },
      ]}
    >
      <Icon name={chip.icon} size="xs" color={skin.ink} />
      <Text
        variant={dense ? 'caption' : 'captionStrong'}
        color={skin.ink}
        numberOfLines={1}
        style={styles.shrink}
      >
        {chip.label}
      </Text>
    </View>
  );
}

/* ---------------------------------------------------------------- component */

export function PetCard({
  pet,
  variant = 'full',
  statuses,
  caregivers,
  membership,
  live = false,
  index = 0,
  animate = true,
  onPress,
  onLongPress,
  width,
  style,
  testID,
}: PetCardProps) {
  const t = useTheme();
  const router = useRouter();
  const sessionMembership = useMembership(pet.id);

  const scope = membership === undefined ? sessionMembership : membership;
  const isSitter = scope?.role === 'caregiver';
  const identity = t.speciesColor(pet.species);
  const chips = statuses ?? [];

  const subtitle = useMemo(() => describePet(pet), [pet]);

  const open = () => {
    if (onPress) {
      onPress();
      return;
    }
    router.push({ pathname: '/pet/[petId]', params: { petId: pet.id } });
  };

  const spoken = useMemo(() => {
    const parts = [pet.name, subtitle];
    if (isSitter) parts.push('You are sitting this pet');
    for (const chip of chips) parts.push(chip.label);
    return parts.join('. ');
  }, [chips, isSitter, pet.name, subtitle]);

  const entering = animate
    ? t.reduceMotion
      ? FadeIn.duration(t.motion.duration.base).delay(
          Math.min(index, STAGGER_CAP) * t.motion.stagger.base,
        )
      : FadeInDown.duration(t.motion.duration.slow)
          .delay(Math.min(index, STAGGER_CAP) * t.motion.stagger.base)
          .easing(t.motion.easing.decelerate)
    : undefined;

  /* ---- compact ---------------------------------------------------------- */

  if (variant === 'compact') {
    const compactWidth = width ?? t.spacing.colossal + t.spacing.giant;

    return (
      <Animated.View entering={entering} style={style}>
        <Card
          onPress={open}
          onLongPress={onLongPress}
          accessibilityLabel={spoken}
          accessibilityHint={`Opens ${possessive(pet.name)} profile`}
          padding="md"
          gap="sm"
          radius="xxl"
          elevation={1}
          pressScale="large"
          testID={testID}
          style={{ width: compactWidth }}
        >
          <Column align="center" gap="xs">
            <Avatar
              uri={pet.photoUrl}
              name={pet.name}
              species={pet.species}
              size="xl"
              ring
              live={live}
            />
            <Column align="center" gap="hair">
              <Text variant="title3" numberOfLines={1} align="center">
                {pet.name}
              </Text>
              <Text variant="caption" color="textTertiary" numberOfLines={1} align="center">
                {subtitle}
              </Text>
            </Column>
          </Column>

          {chips[0] ? (
            <View style={styles.center}>
              <PetStatusPill chip={chips[0]} size="sm" />
            </View>
          ) : null}

          {isSitter && scope ? (
            <View style={styles.center}>
              <RoleBadge role="caregiver" size="sm" membership={scope} showWindow={false} />
            </View>
          ) : null}
        </Card>
      </Animated.View>
    );
  }

  /* ---- full ------------------------------------------------------------- */

  return (
    <Animated.View entering={entering} style={style}>
      <Card
        onPress={open}
        onLongPress={onLongPress}
        accessibilityLabel={spoken}
        accessibilityHint={`Opens ${possessive(pet.name)} profile`}
        accent={identity.base}
        padding="base"
        gap="md"
        radius="xxl"
        elevation={1}
        pressScale="large"
        testID={testID}
      >
        <Row gap="md" align="center">
          <Avatar
            uri={pet.photoUrl}
            name={pet.name}
            species={pet.species}
            size="lg"
            ring
            live={live}
          />

          <Column flex gap="hair">
            <Text variant="title1" numberOfLines={1}>
              {pet.name}
            </Text>
            <Text variant="footnote" color="textSecondary" numberOfLines={1}>
              {subtitle}
            </Text>
          </Column>

          <Icon name="chevron-forward" size="sm" color="textTertiary" />
        </Row>

        {isSitter && scope ? <RoleBadge role="caregiver" size="sm" membership={scope} /> : null}

        {chips.length > 0 ? (
          <Row gap="xs" wrap>
            {chips.map((chip) => (
              <PetStatusPill key={chip.id} chip={chip} />
            ))}
          </Row>
        ) : null}

        {caregivers && caregivers.length > 0 ? (
          <Row gap="sm">
            <AvatarStack
              items={[...caregivers]}
              size="xs"
              max={4}
              animate={false}
              label={`${possessive(pet.name)} people`}
            />
            <Text variant="caption" color="textTertiary" numberOfLines={1} style={styles.shrink}>
              {caregivers.length === 1
                ? 'Just you, for now'
                : `${caregivers.length} people can help`}
            </Text>
          </Row>
        ) : null}
      </Card>
    </Animated.View>
  );
}

/* ------------------------------------------------------------------ styles */

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', maxWidth: '100%' },
  shrink: { flexShrink: 1 },
  center: { alignItems: 'center' },
});

export default PetCard;
